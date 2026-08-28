import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { RegionFieldComponent } from '../ui/region-field.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

/**
 * Step `methodSelect`. Up to three routes; none is presented as recommended. The "detected"
 * card renders only when the silent scan found something.
 */
@Component({
  selector: 'ct-step-method-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, FormsModule, RegionFieldComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('method.title')" [subtitle]="i18n.t('method.subtitle')">
      @if (view(); as v) {
        @if (v.notice) {
          <div class="ct-alert ct-alert--warning" role="status">{{ i18n.t(v.notice) }}</div>
        }

        <div class="cards">
          @if (v.detected; as d) {
            <article class="card">
              <h2>{{ i18n.t('method.detected.heading') }}</h2>
              <p class="ct-muted found">
                {{ i18n.t('method.detected.found') }}
                {{ d.hasEnvCredentials ? 'environment variables · ' : '' }}
                {{ d.hasSharedCredentialsFile ? '~/.aws/credentials · ' : '' }}
                {{ d.hasConfigFile ? '~/.aws/config' : '' }}
              </p>

              @if (d.profiles.length > 0) {
                <label class="ct-field">
                  <span>{{ i18n.t('method.detected.profile') }}</span>
                  <select [(ngModel)]="profile">
                    @for (p of d.profiles; track p) {
                      <option [value]="p">{{ p }}</option>
                    }
                  </select>
                </label>
              }

              <ct-region-field
                [label]="i18n.t('region.label')"
                [placeholder]="i18n.t('region.placeholder')"
                [value]="region()"
                (valueChange)="region.set($event)"
              />

              <button type="button" class="ct-btn ct-btn--primary ct-btn--block" (click)="useDetected()">
                {{ i18n.t('method.detected.use') }}
              </button>
            </article>
          }

          <article class="card">
            <h2>{{ i18n.t('method.manual.heading') }}</h2>
            <p class="ct-muted">{{ i18n.t('method.manual.desc') }}</p>
            <button type="button" class="ct-btn ct-btn--block" (click)="store.chooseManual()">
              {{ i18n.t('method.manual.cta') }}
            </button>
          </article>

          <article class="card">
            <h2>{{ i18n.t('method.sso.heading') }}</h2>
            <p class="ct-muted">{{ i18n.t('method.sso.desc') }}</p>
            <button type="button" class="ct-btn ct-btn--block" (click)="store.chooseSso()">
              {{ i18n.t('method.sso.cta') }}
            </button>
          </article>
        </div>
      }
    </ct-wizard-shell>
  `,
  styles: [
    `
      .cards {
        display: flex;
        flex-direction: column;
      }
      .card {
        padding: 14px 0;
      }
      .card + .card {
        border-top: 1px solid var(--ct-border-faint);
      }
      h2 {
        font-size: 12.5px;
        font-weight: 600;
        margin: 0 0 3px;
      }
      p {
        margin: 0 0 9px;
        font-size: 12px;
        color: var(--ct-text-dim);
      }
      .found {
        font-size: 11.5px;
      }
      select {
        padding: 7px 9px;
        border-radius: var(--ct-radius-sm);
        border: 1px solid var(--ct-border-line);
        background: var(--ct-bg);
        color: var(--ct-text);
        font: inherit;
      }
      .ct-alert {
        margin-bottom: 12px;
      }
    `,
  ],
})
export class MethodSelectComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly view = computed(() => {
    const s = this.store.state();
    return s.step === 'methodSelect' ? s : null;
  });

  protected readonly profile = signal<string>(this.initialProfile());
  protected readonly region = signal<string>(this.view()?.detected?.defaultRegion ?? '');

  private initialProfile(): string {
    const s = this.store.state();
    return s.step === 'methodSelect' ? (s.detected?.profiles[0] ?? '') : '';
  }

  protected useDetected(): void {
    const profile = this.profile().trim() || null;
    const region = this.region().trim() || null;
    void this.store.useDetected(profile, region);
  }
}
