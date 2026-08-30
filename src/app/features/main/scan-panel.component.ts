import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  isDevMode,
  signal,
} from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { formatEventTime } from '../../core/format/event-time';
import { formatMoney } from '../../core/format/cost';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { DetectorSectionComponent } from './detector-section.component';

/** The scan entry point + results. First-run CTA, then a scan-meta line + the 3 detector sections. */
@Component({
  selector: 'ct-scan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DetectorSectionComponent, TooltipDirective],
  template: `
    @switch (store.phase()) {
      @case ('error') {
        <div class="ct-alert ct-alert--danger" role="alert">
          <strong>{{ i18n.t('scan.error.title') }}</strong>
          {{ store.error() }}
        </div>
        <button
          type="button"
          class="ct-btn ct-btn--primary retry"
          (click)="requestScan()"
          [disabled]="regionsBlocked()"
        >
          {{ i18n.t('scan.error.retry') }}
        </button>
      }
      @default {
        @if (warnOpen()) {
          <div class="prescan-warn" role="dialog" aria-modal="false">
            <p class="fact">{{ i18n.t('scan.multiRegion.warn.count', { n: regionCount() }) }}</p>
            <p class="safe">{{ i18n.t('scan.multiRegion.warn.readonly') }}</p>
            <p class="time">{{ i18n.t('scan.multiRegion.warn.time') }}</p>
            <div class="ct-row">
              <button type="button" class="ct-btn ct-btn--primary" (click)="confirmScan()">
                {{ i18n.t('scan.multiRegion.warn.confirm') }}
              </button>
              <button type="button" class="ct-btn ct-btn--ghost" (click)="warnOpen.set(false)">
                {{ i18n.t('common.cancel') }}
              </button>
            </div>
          </div>
        }

        @if (blockedNotice(); as note) {
          <div class="stale-banner" role="status">
            <svg class="stale-banner__icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
              <circle cx="8" cy="5" r="1" fill="currentColor" />
              <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <p>{{ note }}</p>
          </div>
        }

        <!-- One fixed status line right under the header — content swaps by phase, so nothing
             below it moves when a scan starts or ends. -->
        @if (store.result() || store.phase() === 'scanning' || cancelledLine()) {
          <div class="statusbar">
            @if (store.phase() === 'scanning') {
              <span class="spin lg" aria-hidden="true"></span>
              <span class="prog-label">{{ progressLabel() }}</span>
              <button type="button" class="ct-btn cancel" (click)="store.cancel()">
                {{ i18n.t('scan.cancel') }}
              </button>
            } @else {
              <span [class.partial]="!!cancelledLine()">{{ lastRunLabel() }}</span>
              @if (store.result()?.status === 'partial') {
                <span class="partial">{{ i18n.t('scan.meta.partial') }}</span>
              }
              <button
                type="button"
                class="ct-btn rescan"
                (click)="requestScan()"
                [disabled]="regionsBlocked()"
              >
                {{ i18n.t('scan.rescan') }}
              </button>
              @if (isDev) {
                <button type="button" class="ct-btn dev-seed" (click)="store.seedDemo()" title="DEV-ONLY">
                  seed demo
                </button>
              }
            }

            @if (regionStrip().length > 0) {
              <button type="button" class="link toggle" (click)="regionsOpen.set(!regionsOpen())">
                {{ regionsOpen() ? i18n.t('scan.regions.hide') : i18n.t('scan.regions.show') }}
              </button>
            }
          </div>

          @if (regionsOpen() && regionStrip().length > 0) {
            <div class="regions-panel">
              @for (r of regionStrip(); track r.name) {
                <span class="region-chip" [attr.data-state]="r.state">
                  {{ r.name }}
                  @switch (r.state) {
                    @case ('running') { <span class="spin" aria-hidden="true"></span> }
                    @case ('done') { <span class="mk">&#10003;</span> }
                    @case ('partial') { <span class="mk warn">&#9888;</span> }
                    @default { <span class="mk">–</span> }
                  }
                </span>
              }
            </div>
          }

          @if (unpricedGlobal(); as u) {
            <p class="unpriced-line">
              <span class="unpriced-tag" [ctTooltip]="u.hint" tabindex="0">
                <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <circle cx="8" cy="5" r="1" fill="currentColor" />
                  <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                {{ u.count }} {{ i18n.t('cost.unpricedTag') }}
              </span>
            </p>
          }
        }

        <div class="inventory" [class.inventory--stale]="regionsBlocked() && !!store.result()">
        @if (store.result(); as result) {
          @if (accountCost(); as ac) {
            <section class="acct-cost">
              @if (ac.approx) {
                <span class="acct-cost-flag" [ctTooltip]="ac.approx" tabindex="0">
                  <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <circle cx="8" cy="5" r="1" fill="currentColor" />
                    <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                  {{ i18n.t('cost.approxFlag') }}
                </span>
              }
              <span class="acct-cost-title">{{ i18n.t('cost.account.title') }}</span>
              <p class="acct-cost-primary">
                <strong>{{ ac.primary }}</strong>
                <span class="lbl">{{ ac.primaryLabel }}</span>
              </p>
              @if (ac.context) {
                <p class="acct-cost-ctx">
                  <span class="amt">{{ ac.context }}</span>
                  <span class="lbl">{{ ac.contextLabel }}</span>
                </p>
              }
            </section>
          }

          @for (detector of result.detectors; track detector.kind) {
            <ct-detector-section [detector]="detector" />
          }
        } @else if (store.phase() !== 'scanning' && !cancelledLine() && !regionsBlocked()) {
          <div class="firstrun">
            <h2>{{ i18n.t('scan.firstRun.title') }}</h2>
            <p class="ct-muted">{{ i18n.t('scan.firstRun.body') }}</p>
            <button type="button" class="ct-btn ct-btn--primary" (click)="requestScan()">
              {{ i18n.t('scan.runFirst') }}
            </button>
            @if (isDev) {
              <button type="button" class="ct-btn dev-seed" (click)="store.seedDemo()" title="DEV-ONLY">
                seed demo
              </button>
            }
          </div>
        }
        </div>
      }
    }
  `,
  styles: [
    `
      .statusbar {
        position: relative;
        display: flex;
        align-items: center;
        column-gap: 12px;
        row-gap: 4px;
        flex-wrap: wrap;
        min-height: 26px;
        margin-bottom: 14px;
        font-size: 11.5px;
        color: var(--ct-text-dim);
      }
      .partial {
        color: var(--ct-warn);
      }
      .prescan-warn {
        border: 1px solid var(--ct-border-line);
        border-left: 3px solid var(--ct-warn);
        border-radius: var(--ct-radius);
        background: var(--ct-inset);
        padding: 12px 14px;
        margin-bottom: 16px;
      }
      .prescan-warn p {
        margin: 0 0 6px;
        font-size: 12px;
      }
      .prescan-warn .safe {
        color: var(--ct-ok);
      }
      .prescan-warn .time {
        color: var(--ct-text-dim);
      }
      .prescan-warn .ct-row {
        margin-top: 10px;
      }
      /* Stored scan on screen, but the connected credential can't verify regions — a real
         barrier to refreshing. Loud about the barrier; the history below stays readable. */
      .stale-banner {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        border: 1px solid var(--ct-border-line);
        border-left: 3px solid var(--ct-warn);
        border-radius: var(--ct-radius);
        background: var(--ct-inset);
        padding: 10px 12px;
        margin-bottom: 14px;
      }
      .stale-banner p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--ct-text);
      }
      .stale-banner__icon {
        flex: none;
        width: 14px;
        height: 14px;
        margin-top: 1px;
        color: var(--ct-warn);
      }
      .inventory--stale {
        opacity: 0.5;
        filter: grayscale(0.6);
      }
      .prog-label {
        font-variant-numeric: tabular-nums;
      }
      .cancel {
        border-color: var(--ct-warn);
        color: var(--ct-warn);
        font-size: 11px;
        padding: 3px 10px;
      }
      .toggle {
        border: 0;
        background: transparent;
        padding: 0;
        font-size: 11px;
        color: var(--ct-accent);
        cursor: pointer;
      }
      .toggle:hover {
        text-decoration: underline;
      }
      .spin.lg {
        width: 12px;
        height: 12px;
      }
      /* Inline panel below the status line, updated live as regions finish. Caps its height so a
         34-region account still leaves the rest of the view usable. */
      .regions-panel {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        max-height: 150px;
        overflow-y: auto;
        margin: -4px 0 16px;
        padding: 10px;
        border: 1px solid var(--ct-border-faint);
        border-radius: var(--ct-radius);
        background: var(--ct-panel);
      }
      .region-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        background: var(--ct-inset);
        color: var(--ct-text-faint);
      }
      .region-chip[data-state='done'] {
        color: var(--ct-text-dim);
      }
      .region-chip[data-state='partial'] {
        color: var(--ct-warn);
      }
      .region-chip .mk {
        font-size: 10px;
      }
      .region-chip .mk.warn {
        color: var(--ct-warn);
      }
      .spin {
        width: 8px;
        height: 8px;
        border: 1.4px solid var(--ct-border-line);
        border-top-color: var(--ct-accent);
        border-radius: 50%;
        animation: ct-spin 0.7s linear infinite;
      }
      @keyframes ct-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .unpriced-line {
        flex-basis: 100%;
      }
      .unpriced-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: var(--ct-text-faint);
        font-variant-numeric: tabular-nums;
        cursor: help;
      }
      .unpriced-tag .i {
        width: 10px;
        height: 10px;
      }
      .rescan {
        margin-left: auto;
      }
      .dev-seed {
        border-style: dashed;
        color: var(--ct-text-faint);
        font-size: 11px;
      }
      .retry {
        margin-top: 12px;
      }
      .firstrun {
        text-align: center;
        padding: 32px 0;
      }
      .firstrun h2 {
        font-size: 14px;
        margin: 0 0 6px;
      }
      .firstrun p {
        font-size: 12.5px;
        margin: 0 auto 16px;
        max-width: 380px;
      }
      .acct-cost {
        position: relative;
        border: 1px solid var(--ct-border-line);
        border-left: 3px solid var(--ct-accent);
        border-radius: var(--ct-radius);
        background: var(--ct-inset);
        padding: 12px 14px;
        margin-bottom: 16px;
      }
      .acct-cost-flag {
        position: absolute;
        top: -8px;
        left: 12px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--ct-panel);
        border: 1px solid var(--ct-warning-border, var(--ct-border-line));
        color: var(--ct-warn);
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        white-space: nowrap;
        cursor: help;
      }
      .acct-cost-flag .i {
        width: 9px;
        height: 9px;
      }
      .acct-cost-title {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
        color: var(--ct-text-dim);
      }
      .acct-cost-primary {
        margin: 6px 0 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .acct-cost-primary strong {
        font-size: 16px;
        font-weight: 700;
        color: var(--ct-text);
        font-variant-numeric: tabular-nums;
      }
      .acct-cost-ctx {
        margin: 3px 0 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .acct-cost-ctx .amt {
        font-size: 12px;
        color: var(--ct-text-dim);
        font-variant-numeric: tabular-nums;
      }
      .acct-cost-primary .lbl,
      .acct-cost-ctx .lbl {
        font-size: 11px;
        font-weight: 400;
        color: var(--ct-text-faint);
      }
    `,
  ],
})
export class ScanPanelComponent {
  protected readonly i18n = inject(I18nService);
  protected readonly store = inject(ScanStore);
  private readonly connection = inject(ConnectionStore);
  /** DEV-ONLY — the "seed demo" button. Kept permanently (CLAUDE.md checklist exception). */
  protected readonly isDev = isDevMode();

