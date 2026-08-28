import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { I18nService } from '../../core/i18n/i18n.service';
import { Locale } from '../../core/i18n/messages';

/**
 * Custom window chrome — the native Windows title bar is disabled (`decorations: false`).
 * The `.drag` area moves the window (`data-tauri-drag-region`, double-click maximizes);
 * the three controls are real buttons outside the drag region.
 */
@Component({
  selector: 'ct-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <div class="drag" data-tauri-drag-region>
        <span class="mark" aria-hidden="true"></span>
        <span class="name">CostTracer</span>
      </div>
      <div class="lang" role="group" aria-label="Language">
        @for (l of i18n.locales; track l) {
          <button
            type="button"
            class="lang-opt"
            [class.on]="i18n.locale() === l"
            (click)="setLocale(l)"
          >
            {{ l.toUpperCase() }}
          </button>
        }
      </div>

      <div class="controls">
        <button type="button" class="ctl" aria-label="Minimize" (click)="minimize()">
          <svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" /></svg>
        </button>
        <button type="button" class="ctl" [attr.aria-label]="maximized() ? 'Restore' : 'Maximize'" (click)="toggleMaximize()">
          @if (maximized()) {
            <svg viewBox="0 0 10 10">
              <rect x="1" y="3" width="6" height="6" rx="0.6" />
              <path d="M3.4 3 V1.4 H9 V7 H7.2" />
            </svg>
          } @else {
            <svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="0.6" /></svg>
          }
        </button>
        <button type="button" class="ctl ctl--close" aria-label="Close" (click)="close()">
          <svg viewBox="0 0 10 10"><path d="M1.2 1.2 L8.8 8.8 M8.8 1.2 L1.2 8.8" /></svg>
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .bar {
        display: flex;
        align-items: stretch;
        height: 34px;
        background: var(--ct-chrome);
        user-select: none;
        -webkit-user-select: none;
      }
      .drag {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding-left: 12px;
        min-width: 0;
      }
      .mark {
        width: 12px;
        height: 12px;
        border-radius: 3px;
        background: linear-gradient(
          135deg,
          var(--ct-accent),
          color-mix(in srgb, var(--ct-accent) 45%, var(--ct-ok))
        );
      }
      .name {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--ct-text-dim);
        white-space: nowrap;
      }
      .lang {
        display: flex;
        align-items: center;
        gap: 1px;
        padding: 0 8px;
      }
      .lang-opt {
        border: 0;
        background: transparent;
        color: var(--ct-text-faint);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 3px 5px;
        border-radius: var(--ct-radius-sm);
        cursor: pointer;
      }
      .lang-opt:hover {
        color: var(--ct-text-dim);
      }
      .lang-opt.on {
        color: var(--ct-text);
        background: color-mix(in srgb, var(--ct-text) 9%, transparent);
      }
      .controls {
        display: flex;
        gap: 2px;
        padding: 4px 4px 4px 0;
      }
      .ctl {
        width: 34px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: var(--ct-radius-sm);
        background: transparent;
        color: var(--ct-text-faint);
        cursor: pointer;
        transition: background 0.1s ease, color 0.1s ease;
      }
      .ctl:focus { outline: none; }
      .ctl svg {
        width: 9px;
        height: 9px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
      }
      .ctl:hover {
        background: color-mix(in srgb, var(--ct-text) 9%, transparent);
        color: var(--ct-text);
      }
      .ctl--close:hover {
        background: #e5484d;
        color: #fff;
      }
    `,
  ],
})
export class TitlebarComponent {
  protected readonly i18n = inject(I18nService);
  private readonly win = getCurrentWindow();
  protected readonly maximized = signal(false);

  protected setLocale(locale: Locale): void {
    this.i18n.setLocale(locale);
  }

  constructor() {
    void this.refresh();
    const unlisten = this.win.onResized(() => void this.refresh());
    inject(DestroyRef).onDestroy(() => void unlisten.then((off) => off()));
  }

  private async refresh(): Promise<void> {
    this.maximized.set(await this.win.isMaximized());
  }

  protected minimize(): void {
    void this.win.minimize();
  }

  protected toggleMaximize(): void {
    void this.win.toggleMaximize();
  }

  protected close(): void {
    void this.win.close();
  }
}
