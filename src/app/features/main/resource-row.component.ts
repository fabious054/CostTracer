import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { formatEventTime } from '../../core/format/event-time';
import { formatMoney } from '../../core/format/cost';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { ResourceItem } from '../../core/models/scan';

function ageInDays(unixSecs: number | null): number | null {
  if (unixSecs == null) return null;
  return Math.max(0, Math.floor(Date.now() / 1000 / 86400 - unixSecs / 86400));
}

/**
 * One resource in the inventory, compact — a header line (name · region · level · cost · action)
 * and a single dim detail line that folds the mandatory explanation, the facts, and any cost
 * caveats together. Rows are grouped by confidence level in the parent section.
 */
@Component({
  selector: 'ct-resource-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    @if (item(); as it) {
      <div class="row" [attr.data-state]="rowState()" [attr.data-level]="it.confidence?.level">
        <div class="head">
          <span class="name" [title]="it.resourceId">{{ it.displayName ?? it.resourceId }}</span>
          <span class="region">{{ it.region }}</span>
          @if (levelLabel(); as lvl) {
            <span class="badge" [attr.data-level]="it.confidence?.level">{{ lvl }}</span>
          }
          @if (it.intentional) {
            <span class="badge ignored">{{ i18n.t('scan.intentional.short') }}</span>
          }
          <span class="spacer"></span>
          @if (costChip(); as c) {
            <span class="cost" [title]="c.title">{{ c.text }}</span>
          }
        </div>

        @if (detailLine(); as d) {
          <p class="detail">{{ d }}</p>
        }

        @if (it.intentional) {
          <button type="button" class="link action" (click)="store.unmarkIntentional(it)">
            {{ i18n.t('scan.undo') }}
          </button>
        } @else if (it.state === 'alert') {
          <button type="button" class="link action" (click)="store.markIntentional(it)">
            {{ i18n.t('scan.markIntentional') }}
          </button>
        }
      </div>
    }
  `,
  styles: [
    `
      .row {
        padding: 9px 8px 9px 11px;
        border-left: 2px solid transparent;
        border-bottom: 1px solid var(--ct-border-line);
      }
      .row:last-child {
        border-bottom: 0;
      }
      .row:hover {
        background-color: var(--ct-inset);
      }
      /* Alert rows: a thin left edge plus a soft tint that fades out ~40% across — enough to
         mark the row without flooding it (a solid fill read as noise once grouped). */
      .row[data-state='alert'][data-level='confirmed'] {
        border-left-color: var(--ct-danger);
        background-image: linear-gradient(
          to right,
          color-mix(in srgb, var(--ct-danger) 10%, transparent),
          transparent 40%
        );
      }
      .row[data-state='alert'][data-level='probable'],
      .row[data-state='alert'][data-level='persisting'] {
        border-left-color: var(--ct-warn);
        background-image: linear-gradient(
          to right,
          color-mix(in srgb, var(--ct-warn) 10%, transparent),
          transparent 40%
        );
      }
      .row[data-state='alert'][data-level='observed'] {
        border-left-color: var(--ct-border-line);
      }
      .row[data-state='intentional'] {
        border-left-color: var(--ct-border-faint);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }
      .name {
        flex: 0 1 auto;
        min-width: 3ch;
        font-weight: 600;
        font-size: 12px;
        color: var(--ct-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row[data-state='intentional'] .name {
        color: var(--ct-text-dim);
      }
      .region {
        font-size: 10.5px;
        color: var(--ct-text-faint);
        white-space: nowrap;
        flex: none;
      }
      .badge {
        flex: none;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--ct-inset);
        color: var(--ct-text-dim);
        white-space: nowrap;
      }
      .badge[data-level='persisting'],
      .badge[data-level='probable'] {
        background: var(--ct-warn-bg);
        color: var(--ct-warn);
      }
      .badge[data-level='confirmed'] {
        background: var(--ct-danger-bg);
        color: var(--ct-danger);
      }
      .badge.ignored {
        background: var(--ct-inset);
        color: var(--ct-text-faint);
      }
      .spacer {
        flex: 1;
      }
      .cost {
        flex: none;
        font-size: 11px;
        color: var(--ct-text-dim);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .link {
        border: 0;
        background: transparent;
        padding: 0;
        font-size: 10.5px;
        color: var(--ct-accent);
        cursor: pointer;
        white-space: nowrap;
      }
      .link:hover {
        text-decoration: underline;
      }
      .detail {
        margin: 2px 0 0;
        font-size: 10.5px;
        line-height: 1.35;
        color: var(--ct-text-faint);
      }
      .action {
        display: inline-block;
        margin-top: 4px;
      }
    `,
  ],
})
export class ResourceRowComponent {
  protected readonly i18n = inject(I18nService);
  protected readonly store = inject(ScanStore);

  readonly item = input.required<ResourceItem>();

  protected readonly rowState = computed(() => {
    const it = this.item();
    if (it.intentional) return 'intentional';
    return it.state; // 'alert' | 'neutral'
  });

  protected readonly levelLabel = computed(() => {
    const c = this.item().confidence;
    return c ? this.i18n.t(`scan.level.${c.level}`) : null;
  });

  private readonly neutralNoteText = computed(() => {
    const n = this.item().neutralNote;
    return n ? this.i18n.t(`scan.neutralNote.${n}`) : null;
  });

  private readonly explanation = computed(() => {
    const it = this.item();
    if (it.state !== 'alert' || it.intentional || !it.confidence) return null;
    const days = it.confidence.daysCoverage;

    switch (it.resourceType) {
      case 'ebs_volume': {
        const ageDays = ageInDays(it.createdAt);
        return ageDays === null
          ? this.i18n.t('scan.explain.ebs.noAge', { days })
          : this.i18n.t('scan.explain.ebs', { days, ageDays });
      }
      case 'elastic_ip':
        return this.i18n.t('scan.explain.eip', { days, date: this.fmtDate(it.monitoredSince) });
      case 'ebs_snapshot':
        return this.i18n.t('scan.explain.snapshot', { days });
      default:
        return null;
    }
  });

  private readonly factsLine = computed(() => {
    const it = this.item();
    const f = it.facts;
    const parts: string[] = [];
    const num = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
    const str = (k: string): string | null => (typeof f[k] === 'string' ? (f[k] as string) : null);

    if (it.resourceType === 'ebs_volume') {
      const s = num('sizeGiB');
      if (s != null) parts.push(this.i18n.t('scan.fact.size', { n: s }));
      const t = str('type');
      if (t) parts.push(t);
    } else if (it.resourceType === 'elastic_ip') {
      const ip = str('publicIp');
      if (ip) parts.push(ip);
    } else {
      const s = num('sizeGiB');
      if (s != null) parts.push(this.i18n.t('scan.fact.size', { n: s }));
      const src = str('sourceVolumeId');
      if (src) parts.push(src);
    }
    return parts.length ? parts.join(' · ') : null;
  });

  private readonly costQualifiers = computed(() => {
    const ec = this.item().estimatedCost;
    if (!ec || ec.qualifiers.length === 0) return [] as string[];
    return ec.qualifiers.map((q) => this.i18n.t('cost.qualifier.' + q));
  });

  protected readonly detailLine = computed(() => {
    const parts: string[] = [];
    const ex = this.explanation();
    if (ex) parts.push(ex);
    const note = this.neutralNoteText();
    if (note) parts.push(note);
    const facts = this.factsLine();
    if (facts) parts.push(facts);
    parts.push(...this.costQualifiers());
    return parts.length ? parts.join(' · ') : null;
  });

  protected readonly costChip = computed(() => {
    const ec = this.item().estimatedCost;
    if (!ec) return null;
    const region = this.item().region;
    if (ec.unavailable) {
      return {
        text: this.i18n.t('cost.unavailableShort', { region }),
        title: this.i18n.t('cost.unavailable', { region }),
      };
    }
    if (ec.monthlyUsd === null) return null;
    const amount = formatMoney(ec.monthlyUsd, this.i18n.locale(), this.store.result()?.fxUsdBrl ?? 0);
    return {
      text: this.i18n.t('cost.perMonth', { amount }),
      title: this.i18n.t('cost.perResource', { amount }),
    };
  });

  private fmtDate(unixSecs: number): string {
    return formatEventTime(unixSecs, this.i18n.locale());
  }
}
