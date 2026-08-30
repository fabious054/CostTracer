import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { WizardShellComponent } from '../ui/wizard-shell.component';

/** Step `manualEntry`. Access Key ID + Secret + optional session token. The scan discovers the
 *  account's regions itself (Scope 4), so there is no region field. */
@Component({
  selector: 'ct-step-manual-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, FormsModule],
  template: `
    <ct-wizard-shell [title]="i18n.t('manual.title')" [subtitle]="i18n.t('manual.subtitle')">
      <form (ngSubmit)="submit()">
        <label class="ct-field">
          <span>{{ i18n.t('manual.accessKeyId') }}</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            [(ngModel)]="accessKeyId"
            name="accessKeyId"
            placeholder="AKIA… / ASIA…"
          />
        </label>

        <label class="ct-field">
          <span class="label-row">
            {{ i18n.t('manual.secret') }}
            <button type="button" class="reveal" (click)="reveal.set(!reveal())">
              {{ reveal() ? i18n.t('manual.hide') : i18n.t('manual.show') }}
            </button>
          </span>
          <input
            [type]="reveal() ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            [(ngModel)]="secretAccessKey"
            name="secretAccessKey"
          />
        </label>

        <label class="ct-field">
          <span>{{ i18n.t('manual.sessionToken') }}{{ tokenRequired() ? '' : ' (' + i18n.t('common.optional') + ')' }}</span>
          <input
            [type]="reveal() ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            [(ngModel)]="sessionToken"
            name="sessionToken"
          />
          <span class="ct-hint">
            {{ tokenRequired() ? i18n.t('manual.sessionToken.required') : i18n.t('manual.sessionToken.optional') }}
          </span>
        </label>

        <div class="ct-row">
          <button type="submit" class="ct-btn ct-btn--primary" [disabled]="!canSubmit()">
            {{ i18n.t('manual.validate') }}
          </button>
          <button type="button" class="ct-btn ct-btn--ghost" (click)="store.switchMethod()">
            {{ i18n.t('common.back') }}
          </button>
        </div>
      </form>
    </ct-wizard-shell>
  `,
  styles: [
    `
      .label-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .reveal {
        border: 0;
        background: transparent;
        color: var(--ct-text-dim);
        font-size: 11px;
        font-weight: 500;
        padding: 0;
        cursor: pointer;
      }
      .reveal:hover {
        color: var(--ct-text);
      }
    `,
  ],
})
export class ManualEntryComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly accessKeyId = signal('');
  protected readonly secretAccessKey = signal('');
  protected readonly sessionToken = signal('');
  protected readonly reveal = signal(false);

  /** `ASIA` prefix ⇒ temporary credential ⇒ a session token is mandatory. */
  protected readonly tokenRequired = computed(() =>
    this.accessKeyId().trim().toUpperCase().startsWith('ASIA'),
  );

  protected readonly canSubmit = computed(() => {
    const hasKeys =
      this.accessKeyId().trim().length > 0 && this.secretAccessKey().trim().length > 0;
    return hasKeys && (!this.tokenRequired() || this.sessionToken().trim().length > 0);
  });

  protected submit(): void {
    if (!this.canSubmit()) return;
    void this.store.submitManual({
      accessKeyId: this.accessKeyId().trim(),
      secretAccessKey: this.secretAccessKey().trim(),
      sessionToken: this.sessionToken().trim() || null,
    });
  }
}
