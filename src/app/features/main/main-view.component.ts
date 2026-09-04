import { ChangeDetectionStrategy, Component, computed, inject, isDevMode } from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { PricingStore } from '../../core/pricing/pricing.store';
import { ScanStore } from '../../core/scan/scan.store';
import { RegionScanState } from '../../core/models/scan';
import { FloatingNoticeComponent } from '../../shared/floating-notice.component';
import { GearMenuComponent, GearMenuItem } from '../../shared/gear-menu.component';
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
  imports: [ScanPanelComponent, TooltipDirective, FloatingNoticeComponent, GearMenuComponent],
  template: `
    @if (account(); as a) {
      <header class="bar">
        @if (scanPartial()) {
          <span class="status-flag" [ctTooltip]="i18n.t('scan.meta.partial.hint')" tabindex="0">
            <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4" />
              <circle cx="8" cy="5" r="1" fill="currentColor" />
              <path d="M8 7.4 V12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            {{ i18n.t('scan.meta.partial') }}
          </span>
        }
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
        <div class="bar-actions">
          <button type="button" class="ct-btn ct-btn--ghost" (click)="disconnect()">
            {{ i18n.t('account.disconnect') }}
          </button>
          <ct-gear-menu
            [items]="menuItems()"
            [label]="i18n.t('settings.menu')"
            [emptyLabel]="i18n.t('settings.empty')"
          />
        </div>
      </header>

      <!-- Background price/FX refresh (ADR 0006) — the standard floating notice, shown only
           while fetching, so it never adds to the clutter in the scan/cost area. -->
      @if (pricing.refreshing()) {
        <ct-floating-notice [busy]="true">{{ i18n.t('pricing.refreshing') }}</ct-floating-notice>
      }

      <main class="body">
        <ct-scan-panel />
      </main>
    }
  `,
  styles: [
    `
      .bar {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 20px;
        border-bottom: 1px solid var(--ct-border-faint);
        background: var(--ct-panel);
      }
      /* Same treatment as the "approx FX" flag on the cost card — only the anchor differs:
         it straddles the header's bottom border, centred, instead of the card's top border. */
      .status-flag {
        position: absolute;
        bottom: -8px;
        left: 50%;
        transform: translateX(-50%);
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
      .status-flag .i {
        width: 9px;
        height: 9px;
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
      .bar-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 8px;
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
  protected readonly pricing = inject(PricingStore);
  private readonly connection = inject(ConnectionStore);
  private readonly scan = inject(ScanStore);

  protected readonly account = computed(() => {
    const s = this.connection.state();
    return s.step === 'connected' ? s.account : null;
  });

  /** The last finished scan of the connected account failed in one or more regions. */
  protected readonly scanPartial = computed(
    () => this.scan.phase() !== 'scanning' && this.scan.result()?.status === 'partial',
  );

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

  /**
   * The header gear menu. The gear itself is permanent — it will hold real user settings later.
   * For now its only entries are the two DEV-ONLY aids (fixture scan, pin the price strip),
   * added only in a debug build; a release build shows the gear with an empty-state line.
   */
  protected readonly menuItems = computed<GearMenuItem[]>(() => {
    const items: GearMenuItem[] = [];
    // ── real user settings go here ──
    if (isDevMode()) {
      items.push(
        { label: 'seed demo', run: () => void this.scan.seedDemo() },
        {
          label: this.pricing.pinned() ? 'unpin price strip' : 'pin price strip',
          run: () => this.pricing.togglePinned(),
        },
      );
    }
    return items;
  });
}
