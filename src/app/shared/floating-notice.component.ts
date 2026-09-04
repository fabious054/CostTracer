import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The standard floating system notice: fixed, bottom-centre, above everything. For passive
 * advisories — "something is happening in the background", not errors or anything the user must
 * act on. Deliberately quiet: a calm accent tint (`--ct-notice-*`), never the warning palette.
 *
 * Usage: `<ct-floating-notice [busy]="true">Updating prices…</ct-floating-notice>`. The caller
 * decides when it's in the DOM (`@if`); this component is only the shell + presentation.
 */
@Component({
  selector: 'ct-floating-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="notice" role="status" aria-live="polite">
      @if (busy()) {
        <span class="spin" aria-hidden="true"></span>
      } @else {
        <span class="dot" aria-hidden="true"></span>
      }
      <span class="msg"><ng-content /></span>
    </div>
  `,
  styles: [
    `
      :host {
        position: fixed;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        z-index: 900;
        max-width: min(92vw, 560px);
        /* let clicks through the empty margin around the pill */
        pointer-events: none;
      }
      .notice {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 15px;
        font-size: 11.5px;
        line-height: 1.35;
        color: var(--ct-notice-text, var(--ct-text));
        background: var(--ct-notice-bg);
        border: 1px solid var(--ct-notice-border);
        border-radius: 999px;
        box-shadow:
          0 6px 20px rgba(0, 0, 0, 0.13),
          0 1px 3px rgba(0, 0, 0, 0.08);
        animation: ct-notice-in 0.16s ease-out;
      }
      .msg {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dot,
      .spin {
        flex: none;
        width: 9px;
        height: 9px;
        border-radius: 50%;
      }
      .dot {
        background: var(--ct-accent);
      }
      .spin {
        border: 1.4px solid var(--ct-notice-border);
        border-top-color: var(--ct-accent);
        animation: ct-notice-spin 0.7s linear infinite;
      }
      @keyframes ct-notice-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes ct-notice-in {
        from {
          opacity: 0;
          transform: translateY(4px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .notice,
        .spin {
          animation: none;
        }
      }
    `,
  ],
})
export class FloatingNoticeComponent {
  /** Show a spinner instead of the static dot — the notice reflects work in progress. */
  readonly busy = input(false);
}
