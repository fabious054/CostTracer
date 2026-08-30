import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanPanelComponent } from './scan-panel.component';

/**
 * The `connected` view — the app proper. A slim account bar plus the scan panel. Wider than the
 * onboarding wizard shell, because the inventory needs the room.
 */
@Component({
  selector: 'ct-main-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScanPanelComponent],
  template: `
    @if (account(); as a) {
      <header class="bar">
        <span class="acct">{{ i18n.t('scan.accountBar', { account: a.accountId }) }}</span>
        <span class="regions">{{ a.regions.join(' · ') }}</span>
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
        padding: 8px 20px;
        border-bottom: 1px solid var(--ct-border-faint);
        background: var(--ct-panel);
      }
      .acct {
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .regions {
        font-size: 11px;
        color: var(--ct-text-faint);
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

  protected readonly account = computed(() => {
    const s = this.connection.state();
    return s.step === 'connected' ? s.account : null;
  });

  protected disconnect(): void {
    void this.connection.disconnect();
  }
}
