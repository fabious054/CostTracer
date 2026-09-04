import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ConnectionStore } from '../connection/connection.store';
import { TauriEventsService } from '../events/tauri-events.service';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import { PricingStore } from '../pricing/pricing.store';
import {
  AccountCostRollup,
  DetectorCostRollup,
  DetectorKind,
  DetectorResult,
  RegionScanState,
  ResourceItem,
  ResourceRef,
  ResourceType,
  ScanDoneEvent,
  ScanRegionEvent,
  ScanResult,
  ScanStartedEvent,
  ScanStatus,
} from '../models/scan';

type ScanPhase = 'idle' | 'scanning' | 'error';

/**
 * Replace one region's slice of a scan result with the fresh data for that region, keeping every
 * other region as it was — so a rescan updates the inventory in place, region by region, instead
 * of collapsing to just what's been re-scanned so far. Rollups are recomputed from the merge.
 */
function mergeRegion(prev: ScanResult, ev: ScanRegionEvent): ScanResult {
  const r = ev.region;
  const freshItems = new Map<DetectorKind, ResourceItem[]>();
  const freshErrs = new Map<DetectorKind, ScanResult['detectors'][number]['regionErrors']>();
  for (const d of ev.result.detectors) {
    freshItems.set(d.kind, d.items.filter((i) => i.region === r));
    freshErrs.set(d.kind, d.regionErrors.filter((e) => e.region === r));
  }

  const detectors: DetectorResult[] = prev.detectors.map((d) => {
    const items = [...d.items.filter((i) => i.region !== r), ...(freshItems.get(d.kind) ?? [])];
    const regionErrors = [
      ...d.regionErrors.filter((e) => e.region !== r),
      ...(freshErrs.get(d.kind) ?? []),
    ];
    return { ...d, items, regionErrors, costRollup: detectorRollup(items) };
  });

  return {
    ...ev.result, // scanId / startedAt / fx / status / regions come from the running scan
    detectors,
    costRollup: accountRollup(detectors),
  };
}

function detectorRollup(items: ResourceItem[]): DetectorCostRollup {
  let monthlyUsd = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  for (const i of items) {
    const ec = i.estimatedCost;
    if (!ec) continue;
    if (ec.monthlyUsd != null) {
      monthlyUsd += ec.monthlyUsd;
      pricedCount += 1;
    } else if (ec.unavailable) {
      unpricedCount += 1;
    }
  }
  return { monthlyUsd, pricedCount, unpricedCount };
}

function accountRollup(detectors: DetectorResult[]): AccountCostRollup {
  let primaryMonthlyUsd = 0;
  let contextMonthlyUsd = 0;
  let unpricedCount = 0;
  for (const d of detectors) {
    for (const i of d.items) {
      const ec = i.estimatedCost;
      const level = i.confidence?.level;
      if (!ec || !level) continue;
      if (ec.monthlyUsd == null) {
        if (ec.unavailable) unpricedCount += 1;
        continue;
      }
      if (level === 'probable' || level === 'confirmed') primaryMonthlyUsd += ec.monthlyUsd;
      else contextMonthlyUsd += ec.monthlyUsd;
    }
  }
  return { primaryMonthlyUsd, contextMonthlyUsd, unpricedCount };
}

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'The scan failed. See the app window for details.';
}

const TYPE_TO_KIND: Record<ResourceType, DetectorKind> = {
  ebs_volume: 'ebs-unattached',
  elastic_ip: 'elastic-ip-idle',
  ebs_snapshot: 'orphan-snapshot',
  cloudwatch_log_group: 'log-group-no-retention',
  rds_snapshot: 'orphan-rds-snapshot',
};

/**
 * Owns the latest scan result and the scan lifecycle. Hand-rolled signal store (ADR 0002 D4).
 * Scope 4: a scan is now progressive — the core emits `scan://started` / `scan://region` /
 * `scan://done`, and this store merges each region in as it lands, tracks per-region status for
 * the "checking…" indicator, and can cancel a run in flight.
 */
