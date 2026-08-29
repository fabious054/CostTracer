import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ScanStore } from '../../core/scan/scan.store';
import { BusyComponent } from '../onboarding/ui/busy.component';
import { DetectorSectionComponent } from './detector-section.component';

/** The scan entry point + results. First-run CTA, then a scan-meta line + the 3 detector sections. */
@Component({
  selector: 'ct-scan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BusyComponent, DetectorSectionComponent],
  template: `
    @switch (store.phase()) {
      @case ('scanning') {
        <ct-busy [label]="i18n.t('scan.scanning')" />
      }
      @case ('error') {
        <div class="ct-alert ct-alert--danger" role="alert">
          <strong>{{ i18n.t('scan.error.title') }}</strong>
          {{ store.error() }}
        </div>
        <button type="button" class="ct-btn ct-btn--primary retry" (click)="store.run()">
          {{ i18n.t('scan.error.retry') }}
        </button>
      }
      @default {
        @if (store.result(); as result) {
          <div class="meta">
            <span>{{ i18n.t('scan.meta.lastRun', { when: when(result.finishedAt) }) }}</span>
            @if (result.status === 'partial') {
              <span class="partial">{{ i18n.t('scan.meta.partial') }}</span>
            }
            <button type="button" class="ct-btn rescan" (click)="store.run()">
              {{ i18n.t('scan.rescan') }}
            </button>
          </div>

          @for (detector of result.detectors; track detector.kind) {
            <ct-detector-section [detector]="detector" />
          }
        } @else {
          <div class="firstrun">
            <h2>{{ i18n.t('scan.firstRun.title') }}</h2>
            <p class="ct-muted">{{ i18n.t('scan.firstRun.body') }}</p>
            <button type="button" class="ct-btn ct-btn--primary" (click)="store.run()">
              {{ i18n.t('scan.runFirst') }}
            </button>
          </div>
        }
      }
    }
  `,
  styles: [
    `
      .meta {
        display: flex;
        align-items: baseline;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 18px;
        font-size: 11.5px;
        color: var(--ct-text-dim);
      }
      .partial {
        color: var(--ct-warn);
      }
      .rescan {
        margin-left: auto;
      }
      .retry {
        margin-top: 12px;
      }
      .firstrun {
        text-align: center;
        padding: 32px 0;
      }
      .firstrun h2 {
        font-size: 14px;
        margin: 0 0 6px;
      }
      .firstrun p {
        font-size: 12.5px;
        margin: 0 auto 16px;
        max-width: 380px;
      }
    `,
  ],
})
export class ScanPanelComponent implements OnInit {
  protected readonly i18n = inject(I18nService);
  protected readonly store = inject(ScanStore);

  ngOnInit(): void {
    void this.store.loadLatest();
  }

  protected when(unixSecs: number): string {
    const locale = this.i18n.locale() === 'pt' ? 'pt-BR' : 'en-US';
    return new Date(unixSecs * 1000).toLocaleString(locale);
  }
}
