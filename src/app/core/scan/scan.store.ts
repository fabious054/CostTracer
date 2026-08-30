import { computed, inject, Injectable, signal } from '@angular/core';
import { ConnectionStore } from '../connection/connection.store';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import {
  DetectorKind,
  ResourceItem,
  ResourceRef,
  ResourceType,
  ScanResult,
} from '../models/scan';

type ScanPhase = 'idle' | 'scanning' | 'error';

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'The scan failed. See the app window for details.';
}

const TYPE_TO_KIND: Record<ResourceType, DetectorKind> = {
  ebs_volume: 'ebs-unattached',
  elastic_ip: 'elastic-ip-idle',
  ebs_snapshot: 'orphan-snapshot',
};

/**
 * Owns the latest scan result and the scan lifecycle. Hand-rolled signal store (ADR 0002, D4).
 * All scan logic and persistence live in the Rust core — this just calls commands and holds
 * the returned `ScanResult`.
 */
@Injectable({ providedIn: 'root' })
export class ScanStore {
  private readonly ipc = inject(TauriIpcService);
  private readonly connection = inject(ConnectionStore);

  private readonly _phase = signal<ScanPhase>('idle');
  private readonly _result = signal<ScanResult | null>(null);
  private readonly _error = signal<string | null>(null);

  readonly phase = this._phase.asReadonly();
  readonly result = this._result.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasResult = computed(() => this._result() !== null);

  /**
   * Load the most recent stored scan *for the connected account*. Clears first, so reconnecting
   * to a different account never shows the previous account's results.
   */
  async loadLatest(): Promise<void> {
    this._result.set(null);
    this._error.set(null);
    this._phase.set('idle');
    try {
      this._result.set(await this.ipc.call('scan_latest'));
    } catch {
      /* no stored scan yet, or store unavailable — leave as null */
    }
  }

  async run(): Promise<void> {
    this._phase.set('scanning');
    this._error.set(null);
    try {
      const outcome = await this.ipc.call('scan_run');
      if (outcome.status === 'reauthRequired') {
        this._phase.set('idle');
        void this.connection.disconnect();
        return;
      }
      this._result.set(outcome.result);
      this._phase.set('idle');
    } catch (e) {
      this._error.set(errMsg(e));
      this._phase.set('error');
    }
  }

  /** DEV-ONLY — seed a realistic fixture for reviewing the cost UI. Removed at Scope 3 closure. */
  async seedDemo(): Promise<void> {
    this._error.set(null);
    try {
      this._result.set(await this.ipc.call('dev_seed_scan'));
      this._phase.set('idle');
    } catch (e) {
      this._error.set(errMsg(e));
      this._phase.set('error');
    }
  }

  async markIntentional(item: ResourceItem): Promise<void> {
    await this.ipc.call('resource_mark_intentional', { input: refOf(item) });
    this.patchIntentional(item, true);
  }

  async unmarkIntentional(item: ResourceItem): Promise<void> {
    await this.ipc.call('resource_unmark_intentional', { input: refOf(item) });
    this.patchIntentional(item, false);
  }

  /** Optimistic local update — a full refresh comes on the next scan. */
  private patchIntentional(target: ResourceItem, intentional: boolean): void {
    const current = this._result();
    if (!current) return;
    const kind = TYPE_TO_KIND[target.resourceType];
    this._result.set({
      ...current,
      detectors: current.detectors.map((d) =>
        d.kind !== kind
          ? d
          : {
              ...d,
              items: d.items.map((i) =>
                i.resourceId === target.resourceId && i.region === target.region
                  ? { ...i, intentional, confidence: intentional ? null : i.confidence }
                  : i,
              ),
            },
      ),
    });
  }
}

function refOf(item: ResourceItem): ResourceRef {
  return {
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    region: item.region,
  };
}
