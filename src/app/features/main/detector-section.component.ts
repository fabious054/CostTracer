import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { formatMoney } from '../../core/format/cost';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConfidenceLevel, DetectorKind, DetectorResult, ResourceItem } from '../../core/models/scan';
import { ScanStore } from '../../core/scan/scan.store';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { ResourceRowComponent } from './resource-row.component';

const PAGE = 15;
const LEVELS: ConfidenceLevel[] = ['confirmed', 'probable', 'persisting', 'observed'];
/** Everything starts collapsed; the reader opens what they want. Choices persist in localStorage. */
const GROUP_OPEN_DEFAULT = false;
const SECTION_COLLAPSED_DEFAULT = true;

interface Group {
  key: string;
  label: string;
  /** drives the header colour; null for the intentional / in-use groups */
  levelAttr: ConfidenceLevel | null;
  items: ResourceItem[];
  subtotalUsd: number;
  unpricedCount: number;
}

function collapsedKey(kind: DetectorKind): string {
  return `ct.scan.collapsed.${kind}`;
}
function groupKey(kind: DetectorKind, group: string): string {
  return `ct.scan.group.${kind}.${group}`;
}
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage blocked — still works for this session */
  }
}

/**
 * One detector's slice of the inventory. The header is the at-a-glance status; the body groups
 * resources by confidence level (Confirmed / Probable expanded, the rest collapsed), each group
 * capped with a "show more", so a busy account stays scannable instead of an endless list.
 */
