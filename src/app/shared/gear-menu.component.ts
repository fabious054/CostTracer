import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  signal,
} from '@angular/core';

export interface GearMenuItem {
  /** Visible text. */
  label: string;
  /** Invoked on click; the menu closes afterwards. */
  run: () => void;
}

/**
 * A gear icon that opens a small popover list of action buttons (`items`). Right-aligned under
 * the gear. Closes on outside click, Escape, or picking an item. Purely presentational — the
 * caller owns what the items do.
 */
@Component({
  selector: 'ct-gear-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="gear"
      [class.on]="open()"
      (click)="toggle()"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [attr.title]="label()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.47.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
        />
      </svg>
    </button>

    @if (open()) {
      <div class="menu" role="menu">
        @for (item of items(); track item.label) {
          <button type="button" role="menuitem" class="item" (click)="pick(item)">
            {{ item.label }}
          </button>
        } @empty {
          <p class="empty">{{ emptyLabel() }}</p>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
      }
      .gear {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 1px solid var(--ct-border-line);
        border-radius: var(--ct-radius-sm);
        background: var(--ct-panel);
        color: var(--ct-text-dim);
        cursor: pointer;
        transition:
          background 0.12s,
          color 0.12s;
      }
      .gear svg {
        width: 18px;
        height: 18px;
        display: block;
      }
      .gear:hover {
        background: var(--ct-inset);
        color: var(--ct-text);
      }
      .gear.on {
        background: var(--ct-inset);
        color: var(--ct-accent);
        border-color: var(--ct-accent);
      }
      .gear:focus-visible {
        outline: 2px solid var(--ct-accent);
        outline-offset: 1px;
      }
      .menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 950;
        min-width: 190px;
        display: flex;
        flex-direction: column;
        padding: 5px;
        background: var(--ct-panel);
        border: 1px solid var(--ct-border-line);
        border-radius: var(--ct-radius);
        box-shadow:
          0 10px 30px rgba(0, 0, 0, 0.18),
          0 2px 6px rgba(0, 0, 0, 0.1);
        animation: ct-gear-in 0.12s ease-out;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 8px;
        text-align: left;
        min-height: 34px;
        padding: 7px 10px;
        border: 0;
        border-radius: var(--ct-radius-sm);
        background: transparent;
        color: var(--ct-text);
        font: inherit;
        font-size: 12.5px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.1s;
      }
      /* a hairline between rows so each reads as its own control */
      .item + .item {
        margin-top: 3px;
        border-top: 1px solid var(--ct-border-faint);
        border-top-left-radius: 0;
        border-top-right-radius: 0;
        padding-top: 10px;
      }
      /* trailing dot that lights up on hover — a small "actionable" cue */
      .item::after {
        content: '';
        width: 4px;
        height: 4px;
        margin-left: auto;
        border-radius: 50%;
        background: transparent;
        transition: background 0.1s;
      }
      .item:hover,
      .item:focus-visible {
        background: var(--ct-inset);
        outline: none;
      }
      .item:hover::after,
      .item:focus-visible::after {
        background: var(--ct-accent);
      }
      .item:active {
        background: var(--ct-border-faint);
      }
      .empty {
        margin: 0;
        padding: 8px 10px;
        font-size: 12px;
        color: var(--ct-text-faint);
        white-space: nowrap;
      }
      @keyframes ct-gear-in {
        from {
          opacity: 0;
          transform: translateY(-3px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .menu {
          animation: none;
        }
      }
    `,
  ],
})
export class GearMenuComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly items = input.required<GearMenuItem[]>();
  /** Accessible name / tooltip for the gear button. */
  readonly label = input('Menu');
  /** Shown when `items` is empty — the gear stays, the list just has nothing yet. */
  readonly emptyLabel = input('No options yet');

  readonly open = signal(false);

  toggle(): void {
    this.open.update((v) => !v);
  }

  pick(item: GearMenuItem): void {
    item.run();
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }
}
