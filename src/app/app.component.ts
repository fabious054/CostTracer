import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  OnInit,
} from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { ConnectionStore } from './core/connection/connection.store';
import { I18nService } from './core/i18n/i18n.service';
import { ScanStore } from './core/scan/scan.store';
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
      <!-- Status seal straddling the titlebar/content divider — the one always-visible place for
           a scan-wide status. Only "partial" for now; informational, so pointer-events: none. -->
      @if (scanPartial()) {
        <span class="status-seal" role="status">
          <span aria-hidden="true">&#9888;</span> {{ i18n.t('scan.meta.partial') }}
        </span>
      }
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
        position: relative;
      }
      .status-seal {
        position: absolute;
        top: 34px; /* the ct-titlebar :host height — sits centred on the divider line */
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 20;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 12px;
        border-radius: 999px;
        border: 1px solid var(--ct-warn);
        background: var(--ct-panel);
        color: var(--ct-warn);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.03em;
        white-space: nowrap;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
        pointer-events: none; /* never intercept the titlebar drag region behind it */
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
  private readonly scan = inject(ScanStore);
  protected readonly i18n = inject(I18nService);

  /** The webview is only functional inside the Tauri window (where the IPC bridge exists). */
  protected readonly inDesktopApp = isTauri();

  /** Show the "partial" seal on the divider only for a finished scan of the connected account. */
  protected readonly scanPartial = computed(() => {
    if (this.store.state().step !== 'connected') return false;
    return this.scan.phase() !== 'scanning' && this.scan.result()?.status === 'partial';
  });

  ngOnInit(): void {
    if (this.inDesktopApp) {
      void this.store.boot();
    }
  }

  /**
   * Regaining focus is when a window is most likely to be out of step with the vault — another
   * window (or a `tauri dev` re-run) may have connected a different account while this one sat in
   * the background. Reconcile before the user acts on stale data.
   */
  @HostListener('window:focus')
  protected onFocus(): void {
    if (this.inDesktopApp) {
      void this.store.resync();
    }
  }
}
