import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';

/**
 * Shared chrome for every onboarding step. Deliberately quiet: no card fill, a single hairline,
 * generous outer whitespace. Content density lives inside the body.
 */
@Component({
  selector: 'ct-wizard-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="shell">
      <section class="panel" role="region" [attr.aria-label]="title()">
        <header>
          <h1>{{ title() }}</h1>
          @if (subtitle()) {
            <p class="subtitle">{{ subtitle() }}</p>
          }
        </header>
        <div class="body">
          <ng-content />
        </div>
        <footer class="actions">
          <ng-content select="[actions]" />
        </footer>
      </section>
      <p class="brand">CostTracer · {{ i18n.t('brand.tagline') }}</p>
    </main>
  `,
  styles: [
    `
      .shell {
        min-height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 40px 24px;
      }
      .panel {
        width: 100%;
        max-width: 420px;
        background: var(--ct-panel);
        border: 1px solid var(--ct-border-faint);
        border-radius: var(--ct-radius);
        padding: 20px;
      }
      h1 {
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        letter-spacing: -0.01em;
      }
      .subtitle {
        margin: 3px 0 0;
        color: var(--ct-text-dim);
        font-size: 12px;
      }
      .body {
        margin-top: 16px;
      }
      .actions {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .actions:empty {
        display: none;
      }
      .brand {
        margin: 0;
        color: var(--ct-text-faint);
        font-size: 10.5px;
        letter-spacing: 0.02em;
      }
    `,
  ],
})
export class WizardShellComponent {
  protected readonly i18n = inject(I18nService);
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
}
