import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { BusyComponent } from '../ui/busy.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

@Component({
  selector: 'ct-step-checking-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, BusyComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('checkingPermissions.title')">
      <ct-busy [label]="i18n.t('checkingPermissions.busy')" />
    </ct-wizard-shell>
  `,
})
export class CheckingPermissionsComponent {
  protected readonly i18n = inject(I18nService);
}
