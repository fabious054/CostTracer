import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import { IpcCommand, IpcCommandMap } from '../models/ipc-contracts';
import { ResourceItem, ScanResult } from '../models/scan';
import { ScanStore } from './scan.store';

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
    fxUsdBrl: 5.4,
  };
}

function makeStore(handlers: Handlers): { store: ScanStore; ipc: FakeIpc } {
  const ipc = new FakeIpc({ connection_disconnect: () => undefined, detect_local_config: () => ({
    hasEnvCredentials: false,
    hasSharedCredentialsFile: false,
    hasConfigFile: false,
    profiles: [],
    defaultRegion: null,
  }), ...handlers });
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: TauriIpcService, useValue: ipc }],
  });
  return { store: TestBed.inject(ScanStore), ipc };
}

describe('ScanStore', () => {
  it('runs a scan and holds the result', async () => {
    const { store } = makeStore({ scan_run: () => ({ status: 'ok', result: result([alertingVolume()]) }) });
    await store.run();
    expect(store.phase()).toBe('idle');
    expect(store.result()?.detectors[0].items[0].resourceId).toBe('vol-1');
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
