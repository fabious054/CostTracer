import { ChangeDetectionStrategy, Component, computed, inject, isDevMode, OnInit } from '@angular/core';
import { formatEventTime } from '../../core/format/event-time';
import { formatMoney } from '../../core/format/cost';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { BusyComponent } from '../onboarding/ui/busy.component';
import { DetectorSectionComponent } from './detector-section.component';

/** The scan entry point + results. First-run CTA, then a scan-meta line + the 3 detector sections. */
@Component({
  selector: 'ct-scan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BusyComponent, DetectorSectionComponent, TooltipDirective],
  template: `
    @switch (store.phase()) {
      @case ('scanning') {
        <ct-busy [label]="i18n.t('scan.scanning')" />
      }
      @case ('error') {
        <div class="ct-alert ct-alert--danger" role="alert">
          <strong>{{ i18n.t('scan.error.title') }}</strong>
          {{ store.error() }}
        </div>
        <button type="button" class="ct-btn ct-btn--primary retry" (click)="store.run()">
          {{ i18n.t('scan.error.retry') }}
        </button>
      }
      @default {
        @if (store.result(); as result) {
          <div class="meta">
            <span>{{ i18n.t('scan.meta.lastRun', { when: when(result.finishedAt) }) }}</span>
            @if (result.status === 'partial') {
              <span class="partial">{{ i18n.t('scan.meta.partial') }}</span>
            }
            <button type="button" class="ct-btn rescan" (click)="store.run()">
              {{ i18n.t('scan.rescan') }}
            </button>
            @if (isDev) {
              <button type="button" class="ct-btn dev-seed" (click)="store.seedDemo()" title="DEV-ONLY">
                seed demo
              </button>
            }

            @if (unpricedGlobal(); as u) {
              <span class="unpriced-line">
                <span class="unpriced-tag" [ctTooltip]="u.hint" tabindex="0">
                  <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <circle cx="8" cy="5" r="1" fill="currentColor" />
                    <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                  {{ u.count }} {{ i18n.t('cost.unpricedTag') }}
                </span>
              </span>
            }
          </div>

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
        } @else {
          <div class="firstrun">
            <h2>{{ i18n.t('scan.firstRun.title') }}</h2>
            <p class="ct-muted">{{ i18n.t('scan.firstRun.body') }}</p>
            <button type="button" class="ct-btn ct-btn--primary" (click)="store.run()">
              {{ i18n.t('scan.runFirst') }}
            </button>
            @if (isDev) {
              <button type="button" class="ct-btn dev-seed" (click)="store.seedDemo()" title="DEV-ONLY">
                seed demo
              </button>
            }
          </div>
        }
      }
    }
  `,
  styles: [
    `
      .meta {
        display: flex;
        align-items: baseline;
        column-gap: 12px;
        row-gap: 4px;
        flex-wrap: wrap;
        margin-bottom: 18px;
        font-size: 11.5px;
        color: var(--ct-text-dim);
      }
      .partial {
        color: var(--ct-warn);
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
export class ScanPanelComponent implements OnInit {
  protected readonly i18n = inject(I18nService);
  protected readonly store = inject(ScanStore);
  /** DEV-ONLY — the "seed demo" button. Removed at Scope 3 closure. */
  protected readonly isDev = isDevMode();

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

  ngOnInit(): void {
    void this.store.loadLatest();
  }

  protected when(unixSecs: number): string {
    return formatEventTime(unixSecs, this.i18n.locale());
  }
}
