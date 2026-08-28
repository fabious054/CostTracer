import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { RegionFieldComponent } from '../ui/region-field.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

/** Step `ssoStart`. Collects the IAM Identity Center start URL + region, then begins device auth. */
@Component({
  selector: 'ct-step-sso-start',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, FormsModule, RegionFieldComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('sso.start.title')">
      @if (notice(); as n) {
        <div class="ct-alert ct-alert--danger" role="alert">{{ i18n.t(n) }}</div>
      }

      <form (ngSubmit)="submit()">
        <label class="ct-field">
          <span>{{ i18n.t('sso.start.url') }}</span>
          <input
            type="url"
            autocomplete="off"
            spellcheck="false"
            [(ngModel)]="startUrl"
            name="startUrl"
            placeholder="https://my-org.awsapps.com/start"
          />
        </label>

        <ct-region-field
          [label]="i18n.t('region.ssoLabel')"
          [placeholder]="i18n.t('region.placeholder')"
          [value]="region()"
          (valueChange)="region.set($event)"
        />

        <div class="ct-row">
          <button type="submit" class="ct-btn ct-btn--primary" [disabled]="!canSubmit()">
            {{ i18n.t('sso.start.continue') }}
          </button>
          <button type="button" class="ct-btn ct-btn--ghost" (click)="store.switchMethod()">
            {{ i18n.t('common.back') }}
          </button>
        </div>
      </form>
    </ct-wizard-shell>
  `,
})
export class SsoStartComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly notice = computed(() => {
    const s = this.store.state();
    return s.step === 'ssoStart' ? s.notice : null;
  });

  protected readonly startUrl = signal('');
  protected readonly region = signal('');

  protected readonly canSubmit = computed(
    () => /^https?:\/\/.+/.test(this.startUrl().trim()) && this.region().trim().length > 0,
  );

  protected submit(): void {
    if (!this.canSubmit()) return;
    void this.store.startSso({ startUrl: this.startUrl().trim(), region: this.region().trim() });
  }
}
