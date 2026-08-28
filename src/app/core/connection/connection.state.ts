/**
 * The onboarding finite state machine (ADR 0001, Option A).
 *
 * `ConnectionState` is a discriminated union keyed by `step`. `reduce` is the ONLY place a
 * transition happens; it is pure and total. Illegal `(state, event)` pairs return the state
 * unchanged (dev builds log a warning). See `docs/scope-1-connection-flow.md` for the transition
 * table and `connection.reducer.spec.ts` for the negative-path coverage.
 */

import {
  AccountInfo,
  CallerIdentity,
  CredentialSourceKind,
  DetectedConfig,
  PermissionAudit,
  SsoDeviceAuth,
  SsoTarget,
} from '../models/aws';

declare const ngDevMode: boolean | undefined;

export type ValidationFailureKind = 'invalid-or-expired' | 'insufficient-permission';

export type ConnectionState =
  | { step: 'booting' }
  | { step: 'detecting' }
  | { step: 'methodSelect'; detected: DetectedConfig | null; notice: string | null }
  | { step: 'manualEntry' }
  | { step: 'ssoStart'; notice: string | null }
  | { step: 'ssoDeviceAuth'; auth: SsoDeviceAuth }
  | { step: 'ssoSelectTarget'; targets: SsoTarget[] }
  | { step: 'validating'; sourceKind: CredentialSourceKind }
  | { step: 'validationFailed'; sourceKind: CredentialSourceKind; kind: ValidationFailureKind; message: string }
  | { step: 'checkingPermissions'; identity: CallerIdentity }
  | { step: 'excessivePermissions'; identity: CallerIdentity; audit: PermissionAudit; recommendedPolicy: string }
  | { step: 'persisting'; identity: CallerIdentity }
  | { step: 'connected'; account: AccountInfo };

export type StepId = ConnectionState['step'];

export const INITIAL_STATE: ConnectionState = { step: 'booting' };

export type ConnectionEvent =
  | { type: 'boot/resumed'; account: AccountInfo }
  | { type: 'boot/stale' }
  | { type: 'boot/no-session' }
  | { type: 'detect/done'; detected: DetectedConfig | null; notice: string | null }
  | { type: 'method/manual' }
  | { type: 'method/sso' }
  | { type: 'validate/started'; sourceKind: CredentialSourceKind }
  | { type: 'validate/ok'; identity: CallerIdentity }
  | { type: 'validate/failed'; sourceKind: CredentialSourceKind; kind: ValidationFailureKind; message: string }
  | { type: 'sso/device-started'; auth: SsoDeviceAuth }
  | { type: 'sso/targets'; targets: SsoTarget[] }
  | { type: 'sso/expired' }
  | { type: 'sso/error'; message: string }
  | { type: 'permissions/clean' }
  | { type: 'permissions/excessive'; identity: CallerIdentity; audit: PermissionAudit; recommendedPolicy: string }
  | { type: 'risk/accept' }
  | { type: 'persist/done'; account: AccountInfo }
  | { type: 'retry' }
  | { type: 'switch-method' }
  | { type: 'disconnect' }
  | { type: 'error'; message: string };

export type EventType = ConnectionEvent['type'];

/** i18n key — resolved by the component that renders the notice (see `messages.ts`). */
const SSO_EXPIRED_NOTICE = 'notice.ssoExpired';

function illegal(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  if (typeof ngDevMode === 'undefined' || ngDevMode) {
    console.warn(`[connection] ignored event "${event.type}" in step "${state.step}"`);
  }
  return state;
}

export function reduce(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case 'boot/resumed':
      return state.step === 'booting' ? { step: 'connected', account: event.account } : illegal(state, event);

    case 'boot/stale':
    case 'boot/no-session':
      return state.step === 'booting' ? { step: 'detecting' } : illegal(state, event);

    case 'detect/done':
      return state.step === 'detecting'
        ? { step: 'methodSelect', detected: event.detected, notice: event.notice }
        : illegal(state, event);

    case 'method/manual':
      return state.step === 'methodSelect' ? { step: 'manualEntry' } : illegal(state, event);

    case 'method/sso':
      return state.step === 'methodSelect' ? { step: 'ssoStart', notice: null } : illegal(state, event);

    case 'validate/started':
      return state.step === 'methodSelect' ||
        state.step === 'manualEntry' ||
        state.step === 'ssoDeviceAuth' ||
        state.step === 'ssoSelectTarget'
        ? { step: 'validating', sourceKind: event.sourceKind }
        : illegal(state, event);

    case 'validate/ok':
      return state.step === 'validating'
        ? { step: 'checkingPermissions', identity: event.identity }
        : illegal(state, event);

    case 'validate/failed':
      return state.step === 'validating'
        ? { step: 'validationFailed', sourceKind: event.sourceKind, kind: event.kind, message: event.message }
        : illegal(state, event);

    case 'sso/device-started':
      return state.step === 'ssoStart' ? { step: 'ssoDeviceAuth', auth: event.auth } : illegal(state, event);

    case 'sso/targets':
      return state.step === 'ssoDeviceAuth'
        ? { step: 'ssoSelectTarget', targets: event.targets }
        : illegal(state, event);

    case 'sso/expired':
      return state.step === 'ssoDeviceAuth'
        ? { step: 'ssoStart', notice: SSO_EXPIRED_NOTICE }
        : illegal(state, event);

    case 'sso/error':
      return state.step === 'ssoStart' || state.step === 'ssoDeviceAuth' || state.step === 'ssoSelectTarget'
        ? { step: 'ssoStart', notice: event.message }
        : illegal(state, event);

    case 'permissions/clean':
      return state.step === 'checkingPermissions'
        ? { step: 'persisting', identity: state.identity }
        : illegal(state, event);

    case 'permissions/excessive':
      return state.step === 'checkingPermissions'
        ? {
            step: 'excessivePermissions',
            identity: event.identity,
            audit: event.audit,
            recommendedPolicy: event.recommendedPolicy,
          }
        : illegal(state, event);

    case 'risk/accept':
      return state.step === 'excessivePermissions'
        ? { step: 'persisting', identity: state.identity }
        : illegal(state, event);

    case 'persist/done':
      return state.step === 'persisting' ? { step: 'connected', account: event.account } : illegal(state, event);

    case 'retry':
      return state.step === 'validationFailed'
        ? { step: 'validating', sourceKind: state.sourceKind }
        : illegal(state, event);

    case 'switch-method':
      return state.step === 'validationFailed' ||
        state.step === 'excessivePermissions' ||
        state.step === 'manualEntry' ||
        state.step === 'ssoStart' ||
        state.step === 'ssoDeviceAuth' ||
        state.step === 'ssoSelectTarget'
        ? { step: 'detecting' }
        : illegal(state, event);

    case 'disconnect':
      return state.step === 'connected' ? { step: 'detecting' } : illegal(state, event);

    case 'error':
      if (state.step === 'validating') {
        return {
          step: 'validationFailed',
          sourceKind: state.sourceKind,
          kind: 'invalid-or-expired',
          message: event.message,
        };
      }
      return { step: 'methodSelect', detected: null, notice: event.message };

    default:
      return assertNever(event);
  }
}

function assertNever(event: never): never {
  throw new Error(`[connection] unhandled event: ${JSON.stringify(event)}`);
}
