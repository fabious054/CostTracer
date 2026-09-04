import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectionStore } from '../connection/connection.store';
import { TauriEventsService } from '../events/tauri-events.service';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import { IpcCommand, IpcCommandMap } from '../models/ipc-contracts';
import { ResourceItem, ScanResult, ScanRunOutcome } from '../models/scan';
import { ScanStore } from './scan.store';

/** Lets a test push backend events into the store. */
class FakeEvents {
  private readonly handlers = new Map<string, (p: unknown) => void>();
  on(event: string, handler: (p: unknown) => void): Promise<() => void> {
    this.handlers.set(event, handler);
    return Promise.resolve(() => this.handlers.delete(event));
  }
  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

/** Stands in for the real ConnectionStore — lets a test set / switch the connected account. */
class FakeConnection {
  private readonly _account = signal<{ accountId: string; regions: string[] } | null>({
    accountId: '123456789012',
    regions: ['us-east-1'],
  });
  readonly state = computed(() =>
    this._account()
      ? { step: 'connected' as const, account: this._account()! }
      : { step: 'detecting' as const },
  );
  constructor(private readonly ipc: FakeIpc) {}
  setAccount(accountId: string | null): void {
    this._account.set(accountId ? { accountId, regions: ['us-east-1'] } : null);
  }
  async disconnect(): Promise<void> {
    await this.ipc.call('connection_disconnect');
    this._account.set(null);
  }
}

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

function alertingVolume(): ResourceItem {
  return {
    resourceType: 'ebs_volume',
    resourceId: 'vol-1',
    region: 'us-east-1',
    displayName: null,
    state: 'alert',
    neutralNote: null,
    intentional: false,
    createdAt: 1000,
    monitoredSince: 1000,
    confidence: { level: 'probable', daysCoverage: 6, scale: 'standard' },
    estimatedCost: {
      monthlyUsd: 8,
      basis: 'ebs-gib',
      qualifiers: [],
      unavailable: null,
      pricedAt: null,
    },
    facts: { sizeGiB: 100 },
  };
}

const noRollup = { monthlyUsd: 0, pricedCount: 0, unpricedCount: 0 };

function result(items: ResourceItem[]): ScanResult {
  return {
    scanId: 1,
    startedAt: 10,
    finishedAt: 20,
    accountId: '123456789012',
    regions: ['us-east-1'],
    status: 'ok',
    detectors: [
      { kind: 'ebs-unattached', regionErrors: [], items, costRollup: { ...noRollup } },
      { kind: 'elastic-ip-idle', regionErrors: [], items: [], costRollup: { ...noRollup } },
      { kind: 'orphan-snapshot', regionErrors: [], items: [], costRollup: { ...noRollup } },
    ],
    costRollup: { primaryMonthlyUsd: 0, contextMonthlyUsd: 0, unpricedCount: 0 },
    fx: { rate: 5.4, asOf: null, state: 'fresh' },
  };
}

function makeStore(handlers: Handlers): {
  store: ScanStore;
  ipc: FakeIpc;
  events: FakeEvents;
  connection: FakeConnection;
} {
  const ipc = new FakeIpc({ connection_disconnect: () => undefined, detect_local_config: () => ({
    hasEnvCredentials: false,
    hasSharedCredentialsFile: false,
    hasConfigFile: false,
    profiles: [],
    defaultRegion: null,
  }), ...handlers });
  const events = new FakeEvents();
  const connection = new FakeConnection(ipc);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: TauriIpcService, useValue: ipc },
      { provide: TauriEventsService, useValue: events },
      { provide: ConnectionStore, useValue: connection },
    ],
  });
  return { store: TestBed.inject(ScanStore), ipc, events, connection };
}

