import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { MessageKey } from '../../core/i18n/messages';
import { WizardShellComponent } from '../onboarding/ui/wizard-shell.component';

/**
 * Step `connected` — the final screen for Scope 1. Account ID and region(s) only. No resource
 * counts or scan data (that is Scope 2).
 */
@Component({
  selector: 'ct-account-info',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent],
  template: `
    @if (account(); as a) {
      <ct-wizard-shell [title]="i18n.t('account.title')" [subtitle]="i18n.t('account.subtitle')">
        <dl class="ct-kv">
          <dt>{{ i18n.t('account.accountId') }}</dt>
          <dd>{{ a.accountId }}</dd>

          <dt>{{ i18n.t(a.regions.length > 1 ? 'account.regions' : 'account.region') }}</dt>
          <dd>{{ a.regions.join(', ') }}</dd>

          <dt>{{ i18n.t('account.signedInAs') }}</dt>
          <dd class="arn">{{ a.arn }}</dd>

          <dt>{{ i18n.t('account.via') }}</dt>
          <dd>{{ i18n.t(sourceKey(a.sourceKind)) }}</dd>
        </dl>

        <div class="ct-row">
          <button type="button" class="ct-btn ct-btn--ghost" (click)="disconnect()">
            {{ i18n.t('account.disconnect') }}
          </button>
        </div>
      </ct-wizard-shell>
    }
  `,
  styles: [
    `
      .ct-kv {
        margin: 0 0 4px;
      }
      .arn {
        word-break: break-all;
        font-size: 12px;
      }
    `,
  ],
})
export class AccountInfoComponent {
  private readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly account = computed(() => {
    const s = this.store.state();
    return s.step === 'connected' ? s.account : null;
  });

  protected sourceKey(kind: 'detected' | 'manual' | 'sso'): MessageKey {
    return kind === 'detected'
      ? 'source.detected.title'
      : kind === 'manual'
        ? 'source.manual.title'
        : 'source.sso.title';
  }

  protected disconnect(): void {
    void this.store.disconnect();
  }
}
