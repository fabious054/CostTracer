import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import { AWS_REGIONS } from '../../../core/models/aws-regions';

/**
 * A region input with a styled suggestion list (native `<datalist>` can't be aligned or themed).
 * Free-text: typing an unknown region — GovCloud, China, a brand-new one — is still accepted.
 */
@Component({
  selector: 'ct-region-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="ct-field">
      <span>{{ label() }}</span>
      <div class="combo" role="combobox" aria-haspopup="listbox" [attr.aria-expanded]="open()">
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          [value]="value()"
          [placeholder]="placeholder()"
          (input)="onInput($event)"
          (focus)="open.set(true)"
          (blur)="close()"
          (keydown)="onKey($event)"
        />
        @if (open() && filtered().length) {
          <ul class="list" role="listbox">
            @for (r of filtered(); track r.id; let i = $index) {
              <li
                role="option"
                [attr.aria-selected]="i === active()"
                [class.active]="i === active()"
                (mousedown)="pick(r.id)"
                (mouseenter)="active.set(i)"
              >
                <span class="id">{{ r.id }}</span>
                <span class="name">{{ r.label }}</span>
              </li>
            }
          </ul>
        }
      </div>
    </label>
  `,
  styles: [
    `
      .combo {
        position: relative;
      }
      input {
        width: 100%;
        padding: 7px 9px;
        border-radius: var(--ct-radius-sm);
        border: 1px solid var(--ct-border-line);
        background: var(--ct-bg);
        color: var(--ct-text);
        font: inherit;
      }
      input:focus-visible {
        outline: 2px solid var(--ct-accent);
        outline-offset: 1px;
      }
      .list {
        position: absolute;
        top: calc(100% + 3px);
        left: 0;
        right: 0;
        z-index: 20;
        margin: 0;
        padding: 3px;
        list-style: none;
        max-height: 196px;
        overflow-y: auto;
        background: var(--ct-panel);
        border: 1px solid var(--ct-border-line);
        border-radius: var(--ct-radius-sm);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
      }
      li {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: var(--ct-radius-sm);
        font-size: 12px;
        line-height: 1.3;
        cursor: pointer;
      }
      li.active {
        background: var(--ct-inset);
      }
      .id {
        flex: none;
        font-weight: 500;
        color: var(--ct-text);
      }
      .name {
        color: var(--ct-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ],
})
export class RegionFieldComponent {
  readonly label = input('Region');
  readonly placeholder = input('e.g. us-east-1');
  readonly value = model('');

  protected readonly open = signal(false);
  protected readonly active = signal(0);

  protected readonly filtered = computed(() => {
    const q = this.value().trim().toLowerCase();
    if (!q) return AWS_REGIONS;
    return AWS_REGIONS.filter(
      (r) => r.id.includes(q) || r.label.toLowerCase().includes(q),
    );
  });

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
    this.open.set(true);
    this.active.set(0);
  }

  protected close(): void {
    // Delay so a click on an option (mousedown) still registers.
    setTimeout(() => this.open.set(false), 120);
  }

  protected pick(id: string): void {
    this.value.set(id);
    this.open.set(false);
  }

  protected onKey(event: KeyboardEvent): void {
    const list = this.filtered();
    if (event.key === 'Escape') {
      this.open.set(false);
      return;
    }
    if (!this.open() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      this.open.set(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.active.update((i) => Math.min(i + 1, list.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active.update((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && this.open() && list[this.active()]) {
      event.preventDefault();
      this.pick(list[this.active()].id);
    }
  }
}
