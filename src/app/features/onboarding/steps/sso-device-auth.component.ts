import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TauriIpcService } from '../../../core/ipc/tauri-ipc.service';
import { WizardShellComponent } from '../ui/wizard-shell.component';

type CopyTarget = 'code' | 'link';

/** Step `ssoDeviceAuth`. Shows the user code + link; the store polls for the token in the background. */
@Component({
  selector: 'ct-step-sso-device-auth',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('sso.device.title')" [subtitle]="i18n.t('sso.device.subtitle')">
      @if (auth(); as a) {
        <ol class="steps">
          <li>
            <p class="label">{{ i18n.t('sso.device.step1') }}</p>
            <div class="url">{{ a.verificationUri }}</div>
            <div class="ct-row">
              <button type="button" class="ct-btn ct-btn--primary" (click)="open(a.verificationUriComplete)">
                {{ openState() === 'opening' ? i18n.t('sso.device.opening') : i18n.t('sso.device.open') }}
              </button>
              <button type="button" class="ct-btn" (click)="copy('link', a.verificationUriComplete)">
                {{ copied() === 'link' ? i18n.t('common.copied') : i18n.t('sso.device.copyLink') }}
              </button>
            </div>
            @if (openState() === 'failed') {
              <p class="ct-hint fail">{{ i18n.t('sso.device.openFailed') }}</p>
            }
          </li>

          <li>
            <p class="label">{{ i18n.t('sso.device.step2') }}</p>
            <div class="code-row">
              <span class="code">{{ a.userCode }}</span>
              <button type="button" class="ct-btn" (click)="copy('code', a.userCode)">
                {{ copied() === 'code' ? i18n.t('common.copied') : i18n.t('sso.device.copyCode') }}
              </button>
            </div>
          </li>

          <li>
            <p class="label">{{ i18n.t('sso.device.step3') }}</p>
          </li>
        </ol>

        <div class="wait">
          <span class="ct-spinner" aria-hidden="true"></span>
          <span>{{ i18n.t('sso.device.waiting') }}</span>
          <span class="expiry">{{ i18n.t('sso.device.expiresIn', { time: remaining() }) }}</span>
        </div>
      }

      <button type="button" class="ct-btn ct-btn--ghost" actions (click)="store.switchMethod()">
        {{ i18n.t('common.cancel') }}
      </button>
    </ct-wizard-shell>
  `,
  styles: [
    `
      .steps {
        margin: 0;
        padding: 0;
        list-style: none;
        counter-reset: step;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .steps li {
        counter-increment: step;
        position: relative;
        padding-left: 22px;
      }
      .steps li::before {
        content: counter(step) '.';
        position: absolute;
        left: 0;
        top: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--ct-text-faint);
      }
      .label {
        margin: 0 0 6px;
        font-size: 12.5px;
      }
      .url {
        font-family: var(--ct-mono);
        font-size: 11.5px;
        word-break: break-all;
        background: var(--ct-inset);
        border-radius: var(--ct-radius-sm);
        padding: 6px 8px;
        margin-bottom: 8px;
      }
      .code-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .code {
        font-family: var(--ct-mono);
        font-size: 17px;
        letter-spacing: 0.14em;
        background: var(--ct-inset);
        border-radius: var(--ct-radius-sm);
        padding: 5px 11px;
      }
      .wait {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--ct-text-dim);
        background: var(--ct-inset);
        border-radius: var(--ct-radius-sm);
        padding: 9px 11px;
        margin-top: 16px;
      }
      .wait .ct-spinner {
        width: 13px;
        height: 13px;
        flex: none;
      }
      .wait .expiry {
        margin-left: auto;
        color: var(--ct-text-faint);
        font-variant-numeric: tabular-nums;
      }
      .fail {
        color: var(--ct-warn);
        margin: 6px 0 0;
      }
    `,
  ],
})
export class SsoDeviceAuthComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);
  private readonly ipc = inject(TauriIpcService);
  private readonly now = signal(Date.now());

  protected readonly copied = signal<CopyTarget | null>(null);
  protected readonly openState = signal<'idle' | 'opening' | 'failed'>('idle');

  constructor() {
    const id = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  protected readonly auth = computed(() => {
    const s = this.store.state();
    return s.step === 'ssoDeviceAuth' ? s.auth : null;
  });

  protected readonly remaining = computed(() => {
    const a = this.auth();
    if (!a) return '—';
    const secs = Math.max(0, Math.round((a.expiresAt - this.now()) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  });

  protected async open(url: string): Promise<void> {
    this.openState.set('opening');
    try {
      await this.ipc.call('open_url', { url });
      this.openState.set('idle');
    } catch {
      this.openState.set('failed');
    }
  }

  protected async copy(target: CopyTarget, text: string): Promise<void> {
    try {
      await writeText(text);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
    }
    this.copied.set(target);
    setTimeout(() => this.copied.set(null), 2000);
  }
}
