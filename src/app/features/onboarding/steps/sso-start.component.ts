import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import {
  forgetSsoUrl,
  listSavedSsoUrls,
  rememberSsoUrl,
  SavedSsoUrl,
} from '../../../core/sso/saved-urls';
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

        @if (saved().length > 0) {
          <div class="recent">
            <span class="recent-label">{{ i18n.t('sso.start.recent') }}</span>
            <ul>
              @for (entry of saved(); track entry.url) {
                <li>
                  <button type="button" class="pick" (click)="use(entry)">
                    <span class="u">{{ entry.url }}</span>
                    @if (entry.region) {
                      <span class="r">{{ entry.region }}</span>
                    }
                  </button>
                  <button
                    type="button"
                    class="forget"
                    [attr.aria-label]="i18n.t('sso.start.forget')"
                    (click)="forget(entry.url)"
                  >
                    &times;
                  </button>
                </li>
              }
            </ul>
          </div>
        }

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
  styles: [
    `
      .recent {
        margin: -4px 0 12px;
      }
      .recent-label {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ct-text-faint);
      }
      .recent ul {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
      }
      .recent li {
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--ct-border-faint);
      }
      .pick {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        padding: 6px 4px;
        cursor: pointer;
        border-radius: var(--ct-radius-sm);
      }
      .pick:hover {
        background: var(--ct-inset);
      }
      .pick .u {
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pick .r {
        flex: none;
        font-size: 10.5px;
        color: var(--ct-text-faint);
      }
      .forget {
        flex: none;
        border: 0;
        background: transparent;
        color: var(--ct-text-faint);
        font-size: 14px;
        line-height: 1;
        padding: 4px 6px;
        cursor: pointer;
      }
      .forget:hover {
        color: var(--ct-text-dim);
      }
    `,
  ],
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
  protected readonly saved = signal<SavedSsoUrl[]>(listSavedSsoUrls());

  protected readonly canSubmit = computed(
    () => /^https?:\/\/.+/.test(this.startUrl().trim()) && this.region().trim().length > 0,
  );

  protected use(entry: SavedSsoUrl): void {
    this.startUrl.set(entry.url);
    if (entry.region) this.region.set(entry.region);
  }

  protected forget(url: string): void {
    forgetSsoUrl(url);
    this.saved.set(listSavedSsoUrls());
  }

  protected submit(): void {
    if (!this.canSubmit()) return;
    const url = this.startUrl().trim();
    const region = this.region().trim();
    rememberSsoUrl(url, region);
    void this.store.startSso({ startUrl: url, region });
  }
}
