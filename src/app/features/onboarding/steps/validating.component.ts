import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { BusyComponent } from '../ui/busy.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

@Component({
  selector: 'ct-step-validating',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, BusyComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('validating.title')">
      <ct-busy [label]="i18n.t('validating.busy')" />
    </ct-wizard-shell>
  `,
})
export class ValidatingComponent {
  protected readonly i18n = inject(I18nService);
}
