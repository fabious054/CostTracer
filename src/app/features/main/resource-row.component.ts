import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { formatEventTime } from '../../core/format/event-time';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { ResourceItem } from '../../core/models/scan';

function ageInDays(unixSecs: number | null): number | null {
  if (unixSecs == null) return null;
  return Math.max(0, Math.floor(Date.now() / 1000 / 86400 - unixSecs / 86400));
}

/**
 * One resource in the inventory. Alerting rows are highlighted and carry the mandatory
 * explanation (transparency principle); neutral rows are compact and quiet (not faded — faded
 * reads as broken); intentional rows show "Ignored" instead of a level.
 */
@Component({
  selector: 'ct-resource-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    @if (item(); as it) {
      <div class="row" [attr.data-state]="rowState()">
        <div class="head">
          <span class="id">{{ it.displayName ?? it.resourceId }}</span>
          @if (it.displayName) {
            <span class="rid">{{ it.resourceId }}</span>
          }
          <span class="region">{{ it.region }}</span>
          @if (levelLabel(); as lvl) {
            <span class="badge" [attr.data-level]="it.confidence?.level">{{ lvl }}</span>
          }
        </div>

        @if (explanation(); as text) {
          <p class="explain">{{ text }}</p>
        }
        @if (neutralNoteText(); as note) {
          <p class="sub note">{{ note }}</p>
        }
        @if (factsLine(); as facts) {
          <p class="sub facts">{{ facts }}</p>
        }

        @if (it.intentional || it.state === 'alert') {
          <div class="actions">
            @if (it.intentional) {
              <span class="ignored">{{ i18n.t('scan.intentional') }}</span>
              <button type="button" class="link" (click)="store.unmarkIntentional(it)">
                {{ i18n.t('scan.undo') }}
              </button>
            } @else {
              <button type="button" class="link" (click)="store.markIntentional(it)">
                {{ i18n.t('scan.markIntentional') }}
              </button>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .row {
        padding: 8px 0 8px 12px;
        border-left: 3px solid transparent;
        border-bottom: 1px solid var(--ct-border-faint);
      }
      .row:last-child {
        border-bottom: 0;
      }
      .row[data-state='alert'] {
        border-left-color: var(--ct-warn);
        background: var(--ct-warn-bg);
      }
      .row[data-state='intentional'] {
        border-left-color: var(--ct-border-line);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .id {
        font-weight: 600;
        font-size: 12.5px;
        color: var(--ct-text);
      }
      .row[data-state='intentional'] .id {
        color: var(--ct-text-dim);
      }
      .rid,
      .region {
        font-size: 11px;
        color: var(--ct-text-faint);
      }
      .badge {
        margin-left: auto;
        flex: none;
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--ct-inset);
        color: var(--ct-text-dim);
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
      .explain {
        margin: 5px 0 0;
        font-size: 12px;
        color: var(--ct-text);
      }
      .sub {
        margin: 3px 0 0;
        font-size: 11px;
      }
      .note {
        color: var(--ct-text-dim);
      }
      .facts {
        color: var(--ct-text-faint);
      }
      .actions {
        margin-top: 7px;
        display: flex;
        align-items: baseline;
        gap: 10px;
      }
      .ignored {
        font-size: 11px;
        color: var(--ct-text-dim);
      }
      .link {
        border: 0;
        background: transparent;
        padding: 0;
        font-size: 11px;
        color: var(--ct-accent);
        cursor: pointer;
      }
      .link:hover {
        text-decoration: underline;
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

  protected readonly neutralNoteText = computed(() => {
    const n = this.item().neutralNote;
    return n ? this.i18n.t(`scan.neutralNote.${n}`) : null;
  });

  protected readonly explanation = computed(() => {
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

  protected readonly factsLine = computed(() => {
    const it = this.item();
    const f = it.facts;
    const parts: string[] = [];
    const num = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
    const str = (k: string): string | null => (typeof f[k] === 'string' ? (f[k] as string) : null);

    if (it.resourceType === 'ebs_volume') {
      const s = num('sizeGiB');
      if (s != null) parts.push(this.i18n.t('scan.fact.size', { n: s }));
      const az = str('az');
      if (az) parts.push(az);
      const t = str('type');
      if (t) parts.push(t);
    } else if (it.resourceType === 'elastic_ip') {
      const ip = str('publicIp');
      if (ip) parts.push(ip);
      parts.push(this.i18n.t('scan.fact.monitoredSince', { date: this.fmtDate(it.monitoredSince) }));
    } else {
      const s = num('sizeGiB');
      if (s != null) parts.push(this.i18n.t('scan.fact.size', { n: s }));
      const src = str('sourceVolumeId');
      if (src) parts.push(src);
      const ageDays = ageInDays(it.createdAt);
      if (ageDays != null) parts.push(this.i18n.t('scan.fact.createdAgo', { days: ageDays }));
    }
    return parts.length ? parts.join(' · ') : null;
  });

  private fmtDate(unixSecs: number): string {
    return formatEventTime(unixSecs, this.i18n.locale());
  }
}
