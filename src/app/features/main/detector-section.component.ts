import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DetectorKind, DetectorResult } from '../../core/models/scan';
import { ResourceRowComponent } from './resource-row.component';

function storageKey(kind: DetectorKind): string {
  return `ct.scan.collapsed.${kind}`;
}
function readCollapsed(kind: DetectorKind): boolean {
  try {
    return localStorage.getItem(storageKey(kind)) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(kind: DetectorKind, collapsed: boolean): void {
  try {
    localStorage.setItem(storageKey(kind), collapsed ? '1' : '0');
  } catch {
    /* storage blocked — collapse still works for this session */
  }
}

/**
 * One detector's slice of the inventory, as a quiet panel. The header shows the at-a-glance
 * status (alerting count in amber, or "all in use"), collapses the list, and is remembered
 * per detector so a growing inventory stays legible.
 */
@Component({
  selector: 'ct-detector-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ResourceRowComponent],
  template: `
    @if (detector(); as d) {
      <section class="panel">
        <button
          type="button"
          class="header"
          [attr.aria-expanded]="!collapsed()"
          (click)="toggle()"
        >
          <span class="caret" [class.open]="!collapsed()" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M4.5 3 L8 6 L4.5 9" /></svg>
          </span>
          <h2>{{ i18n.t('scan.detector.' + d.kind) }}</h2>

          <span class="status">
            @if (alertingCount() > 0) {
              <span class="pill alert">{{ alertingCount() }}</span>
            } @else if (d.items.length > 0) {
              <span class="ok">&#10003;</span>
            }
            <span class="total">{{ d.items.length }}</span>
            @if (d.regionErrors.length > 0) {
              <span class="warn" [attr.title]="i18n.t('scan.meta.partial')">&#9888;</span>
            }
          </span>
        </button>

        @if (!collapsed()) {
          <div class="body">
            @for (err of d.regionErrors; track err.region) {
              <p class="ct-alert ct-alert--warning region-err">
                {{ i18n.t('scan.regionError', { region: err.region, message: err.message }) }}
              </p>
            }

            @if (d.items.length === 0) {
              <p class="empty">{{ i18n.t('scan.empty') }}</p>
            } @else {
              @for (item of d.items; track item.resourceId + '@' + item.region) {
                <ct-resource-row [item]="item" />
              }
            }
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      .panel {
        background: var(--ct-panel);
        border: 1px solid var(--ct-border-faint);
        border-radius: var(--ct-radius);
        margin-bottom: 12px;
      }
      .header {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
        border-radius: var(--ct-radius);
      }
      .header:hover {
        background: var(--ct-inset);
      }
      .caret {
        flex: none;
        display: grid;
        place-items: center;
        width: 12px;
        height: 12px;
        color: var(--ct-text-faint);
      }
      .caret svg {
        width: 10px;
        height: 10px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.4;
        stroke-linecap: round;
        stroke-linejoin: round;
        transform-box: fill-box;
        transform-origin: center;
        transition: transform 0.12s ease;
      }
      .caret.open svg {
        transform: rotate(90deg);
      }
      h2 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
      }
      .status {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 11px;
        color: var(--ct-text-faint);
      }
      .pill {
        min-width: 18px;
        padding: 1px 6px;
        border-radius: 999px;
        font-weight: 700;
        text-align: center;
        background: var(--ct-warn-bg);
        color: var(--ct-warn);
      }
      .ok {
        color: var(--ct-ok);
        font-size: 12px;
      }
      .total {
        font-variant-numeric: tabular-nums;
      }
      .warn {
        color: var(--ct-warn);
        font-size: 12px;
      }
      .body {
        padding: 0 14px 6px;
      }
      .region-err {
        margin: 8px 0 0;
      }
      .empty {
        margin: 4px 0 8px;
        font-size: 12px;
        color: var(--ct-text-dim);
      }
    `,
  ],
})
export class DetectorSectionComponent implements OnInit {
  protected readonly i18n = inject(I18nService);
  readonly detector = input.required<DetectorResult>();

  protected readonly collapsed = signal(false);

  protected readonly alertingCount = computed(
    () => this.detector().items.filter((i) => i.state === 'alert' && !i.intentional).length,
  );

  ngOnInit(): void {
    this.collapsed.set(readCollapsed(this.detector().kind));
  }

  protected toggle(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    writeCollapsed(this.detector().kind, next);
  }
}