@Component({
  selector: 'ct-detector-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ResourceRowComponent, TooltipDirective],
  template: `
    @if (detector(); as d) {
      <section class="panel">
        <button
          type="button"
          class="header"
          [attr.aria-expanded]="!collapsed()"
          (click)="toggle()"
        >
          <span class="caret" [class.open]="!collapsed()" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M4.5 3 L8 6 L4.5 9" /></svg>
          </span>
          <h2>{{ i18n.t('scan.detector.' + d.kind) }}</h2>
          @if (costSummary(); as c) {
            <span class="det-cost">
              @if (c.amount) {
                <span class="amt">{{ c.amount }}</span>
              }
              <span class="ctx">
                @if (c.count) {
                  <span>{{ c.count }}</span>
                }
                @if (c.unpriced > 0) {
                  <span
                    class="unpriced-badge"
                    [ctTooltip]="i18n.t('cost.unpricedHint', { count: c.unpriced })"
                    tabindex="0"
                  >
                    <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                      <circle cx="8" cy="5" r="1" fill="currentColor" />
                      <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                    {{ c.unpriced }}
                  </span>
                }
              </span>
            </span>
          }

          <span
            class="status"
            [ctTooltip]="i18n.t('scan.counts.hint', { alerting: alertingCount(), total: d.items.length })"
            tabindex="0"
          >
            @if (alertingCount() > 0) {
              <span class="pill alert">{{ alertingCount() }}</span>
            } @else if (d.items.length > 0) {
              <span class="ok">&#10003;</span>
            }
            <span class="pill total">{{ d.items.length }}</span>
            @if (d.regionErrors.length > 0) {
              <span class="warn" [ctTooltip]="i18n.t('scan.meta.partial')" tabindex="0">&#9888;</span>
            }
          </span>
        </button>

        @if (!collapsed()) {
          <div class="body">
            @for (err of d.regionErrors; track err.region) {
              <p class="ct-alert ct-alert--warning region-err">
                {{ i18n.t('scan.regionError', { region: err.region, message: err.message }) }}
              </p>
            }

            @if (d.items.length === 0) {
              <p class="empty">{{ i18n.t('scan.empty') }}</p>
            }

            @for (g of groups(); track g.key) {
              <div class="group">
                <button
                  type="button"
                  class="group-head"
                  [attr.aria-expanded]="isOpen(g.key)"
                  (click)="toggleGroup(g.key)"
                >
                  <span class="caret sm" [class.open]="isOpen(g.key)" aria-hidden="true">
                    <svg viewBox="0 0 12 12"><path d="M4.5 3 L8 6 L4.5 9" /></svg>
                  </span>
                  <span class="glabel" [attr.data-level]="g.levelAttr">{{ g.label }}</span>
                  <span class="gcount">{{ g.items.length }}</span>
                  <span class="gsub">
                    @if (g.unpricedCount > 0) {
                      <span
                        class="unpriced-badge"
                        [ctTooltip]="i18n.t('cost.unpricedHint', { count: g.unpricedCount })"
                        tabindex="0"
                      >
                        <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                          <circle cx="8" cy="5" r="1" fill="currentColor" />
                          <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        </svg>
                        {{ g.unpricedCount }}
                      </span>
                    }
                    @if (groupSubtotal(g); as sub) {
                      <span class="gsub-amt">{{ sub }}</span>
                    }
                  </span>
                </button>

                @if (isOpen(g.key)) {
                  @for (item of visible(g); track item.resourceId + '@' + item.region) {
                    <ct-resource-row [item]="item" />
                  }
                  @if (g.items.length > shownFor(g.key)) {
                    <button type="button" class="show-more" (click)="showMore(g.key)">
                      {{ i18n.t('scan.showMore', { n: g.items.length - shownFor(g.key) }) }}
                    </button>
                  }
                }
              </div>
            }
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      .panel {
        background: var(--ct-panel);
        border: 1px solid var(--ct-border-faint);
        border-radius: var(--ct-radius);
        margin-bottom: 12px;
      }
      /* Fixed columns so the title / cost / count line up across all three detector panels
         instead of drifting with each title's length. */
      .header {
        width: 100%;
        display: grid;
        grid-template-columns: 14px minmax(0, 1fr) 156px 68px;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
        border-radius: var(--ct-radius);
      }
      .header:hover {
        background: var(--ct-inset);
      }
      .caret {
        flex: none;
        display: grid;
        place-items: center;
        width: 12px;
        height: 12px;
        color: var(--ct-text-faint);
      }
      .caret svg {
        width: 10px;
        height: 10px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.4;
        stroke-linecap: round;
        stroke-linejoin: round;
        transform-box: fill-box;
        transform-origin: center;
        transition: transform 0.12s ease;
      }
      .caret.sm svg {
        width: 8px;
        height: 8px;
      }
      .caret.open svg {
        transform: rotate(90deg);
      }
      h2 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
      }
      .det-cost {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        font-variant-numeric: tabular-nums;
        line-height: 1.25;
      }
      .det-cost .amt {
        font-size: 11px;
        color: var(--ct-text-dim);
      }
      .det-cost .ctx {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 10px;
        color: var(--ct-text-faint);
      }
      .unpriced-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        color: var(--ct-text-faint);
        white-space: nowrap;
        cursor: help;
      }
      .unpriced-badge .i {
        width: 11px;
        height: 11px;
      }
      .status {
        justify-self: end;
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 11px;
        color: var(--ct-text-faint);
      }
      .pill {
        min-width: 18px;
        padding: 1px 6px;
        border-radius: 999px;
        font-weight: 700;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .pill.alert {
        background: var(--ct-warn-bg);
        color: var(--ct-warn);
      }
      .pill.total {
        background: var(--ct-inset);
        color: var(--ct-text-faint);
      }
      .ok {
        color: var(--ct-ok);
        font-size: 12px;
      }
      .warn {
        color: var(--ct-warn);
        font-size: 12px;
      }
      .body {
        padding: 0 14px 6px;
      }
      .region-err {
        margin: 8px 0 0;
      }
      .empty {
        margin: 4px 0 8px;
        font-size: 12px;
        color: var(--ct-text-dim);
      }
      .group {
        border-top: 1px solid var(--ct-border-faint);
      }
      .group:first-of-type {
        border-top: 0;
      }
      .group-head {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 2px;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
      }
      .group-head:hover {
        background: var(--ct-inset);
      }
      .glabel {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--ct-text-dim);
      }
      .glabel[data-level='persisting'],
      .glabel[data-level='probable'] {
        color: var(--ct-warn);
      }
      .glabel[data-level='confirmed'] {
        color: var(--ct-danger);
      }
      .gcount {
        font-size: 10.5px;
        color: var(--ct-text-faint);
        font-variant-numeric: tabular-nums;
      }
      .gsub {
        margin-left: auto;
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        font-size: 10.5px;
        color: var(--ct-text-dim);
        font-variant-numeric: tabular-nums;
      }
      .show-more {
        margin: 4px 0 8px;
        border: 0;
        background: transparent;
        padding: 2px 0;
        font-size: 11px;
        color: var(--ct-accent);
        cursor: pointer;
      }
      .show-more:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class DetectorSectionComponent implements OnInit {
  protected readonly i18n = inject(I18nService);
  private readonly store = inject(ScanStore);
  readonly detector = input.required<DetectorResult>();

  protected readonly collapsed = signal(false);
  /** open/closed per group key; seeded in ngOnInit */
  private readonly groupOpen = signal<Record<string, boolean>>({});
  /** how many rows are revealed per group key (default PAGE) */
  private readonly shown = signal<Record<string, number>>({});

  protected readonly alertingCount = computed(
    () => this.detector().items.filter((i) => i.state === 'alert' && !i.intentional).length,
  );

  protected readonly costSummary = computed<
    { amount: string | null; count: string | null; unpriced: number } | null
  >(() => {
    const r = this.detector().costRollup;
    if (r.pricedCount === 0 && r.unpricedCount === 0) return null;
    const priced = r.pricedCount > 0;
    return {
      amount: priced
        ? this.i18n.t('cost.detectorAmount', {
            amount: formatMoney(
              r.monthlyUsd,
              this.i18n.locale(),
              this.store.result()?.fxUsdBrl ?? 0,
              false,
            ),
          })
        : null,
      count: priced ? this.i18n.t('cost.detectorCount', { count: r.pricedCount }) : null,
      unpriced: r.unpricedCount,
    };
  });

  protected readonly groups = computed<Group[]>(() => {
    const items = this.detector().items;
    const out: Group[] = [];

    for (const lvl of LEVELS) {
      const g = items.filter(
        (i) => i.state === 'alert' && !i.intentional && i.confidence?.level === lvl,
      );
      if (g.length) out.push(this.mkGroup(lvl, this.i18n.t(`scan.level.${lvl}`), lvl, g));
    }
    const intentional = items.filter((i) => i.intentional);
    if (intentional.length) {
      out.push(this.mkGroup('intentional', this.i18n.t('scan.group.intentional'), null, intentional));
    }
    const neutral = items.filter((i) => i.state === 'neutral' && !i.intentional);
    if (neutral.length) {
      out.push(this.mkGroup('neutral', this.i18n.t('scan.group.neutral'), null, neutral));
    }
    return out;
  });

  ngOnInit(): void {
    const kind = this.detector().kind;
    this.collapsed.set(readFlag(collapsedKey(kind), SECTION_COLLAPSED_DEFAULT));

    const open: Record<string, boolean> = {};
    for (const g of this.groups()) {
      open[g.key] = readFlag(groupKey(kind, g.key), GROUP_OPEN_DEFAULT);
    }
    this.groupOpen.set(open);
  }

  protected toggle(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    writeFlag(collapsedKey(this.detector().kind), next);
  }

  protected isOpen(key: string): boolean {
    return this.groupOpen()[key] ?? GROUP_OPEN_DEFAULT;
  }

  protected toggleGroup(key: string): void {
    const next = !this.isOpen(key);
    this.groupOpen.update((m) => ({ ...m, [key]: next }));
    writeFlag(groupKey(this.detector().kind, key), next);
  }

  protected shownFor(key: string): number {
    return this.shown()[key] ?? PAGE;
  }

  protected showMore(key: string): void {
    this.shown.update((m) => ({ ...m, [key]: Number.MAX_SAFE_INTEGER }));
  }

  protected visible(g: Group): ResourceItem[] {
    return g.items.slice(0, this.shownFor(g.key));
  }

  protected groupSubtotal(g: Group): string | null {
    if (g.subtotalUsd <= 0) return null;
    const amount = formatMoney(
      g.subtotalUsd,
      this.i18n.locale(),
      this.store.result()?.fxUsdBrl ?? 0,
      false,
    );
    return this.i18n.t('cost.perMonth', { amount });
  }

  private mkGroup(
    key: string,
    label: string,
    levelAttr: ConfidenceLevel | null,
    items: ResourceItem[],
  ): Group {
    let subtotalUsd = 0;
    let unpricedCount = 0;
    for (const it of items) {
      const ec = it.estimatedCost;
      if (!ec) continue;
      if (ec.monthlyUsd != null) subtotalUsd += ec.monthlyUsd;
      else if (ec.unavailable) unpricedCount += 1;
    }
    return { key, label, levelAttr, items, subtotalUsd, unpricedCount };
  }
}
