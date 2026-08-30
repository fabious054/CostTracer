import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { ConnectionStore } from './core/connection/connection.store';
import { I18nService } from './core/i18n/i18n.service';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { TitlebarComponent } from './features/shell/titlebar.component';

@Component({
  selector: 'ct-root',
  imports: [OnboardingComponent, TitlebarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inDesktopApp) {
      <ct-titlebar />
      <div class="content">
        <ct-onboarding />
      </div>
    } @else {
      <main class="browser-notice">
        <h1>{{ i18n.t('browser.title') }}</h1>
        <p>{{ i18n.t('browser.body') }}</p>
        <p class="ct-muted">{{ i18n.t('browser.hint') }}</p>
      </main>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
      }
      .content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        /* No scroll-anchoring compensation anywhere in the app — expanding/collapsing content
           (confidence groups, detector panels) must not move the viewport. */
        overflow-anchor: none;
        /* Reserve the scrollbar's width on both sides whether or not it's showing, so expanding
           an item never shoves rows sideways and the content stays symmetric either way. */
        scrollbar-gutter: stable both-edges;
      }
      .browser-notice {
        max-width: 460px;
        margin: 15vh auto 0;
        padding: 24px;
        text-align: center;
      }
      h1 {
        font-size: 18px;
      }
      code {
        background: var(--ct-inset);
        padding: 1px 5px;
        border-radius: 5px;
        font-size: 0.9em;
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  private readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  /** The webview is only functional inside the Tauri window (where the IPC bridge exists). */
  protected readonly inDesktopApp = isTauri();

  ngOnInit(): void {
    if (this.inDesktopApp) {
      void this.store.boot();
    }
  }
}
