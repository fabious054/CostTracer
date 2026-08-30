import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { RegionScanState } from '../../core/models/scan';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { ScanPanelComponent } from './scan-panel.component';

const GLYPH: Record<RegionScanState | 'pending', string> = {
  running: '…',
  done: '✓',
  partial: '⚠',
  skipped: '–',
  pending: '·',
};

/**
 * The `connected` view — the app proper. A slim account bar plus the scan panel. Wider than the
 * onboarding wizard shell, because the inventory needs the room.
 */
@Component({
  selector: 'ct-main-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScanPanelComponent, TooltipDirective],
  template: `
    @if (account(); as a) {
      <header class="bar">
        <div class="acct-block">
          <span class="acct">{{ i18n.t('scan.accountBar', { account: a.accountId }) }}</span>
          @if (a.regionsDiscovered) {
            <span class="regions" [ctTooltip]="regionsTooltip()" tabindex="0">
              {{ i18n.t('account.regionCount', { n: a.regions.length }) }}
            </span>
          } @else {
            <span
              class="regions regions--unknown"
              [ctTooltip]="i18n.t('account.regionsUnknown.hint')"
              tabindex="0"
            >
              {{ i18n.t('account.regionsUnknown') }}
            </span>
          }
        </div>
        <button type="button" class="ct-btn ct-btn--ghost" (click)="disconnect()">
          {{ i18n.t('account.disconnect') }}
        </button>
      </header>

      <main class="body">
        <ct-scan-panel />
      </main>
    }
  `,
  styles: [
    `
      .bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 20px;
        border-bottom: 1px solid var(--ct-border-faint);
        background: var(--ct-panel);
      }
      .acct-block {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .acct {
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .regions {
        font-size: 10px;
        color: var(--ct-text-faint);
        cursor: help;
        white-space: nowrap;
        align-self: flex-start;
      }
      /* Discovery failed at connect time — the region count is not a real fact about the account. */
      .regions--unknown {
        color: var(--ct-warn);
      }
      .bar .ct-btn {
        margin-left: auto;
      }
      .body {
        max-width: 640px;
        margin: 0 auto;
        padding: 22px 24px 40px;
        /* Expanding a confidence group inserts rows; without this the browser's scroll
           anchoring compensates and the whole view jumps to keep lower content in place.
           Opting the scan subtree out keeps the clicked group exactly where it was. */
        overflow-anchor: none;
      }
    `,
  ],
})
export class MainViewComponent {
  protected readonly i18n = inject(I18nService);
  private readonly connection = inject(ConnectionStore);
  private readonly scan = inject(ScanStore);

  protected readonly account = computed(() => {
    const s = this.connection.state();
    return s.step === 'connected' ? s.account : null;
  });

  /** One region per line with a status glyph — reflects the scan's per-region progress. */
  protected readonly regionsTooltip = computed(() => {
    const a = this.account();
    if (!a) return '';
    const st = this.scan.regionStatus();
    return [...a.regions]
      .sort()
      .map((r) => `${GLYPH[st[r] ?? 'pending']}  ${r}`)
      .join('\n');
  });

  protected disconnect(): void {
    void this.connection.disconnect();
  }
}