@Injectable({ providedIn: 'root' })
export class ScanStore {
  private readonly ipc = inject(TauriIpcService);
  private readonly events = inject(TauriEventsService);
  private readonly connection = inject(ConnectionStore);
  private readonly pricing = inject(PricingStore);

  private readonly _phase = signal<ScanPhase>('idle');
  private readonly _result = signal<ScanResult | null>(null);
  private readonly _error = signal<string | null>(null);
  private readonly _regionStatus = signal<Record<string, RegionScanState>>({});
  private readonly _scanStatus = signal<ScanStatus | null>(null);

  readonly phase = this._phase.asReadonly();
  /**
   * The connected account's scan result, or null. Guarded: a result whose `accountId` isn't the
   * currently connected account never surfaces — a stale signal from a previous connection must
   * not paint another account's data, not even for one frame (cross-account isolation).
   */
  readonly result = computed<ScanResult | null>(() => {
    const r = this._result();
    return r && r.accountId === this.connectedAccount() ? r : null;
  });
  readonly error = this._error.asReadonly();
  readonly regionStatus = this._regionStatus.asReadonly();
  readonly scanStatus = this._scanStatus.asReadonly();
  readonly hasResult = computed(() => this.result() !== null);

  /** The account id of the current `connected` step, or null when not connected. */
  private readonly connectedAccount = computed(() => {
    const s = this.connection.state();
    return s.step === 'connected' ? s.account.accountId : null;
  });

  /** The account the store is currently bound to — `undefined` until the effect first runs. */
  private boundAccount: string | null | undefined = undefined;

  /** Last seen value of `pricing.refreshing()` — to detect the true→false edge. */
  private pricingWasRefreshing = false;

  constructor() {
    // The scan result is per-account. Bind the store to the connected account so switching
    // accounts — or disconnecting — always reloads that account's history and never leaves a
    // previous one on screen, with or without restarting the app (cf. the Scope 2 leak).
    effect(() => {
      const account = this.connectedAccount();
      if (account === this.boundAccount) return;
      const firstBind = this.boundAccount === undefined;
      this.boundAccount = account;
      if (!account) {
        this.reset();
      } else if (!firstBind) {
        // A real account switch — drop the previous account's state hard, then load the new one.
        void this.loadLatest();
      } else if (this._phase() === 'idle' && this._result() === null) {
        // Initial bind on a pristine store — the app just connected; pull this account's history.
        void this.loadLatest();
      }
    });

    // The background price refresher just went idle — re-pull the on-screen scan so figures that
    // showed "price pending" pick up the freshly-cached prices, with no manual re-scan. The scan
    // itself still never waits on the refresher (ADR 0006 D2); this is a passive catch-up.
    effect(() => {
      const refreshing = this.pricing.refreshing();
      const finished = this.pricingWasRefreshing && !refreshing;
      this.pricingWasRefreshing = refreshing;
      if (finished && this._phase() === 'idle' && this._result()) {
        void this.refreshCosts();
      }
    });
  }

  /** { done, total } across the current scan's regions — drives the progress line. */
  readonly regionProgress = computed(() => {
    const s = this._regionStatus();
    const total = Object.keys(s).length;
    const done = Object.values(s).filter((v) => v !== 'running').length;
    return { done, total };
  });

  private unlisteners: Array<() => void> = [];

  /** Most recent stored scan for the connected account. Clears first (never show a stale account). */
  async loadLatest(): Promise<void> {
    this.reset();
    try {
      this._result.set(await this.ipc.call('scan_latest'));
    } catch {
      /* no stored scan yet, or store unavailable — leave as null */
    }
  }