describe('ScanStore', () => {
  it('runs a scan and holds the result', async () => {
    const { store } = makeStore({ scan_run: () => ({ status: 'ok', result: result([alertingVolume()]) }) });
    await store.run();
    expect(store.phase()).toBe('idle');
    expect(store.result()?.detectors[0].items[0].resourceId).toBe('vol-1');
  });

  it('merges regions progressively and tracks per-region status', async () => {
    // scan_run resolves only after we've pushed the events, so the event path is what fills state.
    let resolveRun!: (v: ScanRunOutcome) => void;
    const { store, events } = makeStore({
      scan_run: () => new Promise<ScanRunOutcome>((r) => (resolveRun = r)),
    });

    const runP = store.run();
    await tick();

    events.emit('scan://started', { scanId: 1, regions: ['ap-south-1', 'eu-west-1', 'us-east-1'] });
    expect(store.regionProgress()).toEqual({ done: 0, total: 3 });
    expect(store.phase()).toBe('scanning');

    events.emit('scan://region', {
      scanId: 1,
      region: 'us-east-1',
      regionStatus: 'ok',
      result: result([alertingVolume()]),
    });
    expect(store.result()?.detectors[0].items[0].resourceId).toBe('vol-1');
    expect(store.regionStatus()['us-east-1']).toBe('done');
    expect(store.regionProgress()).toEqual({ done: 1, total: 3 });

    events.emit('scan://region', {
      scanId: 1,
      region: 'eu-west-1',
      regionStatus: 'partial',
      result: result([]),
    });
    expect(store.regionStatus()['eu-west-1']).toBe('partial');
    // merged: us-east-1's vol-1 kept, and the rollup recomputed from the merged items
    expect(store.result()?.detectors[0].items[0].resourceId).toBe('vol-1');
    expect(store.result()?.detectors[0].costRollup.monthlyUsd).toBe(8);

    // cancelled before ap-south-1 ran
    events.emit('scan://done', { scanId: 1, status: 'cancelled' });
    expect(store.regionStatus()['ap-south-1']).toBe('skipped');
    expect(store.scanStatus()).toBe('cancelled');
    expect(store.phase()).toBe('idle');

    resolveRun({ status: 'cancelled', result: result([alertingVolume()]) });
    await runP;
  });

  it('never surfaces a result that belongs to a different account', async () => {
    const { store, connection } = makeStore({
      scan_run: () => ({ status: 'ok', result: result([alertingVolume()]) }),
      scan_latest: () => null,
    });
    await store.run();
    expect(store.result()?.accountId).toBe('123456789012');

    // Switch accounts before the new one's history loads — the previous account's inventory
    // must not stay on screen, not even for a frame.
    connection.setAccount('999988887777');
    expect(store.result()).toBeNull();
    expect(store.hasResult()).toBeFalse();
  });

  it('loads history for whichever account is connected', async () => {
    const byAccount: Record<string, ScanResult> = {
      '123456789012': { ...result([alertingVolume()]), accountId: '123456789012', scanId: 1 },
      '999988887777': { ...result([]), accountId: '999988887777', scanId: 7 },
    };
    const { store, connection } = makeStore({
      scan_latest: () => {
        const s = connection.state();
        return s.step === 'connected' ? (byAccount[s.account.accountId] ?? null) : null;
      },
    });
    await store.loadLatest();
    expect(store.result()?.scanId).toBe(1);

    connection.setAccount('999988887777');
    await store.loadLatest();
    expect(store.result()?.accountId).toBe('999988887777');
    expect(store.result()?.scanId).toBe(7);
  });

  it('sends the user back to onboarding when the credential no longer validates', async () => {
    const { store, ipc } = makeStore({ scan_run: () => ({ status: 'reauthRequired' }) });
    await store.run();
    await tick();
    expect(store.result()).toBeNull();
    expect(store.phase()).toBe('idle');
    expect(ipc.calls).toContain('connection_disconnect');
  });

  it('surfaces a failed scan as an error phase', async () => {
    const { store } = makeStore({ scan_run: () => Promise.reject(new Error('network down')) });
    await store.run();
    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('network down');
  });

  it('marks a resource intentional and clears its confidence locally', async () => {
    const { store, ipc } = makeStore({
      scan_run: () => ({ status: 'ok', result: result([alertingVolume()]) }),
      resource_mark_intentional: () => undefined,
    });
    await store.run();
    await store.markIntentional(store.result()!.detectors[0].items[0]);

    expect(ipc.calls).toContain('resource_mark_intentional');
    const item = store.result()!.detectors[0].items[0];
    expect(item.intentional).toBe(true);
    expect(item.confidence).toBeNull();
  });

  it('loads the latest stored scan', async () => {
    const { store } = makeStore({ scan_latest: () => result([alertingVolume()]) });
    await store.loadLatest();
    expect(store.result()?.scanId).toBe(1);
  });
});
