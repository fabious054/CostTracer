import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConnectionStore } from '../../core/connection/connection.store';
import { AccountInfoComponent } from '../account/account-info.component';
import { BootingComponent } from './steps/booting.component';
import { CheckingPermissionsComponent } from './steps/checking-permissions.component';
import { DetectingComponent } from './steps/detecting.component';
import { ExcessivePermissionsComponent } from './steps/excessive-permissions.component';
import { ManualEntryComponent } from './steps/manual-entry.component';
import { MethodSelectComponent } from './steps/method-select.component';
import { PersistingComponent } from './steps/persisting.component';
import { SsoDeviceAuthComponent } from './steps/sso-device-auth.component';
import { SsoSelectTargetComponent } from './steps/sso-select-target.component';
import { SsoStartComponent } from './steps/sso-start.component';
import { ValidatingComponent } from './steps/validating.component';
import { ValidationFailedComponent } from './steps/validation-failed.component';

/**
 * The only place that branches on `step`. Each case renders one self-contained step component
 * that pulls what it needs from `ConnectionStore`.
 */
@Component({
  selector: 'ct-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BootingComponent,
    DetectingComponent,
    MethodSelectComponent,
    ManualEntryComponent,
    SsoStartComponent,
    SsoDeviceAuthComponent,
    SsoSelectTargetComponent,
    ValidatingComponent,
    ValidationFailedComponent,
    CheckingPermissionsComponent,
    ExcessivePermissionsComponent,
    PersistingComponent,
    AccountInfoComponent,
  ],
  template: `
    @switch (store.step()) {
      @case ('booting') { <ct-step-booting /> }
      @case ('detecting') { <ct-step-detecting /> }
      @case ('methodSelect') { <ct-step-method-select /> }
      @case ('manualEntry') { <ct-step-manual-entry /> }
      @case ('ssoStart') { <ct-step-sso-start /> }
      @case ('ssoDeviceAuth') { <ct-step-sso-device-auth /> }
      @case ('ssoSelectTarget') { <ct-step-sso-select-target /> }
      @case ('validating') { <ct-step-validating /> }
      @case ('validationFailed') { <ct-step-validation-failed /> }
      @case ('checkingPermissions') { <ct-step-checking-permissions /> }
      @case ('excessivePermissions') { <ct-step-excessive-permissions /> }
      @case ('persisting') { <ct-step-persisting /> }
      @case ('connected') { <ct-account-info /> }
    }
  `,
})
export class OnboardingComponent {
  protected readonly store = inject(ConnectionStore);
}
