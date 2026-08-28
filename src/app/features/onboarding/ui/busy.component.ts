import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A spinner plus a line of text, used by every transient ("…ing") step. */
@Component({
  selector: 'ct-busy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="busy" role="status">
      <span class="ct-spinner" aria-hidden="true"></span>
      <p>{{ label() }}</p>
    </div>
  `,
  styles: [
    `
      .busy {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        padding: 8px 0;
        text-align: center;
      }
      p {
        margin: 0;
        color: var(--ct-text-muted);
      }
    `,
  ],
})
export class BusyComponent {
  readonly label = input.required<string>();
}
