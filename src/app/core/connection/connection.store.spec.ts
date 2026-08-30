import { AccountInfo, CallerIdentity, DetectedConfig, PermissionAudit } from '../models/aws';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import { IpcCommand, IpcCommandMap } from '../models/ipc-contracts';
import { ConnectionStore } from './connection.store';

type Handler<K extends IpcCommand> = (
  args: IpcCommandMap[K]['args'],
) => IpcCommandMap[K]['result'] | Promise<IpcCommandMap[K]['result']>;
type Handlers = { [K in IpcCommand]?: Handler<K> };

class FakeIpc {
  readonly calls: string[] = [];
  constructor(private readonly handlers: Handlers) {}
  async call(command: IpcCommand, args?: unknown): Promise<unknown> {
    this.calls.push(command);
    const handler = this.handlers[command] as ((a: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`FakeIpc: no handler for "${command}"`);
    return await handler(args);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const identity: CallerIdentity = {
  accountId: '123456789012',
  userId: 'AIDAEXAMPLE',
  arn: 'arn:aws:iam::123456789012:user/costtracer',
};
const account: AccountInfo = {
  accountId: '123456789012',
  arn: identity.arn,
  userId: identity.userId,
  regions: ['us-east-1'],
  regionsDiscovered: true,
  sourceKind: 'manual',
};
const emptyDetected: DetectedConfig = {
  hasEnvCredentials: false,
  hasSharedCredentialsFile: false,
  hasConfigFile: false,
  profiles: [],
  defaultRegion: null,
};
const cleanAudit: PermissionAudit = { method: 'simulate', excessive: false, findings: [] };
const dirtyAudit: PermissionAudit = {
  method: 'list-policies',
  excessive: true,
  findings: [{ kind: 'broad-managed-policy', label: 'AdministratorAccess', detail: 'attached' }],
};
const manualInput = { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: null, region: null };

function makeStore(handlers: Handlers): { store: ConnectionStore; ipc: FakeIpc } {
  const ipc = new FakeIpc(handlers);
  return { store: new ConnectionStore(ipc as unknown as TauriIpcService), ipc };
}

/** Advance a fresh store to the `manualEntry` step, then clear the recorded call log. */
async function atManualEntry(handlers: Handlers): Promise<{ store: ConnectionStore; ipc: FakeIpc }> {
  const { store, ipc } = makeStore({
    session_resume: () => ({ status: 'none' }),
    detect_local_config: () => emptyDetected,
    session_discard: () => undefined,
    ...handlers,
  });
  await store.boot();
  store.chooseManual();
  expect(store.state().step).toBe('manualEntry');
  ipc.calls.length = 0;
  return { store, ipc };
}

describe('ConnectionStore', () => {
  it('skips onboarding when a saved session still resolves', async () => {
    const { store } = makeStore({ session_resume: () => ({ status: 'ok', account }) });
    await store.boot();
    expect(store.state()).toEqual({ step: 'connected', account });
  });

  it('runs local detection when there is no saved session', async () => {
    const { store } = makeStore({
      session_resume: () => ({ status: 'none' }),
      detect_local_config: () => ({ ...emptyDetected, hasConfigFile: true, profiles: ['default'] }),
    });
    await store.boot();
    const s = store.state();
    expect(s.step).toBe('methodSelect');
    expect(s.step === 'methodSelect' && s.detected?.hasConfigFile).toBe(true);
  });

  it('carries a notice into methodSelect after a stale session', async () => {
    const { store } = makeStore({
      session_resume: () => ({ status: 'stale' }),
      detect_local_config: () => emptyDetected,
    });
    await store.boot();
    const s = store.state();
    expect(s.step === 'methodSelect' && s.detected).toBeNull();
    expect(s.step === 'methodSelect' && s.notice).toBe('notice.staleSession');
  });

  it('drives a valid manual credential through the audit to the connected screen', async () => {
    const { store, ipc } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'ok', identity }),
      permissions_check: () => cleanAudit,
      connection_finalize: () => account,
    });
    await store.submitManual(manualInput);
    expect(store.state()).toEqual({ step: 'connected', account });
    expect(ipc.calls).toEqual(['credential_submit_manual', 'permissions_check', 'connection_finalize']);
  });

  it('stops on validationFailed with a distinct kind for an invalid credential', async () => {
    const { store } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'invalid', message: 'The security token is invalid.' }),
    });
    await store.submitManual(manualInput);
    expect(store.state()).toEqual({
      step: 'validationFailed',
      sourceKind: 'manual',
      kind: 'invalid-or-expired',
      message: 'The security token is invalid.',
    });
  });

  it('stops on validationFailed with the insufficient-permission kind', async () => {
    const { store } = await atManualEntry({
      credential_submit_manual: () => ({
        status: 'insufficient',
        message: 'ec2:DescribeVolumes was denied for this identity.',
        probedAction: 'ec2:DescribeVolumes',
      }),
    });
    await store.submitManual(manualInput);
    const s = store.state();
    expect(s.step === 'validationFailed' && s.kind).toBe('insufficient-permission');
  });

  it('raises the excessive-permissions alert and can continue past it', async () => {
    const { store } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'ok', identity }),
      permissions_check: () => dirtyAudit,
      policy_minimal_read: () => '{ "Version": "2012-10-17" }',
      connection_finalize: () => account,
    });
    await store.submitManual(manualInput);
    const alerted = store.state();
    expect(alerted.step).toBe('excessivePermissions');
    expect(alerted.step === 'excessivePermissions' && alerted.recommendedPolicy).toContain('2012-10-17');

    store.acceptRiskAndContinue();
    await tick();
    expect(store.state()).toEqual({ step: 'connected', account });
  });

  it('proceeds when the audit itself cannot run (inconclusive)', async () => {
    const { store } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'ok', identity }),
      permissions_check: () => Promise.reject(new Error('AccessDenied on iam:SimulatePrincipalPolicy')),
      connection_finalize: () => account,
    });
    await store.submitManual(manualInput);
    expect(store.state()).toEqual({ step: 'connected', account });
  });

  it('retries against the core-held credential without leaving the screen', async () => {
    let attempt = 0;
    const { store, ipc } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'invalid', message: 'clock skew' }),
      credential_revalidate: () => {
        attempt += 1;
        return { status: 'ok', identity };
      },
      permissions_check: () => cleanAudit,
      connection_finalize: () => account,
    });
    await store.submitManual(manualInput);
    expect(store.state().step).toBe('validationFailed');

    store.retry();
    await tick();
    expect(attempt).toBe(1);
    expect(ipc.calls).toContain('credential_revalidate');
    expect(store.state()).toEqual({ step: 'connected', account });
  });

  it('discards the core session when switching method', async () => {
    const { store, ipc } = await atManualEntry({
      credential_submit_manual: () => ({ status: 'invalid', message: 'x' }),
    });
    await store.submitManual(manualInput);
    store.switchMethod();
    await tick();
    expect(ipc.calls).toContain('session_discard');
    expect(store.state().step).toBe('methodSelect');
  });
});