  /** Pre-scan multi-region warning: shown once per connected session (ADR 0004 D5). */
  protected readonly warnOpen = signal(false);
  private multiRegionAcked = false;
  /** The per-region chip list — collapsed by default so it doesn't flood the view. */
  protected readonly regionsOpen = signal(false);

  protected regionCount(): number {
    const s = this.connection.state();
    return s.step === 'connected' ? s.account.regions.length : 0;
  }

  protected requestScan(): void {
    // A scan re-runs region discovery — pointless while the connected credential can't (the
    // button is disabled in this state; this guards the error-retry and keyboard paths too).
    if (this.regionsBlocked()) return;
    if (this.regionCount() > 1 && !this.multiRegionAcked) {
      this.warnOpen.set(true);
    } else {
      this.regionsOpen.set(false);
      void this.store.run();
    }
  }

  protected confirmScan(): void {
    if (this.regionsBlocked()) return;
    this.multiRegionAcked = true;
    this.warnOpen.set(false);
    this.regionsOpen.set(false);
    void this.store.run();
  }

  protected readonly progressLabel = computed(() => {
    const p = this.store.regionProgress();
    return p.total > 0
      ? this.i18n.t('scan.progress', { done: p.done, total: p.total })
      : this.i18n.t('scan.scanning');
  });

