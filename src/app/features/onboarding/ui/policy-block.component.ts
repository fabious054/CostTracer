import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { I18nService } from '../../../core/i18n/i18n.service';

/**
 * Renders the minimal IAM policy JSON with a Copy button. Copy places the text on the OS
 * clipboard only — it never touches the user's AWS account.
 */
@Component({
  selector: 'ct-policy-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="bar">
        <span class="ct-muted">{{ i18n.t('policy.heading') }}</span>
        <button type="button" class="ct-btn ct-btn--ghost" (click)="copy()">
          {{
            state() === 'copied'
              ? i18n.t('policy.copied')
              : state() === 'failed'
                ? i18n.t('policy.copyFailed')
                : i18n.t('policy.copy')
          }}
        </button>
      </div>
      <pre><code>{{ policy() }}</code></pre>
      <p class="ct-muted note">{{ i18n.t('policy.note') }}</p>
    </div>
  `,
  styles: [
    `
      .wrap {
        border: 1px solid var(--ct-border);
        border-radius: var(--ct-radius);
        overflow: hidden;
      }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 6px 6px 12px;
        background: var(--ct-surface);
        border-bottom: 1px solid var(--ct-border);
        font-size: 12px;
      }
      pre {
        margin: 0;
        padding: 12px;
        overflow-x: auto;
        font-size: 12px;
        line-height: 1.45;
        max-height: 260px;
      }
      .note {
        margin: 0;
        padding: 8px 12px;
        font-size: 11px;
        border-top: 1px solid var(--ct-border);
      }
    `,
  ],
})
export class PolicyBlockComponent {
  protected readonly i18n = inject(I18nService);
  readonly policy = input.required<string>();
  readonly state = signal<'idle' | 'copied' | 'failed'>('idle');

  async copy(): Promise<void> {
    const text = this.policy();
    try {
      await writeText(text);
      this.flash('copied');
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        this.flash('copied');
      } catch {
        this.flash('failed');
      }
    }
  }

  private flash(next: 'copied' | 'failed'): void {
    this.state.set(next);
    setTimeout(() => this.state.set('idle'), 2000);
  }
}