  /**
   * Re-read the latest stored scan (same inventory, same `scanId`) so its cost figures reflect
   * the current price cache. Unlike `loadLatest` there's no `reset()` — only `estimatedCost` and
   * `costRollup` change, so the UI just swaps the numbers in. Safe to call when nothing changed.
   */
  async refreshCosts(): Promise<void> {
    if (this._phase() !== 'idle' || !this._result()) return;
    try {
      const latest = await this.ipc.call('scan_latest');
      if (latest) this._result.set(latest);
    } catch {
      /* store unavailable — keep the figures we have */
    }
  }

  /** Any flagged resource still waiting on a background price fetch. */
  private hasPendingCosts(r: ScanResult): boolean {
    return r.detectors.some((d) =>
      d.items.some((i) => i.estimatedCost?.unavailable === 'price-pending'),
    );
  }

  async run(): Promise<void> {
    this._phase.set('scanning');
    this._error.set(null);
    this._scanStatus.set(null);
    await this.subscribe();
    try {
      const outcome = await this.ipc.call('scan_run');
      if (outcome.status === 'reauthRequired') {
        this.finish();
        void this.connection.disconnect();
        return;
      }
      // `scan://region` events already set the result; this is the authoritative final state.
      this._result.set(outcome.result);
      this._scanStatus.set(outcome.result.status);
      this.finish();
      // Cold-cache first run: prices may have landed while the scan ran. Catch up now; if the
      // refresher is still working, its idle event will trigger another pass (see the effect).
      if (this.hasPendingCosts(outcome.result)) void this.refreshCosts();
    } catch (e) {
      this._error.set(errMsg(e));
      this._phase.set('error');
      this.unsubscribe();
    }
  }

  /** Stop a scan in flight. Regions already finished stay; the rest never run (ADR 0004 D5). */
  async cancel(): Promise<void> {
    try {
      await this.ipc.call('scan_cancel');
    } catch {
      /* the scan will end on its own; nothing to recover */
    }
  }

  private async subscribe(): Promise<void> {
    this.unsubscribe();
    this.unlisteners = await Promise.all([
      this.events.on<ScanStartedEvent>('scan://started', (ev) => {
        // Keep the previous scan's results on screen until the first region of this one lands —
        // clearing here left a blank screen for the seconds region 1 takes.
        this._scanStatus.set(null);
        this._regionStatus.set(
          Object.fromEntries(ev.regions.map((r) => [r, 'running' as RegionScanState])),
        );
      }),
      this.events.on<ScanRegionEvent>('scan://region', (ev) => {
        const prev = this._result();
        this._result.set(prev ? mergeRegion(prev, ev) : ev.result);
        this._regionStatus.update((m) => ({
          ...m,
          [ev.region]: ev.regionStatus === 'partial' ? 'partial' : 'done',
        }));
      }),
      this.events.on<ScanDoneEvent>('scan://done', (ev) => {
        this._scanStatus.set(ev.status);
        this._regionStatus.update((m) => {
          const next = { ...m };
          for (const k of Object.keys(next)) if (next[k] === 'running') next[k] = 'skipped';
          return next;
        });
        this.finish();
      }),
    ]);
  }

  private unsubscribe(): void {
    for (const off of this.unlisteners) off();
    this.unlisteners = [];
  }

  private finish(): void {
    this._phase.set('idle');
    this.unsubscribe();
  }

  private reset(): void {
    this._result.set(null);
    this._error.set(null);
    this._phase.set('idle');
    this._regionStatus.set({});
    this._scanStatus.set(null);
    this.unsubscribe();
  }

  /** DEV-ONLY — seed a realistic fixture for reviewing the cost/inventory UI. Kept permanently. */
  async seedDemo(): Promise<void> {
    this.reset();
    try {
      const result = await this.ipc.call('dev_seed_scan');
      this._result.set(result);
      this._scanStatus.set(result.status);
      this._regionStatus.set(
        Object.fromEntries(result.regions.map((r) => [r, 'done' as RegionScanState])),
      );
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