  /** Region chips — shown while scanning, and afterwards when the scan was cancelled or partial. */
  protected readonly regionStrip = computed(() => {
    const status = this.store.regionStatus();
    const scanning = this.store.phase() === 'scanning';
    const s = this.store.scanStatus();
    if (!scanning && s !== 'cancelled' && s !== 'partial') return [];
    return Object.entries(status)
      .map(([name, state]) => ({ name, state }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly cancelledLine = computed(() => {
    if (this.store.phase() === 'scanning' || this.store.scanStatus() !== 'cancelled') return null;
    const p = this.store.regionProgress();
    return this.i18n.t('scan.cancelled', { done: p.done, total: p.total });
  });

  /** The left text of the status line when not scanning — "cancelled" note or "last scan …". */
  protected readonly lastRunLabel = computed(() => {
    const c = this.cancelledLine();
    if (c) return c;
    const r = this.store.result();
    return r ? this.i18n.t('scan.meta.lastRun', { when: this.when(r.finishedAt) }) : '';
  });

  /** The connected credential can't run `ec2:DescribeRegions` — no fresh scan is possible. */
  protected readonly regionsBlocked = computed(() => {
    const s = this.connection.state();
    return s.step === 'connected' && s.account.regionsDiscovered === false;
  });

  /**
   * The banner shown whenever the connected credential can't verify regions. With a stored scan
   * on screen it frames the (recessed, still valuable) inventory as history; without one it just
   * explains why scanning is unavailable.
   */
  protected readonly blockedNotice = computed(() => {
    if (!this.regionsBlocked()) return null;
    const r = this.store.result();
    return r
      ? this.i18n.t('scan.staleCredential', { when: this.when(r.finishedAt) })
      : this.i18n.t('scan.regionsBlocked');
  });

  protected readonly accountCost = computed(() => {
    const r = this.store.result();
    if (!r) return null;
    const cr = r.costRollup;
    if (cr.primaryMonthlyUsd <= 0 && cr.contextMonthlyUsd <= 0 && cr.unpricedCount === 0) {
      return null;
    }
    const loc = this.i18n.locale();
    return {
      primary: this.i18n.t('cost.account.primary', {
        amount: formatMoney(cr.primaryMonthlyUsd, loc, r.fxUsdBrl),
      }),
      primaryLabel: this.i18n.t('cost.account.primaryLabel'),
      context:
        cr.contextMonthlyUsd > 0
          ? this.i18n.t('cost.account.context', {
              amount: formatMoney(cr.contextMonthlyUsd, loc, r.fxUsdBrl, false),
            })
          : null,
      contextLabel: this.i18n.t('cost.account.contextLabel'),
      approx: loc === 'pt' ? this.i18n.t('cost.approxNote') : null,
    };
  });

  /** Account-wide "resources in a region the price table doesn't cover" — a tool-coverage note,
   *  kept out of the cost card (which is about waste, not coverage). */
  protected readonly unpricedGlobal = computed(() => {
    const r = this.store.result();
    if (!r || r.costRollup.unpricedCount === 0) return null;
    const regions = [
      ...new Set(
        r.detectors.flatMap((d) =>
          d.items.filter((i) => i.estimatedCost?.unavailable === 'region').map((i) => i.region),
        ),
      ),
    ].sort();
    return {
      count: r.costRollup.unpricedCount,
      hint: this.i18n.t('cost.unpricedGlobal', {
        count: r.costRollup.unpricedCount,
        regions: regions.join(', '),
      }),
    };
  });

  protected when(unixSecs: number): string {
    return formatEventTime(unixSecs, this.i18n.locale());
  }
}
