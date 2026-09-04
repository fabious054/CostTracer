import { computed, inject, Injectable, isDevMode, signal } from '@angular/core';
import { TauriEventsService } from '../events/tauri-events.service';
import { TauriIpcService } from '../ipc/tauri-ipc.service';

/**
 * Tracks the Rust-side background price/FX refresher (ADR 0006 D2). It keeps `pricing-cache.sqlite3`
 * warm on its own; this store only reflects whether it's *actively fetching* right now, for the
 * "updating prices…" strip. The scan reads the cache directly and never waits on any of this.
 */
@Injectable({ providedIn: 'root' })
export class PricingStore {
  private readonly ipc = inject(TauriIpcService);
  private readonly events = inject(TauriEventsService);

  private readonly _refreshing = signal(false);
  /** DEV-ONLY — pins the "updating prices" strip on for layout work (see `togglePinned`). */
  private readonly _pinned = signal(false);
  /** True while the refresher is fetching prices and/or the FX rate. */
  readonly refreshing = computed(() => this._refreshing() || this._pinned());

  constructor() {
    void this.events.on('pricing://refreshing', () => this._refreshing.set(true));
    void this.events.on('pricing://idle', () => this._refreshing.set(false));
  }

  /** DEV-ONLY — force the background-refresh strip visible so its layout can be worked on
   *  without waiting for a real refresh. Gated by `isDevMode()`; never affects a prod build. */
  readonly pinned = this._pinned.asReadonly();
  togglePinned(): void {
    if (isDevMode()) this._pinned.update((v) => !v);
  }

  /**
   * Ask the core to start the refresher (idempotent there) and pick up whether it's fetching
   * right now — covers the case where the boot-time `pricing://refreshing` event fired before
   * this store's listener was registered. Safe to call repeatedly (boot + on focus).
   */
  start(): void {
    void this.ipc
      .call('pricing_refresh_start')
      .then((active) => this._refreshing.set(active === true))
      .catch(() => {
        /* not in the desktop app, or the core isn't up yet — nothing to reflect */
      });
  }
}
