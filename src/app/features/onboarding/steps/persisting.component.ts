import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { BusyComponent } from '../ui/busy.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

@Component({
  selector: 'ct-step-persisting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, BusyComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('persisting.title')">
      <ct-busy [label]="i18n.t('persisting.busy')" />
    </ct-wizard-shell>
  `,
})
export class PersistingComponent {
  protected readonly i18n = inject(I18nService);
}
