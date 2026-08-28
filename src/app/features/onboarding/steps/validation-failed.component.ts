import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { MessageKey } from '../../../core/i18n/messages';
import { WizardShellComponent } from '../ui/wizard-shell.component';

/**
 * Step `validationFailed`. Stays on this screen (never bounces to method selection on its own).
 * Copy is specific to `kind`. `v.message` comes verbatim from the Rust core / AWS — not translated.
 */
@Component({
  selector: 'ct-step-validation-failed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent],
  template: `
    @if (view(); as v) {
      <ct-wizard-shell
        [title]="i18n.t(v.kind === 'insufficient-permission' ? 'failed.title.insufficient' : 'failed.title.invalid')"
      >
        <div class="ct-alert ct-alert--danger" role="alert">
          <strong>
            {{
              i18n.t(
                v.kind === 'insufficient-permission' ? 'failed.strong.insufficient' : 'failed.strong.invalid'
              )
            }}
          </strong>
          {{ v.message }}
        </div>

        <p class="ct-muted hint">
          {{ i18n.t(v.kind === 'insufficient-permission' ? 'failed.hint.insufficient' : 'failed.hint.invalid') }}
        </p>

        <div class="ct-row">
          <button type="button" class="ct-btn ct-btn--primary" (click)="store.retry()">
            {{ i18n.t('failed.retry') }}
          </button>
          <button type="button" class="ct-btn ct-btn--ghost" (click)="store.switchMethod()">
            {{ i18n.t('failed.switch') }}
          </button>
        </div>

        <p class="ct-muted src">{{ i18n.t('failed.method', { method: i18n.t(sourceKey(v.sourceKind)) }) }}</p>
      </ct-wizard-shell>
    }
  `,
  styles: [
    `
      .hint {
        font-size: 12px;
        margin: 10px 0 18px;
      }
      .src {
        font-size: 11.5px;
        margin: 16px 0 0;
      }
    `,
  ],
})
export class ValidationFailedComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly view = computed(() => {
    const s = this.store.state();
    return s.step === 'validationFailed' ? s : null;
  });

  protected sourceKey(kind: 'detected' | 'manual' | 'sso'): MessageKey {
    return kind === 'detected' ? 'source.detected' : kind === 'manual' ? 'source.manual' : 'source.sso';
  }
}
