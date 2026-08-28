import { computed, Injectable, signal } from '@angular/core';
import { hasAnyDetectedConfig } from '../models/aws';
import {
  ManualCredentialInput,
  SsoStartInput,
  ValidationOutcome,
} from '../models/ipc-contracts';
import { SsoTarget } from '../models/aws';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import {
  ConnectionEvent,
  ConnectionState,
  INITIAL_STATE,
  reduce,
} from './connection.state';

/** i18n key — resolved by the component that renders the notice (see `messages.ts`). */
const STALE_SESSION_NOTICE = 'notice.staleSession';

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unexpected error talking to the local core.';
}

/**
 * Orchestrates the onboarding flow: owns the `ConnectionState` signal, drives every side effect
 * through `TauriIpcService`, and feeds outcomes back through the pure `reduce`. Components read
 * `state()` / `step()` and call the intent methods below — nothing else.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionStore {
  private readonly _state = signal<ConnectionState>(INITIAL_STATE);
  readonly state = this._state.asReadonly();
  readonly step = computed(() => this._state().step);

  /** Reason carried from a failed silent resume into the upcoming `methodSelect`. */
  private pendingNotice: string | null = null;
  private ssoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-entrancy guard: a slow `sso_poll` must not overlap the next scheduled tick. */
  private ssoPolling = false;

  constructor(private readonly ipc: TauriIpcService) {}

  private dispatch(event: ConnectionEvent): void {
    this._state.set(reduce(this._state(), event));
  }

  // --- launch --------------------------------------------------------------

  async boot(): Promise<void> {
    try {
      const res = await this.ipc.call('session_resume');
      if (res.status === 'ok') {
        this.dispatch({ type: 'boot/resumed', account: res.account });
        return;
      }
      this.pendingNotice = res.status === 'stale' ? STALE_SESSION_NOTICE : null;
      this.dispatch({ type: res.status === 'stale' ? 'boot/stale' : 'boot/no-session' });
    } catch {
      this.pendingNotice = null;
      this.dispatch({ type: 'boot/no-session' });
    }
    await this.detect();
  }

  private async detect(): Promise<void> {
    if (this._state().step !== 'detecting') return;
    const notice = this.pendingNotice;
    try {
      const detected = await this.ipc.call('detect_local_config');
      this.dispatch({
        type: 'detect/done',
        detected: hasAnyDetectedConfig(detected) ? detected : null,
        notice,
      });
    } catch {
      this.dispatch({ type: 'detect/done', detected: null, notice });
    } finally {
      this.pendingNotice = null;
    }
  }

  // --- method selection --------------------------------------------------------

  chooseManual(): void {
    this.dispatch({ type: 'method/manual' });
  }

  chooseSso(): void {
    this.dispatch({ type: 'method/sso' });
  }

  // --- credential capture ----------------------------------------------------

  async useDetected(profile: string | null, region: string | null): Promise<void> {
    this.dispatch({ type: 'validate/started', sourceKind: 'detected' });
    try {
      const outcome = await this.ipc.call('credential_use_detected', { input: { profile, region } });
      await this.handleValidation(outcome, 'detected');
    } catch (e) {
      this.dispatch({ type: 'validate/failed', sourceKind: 'detected', kind: 'invalid-or-expired', message: errMsg(e) });
    }
  }

  async submitManual(input: ManualCredentialInput): Promise<void> {
    this.dispatch({ type: 'validate/started', sourceKind: 'manual' });
    try {
      const outcome = await this.ipc.call('credential_submit_manual', { input });
      await this.handleValidation(outcome, 'manual');
    } catch (e) {
      this.dispatch({ type: 'validate/failed', sourceKind: 'manual', kind: 'invalid-or-expired', message: errMsg(e) });
    }
  }

  async startSso(input: SsoStartInput): Promise<void> {
    try {
      const auth = await this.ipc.call('sso_start', { input });
      this.dispatch({ type: 'sso/device-started', auth });
      this.beginSsoPolling(auth.expiresAt, auth.intervalSec);
    } catch (e) {
      this.dispatch({ type: 'sso/error', message: errMsg(e) });
    }
  }

  async selectSsoTarget(target: SsoTarget): Promise<void> {
    this.dispatch({ type: 'validate/started', sourceKind: 'sso' });
    try {
      const outcome = await this.ipc.call('sso_select_target', {
        input: { accountId: target.accountId, roleName: target.roleName },
      });
      await this.handleValidation(outcome, 'sso');
    } catch (e) {
      this.dispatch({ type: 'validate/failed', sourceKind: 'sso', kind: 'invalid-or-expired', message: errMsg(e) });
    }
  }

  private beginSsoPolling(expiresAt: number, intervalSec: number): void {
    this.clearSsoPolling();
    const period = Math.max(intervalSec, 1) * 1000;
    const schedule = (): void => {
      this.ssoTimer = setTimeout(() => void this.pollSsoOnce(expiresAt, schedule), period);
    };
    schedule();
  }

  /**
   * One poll tick. Self-schedules the next one only while still pending — a plain interval would
   * let a slow `sso_poll` (token exchange + account/role listing) overlap the next tick and call
   * `create_token` twice, which fails with InvalidGrant on the now-consumed device code.
   */
  private async pollSsoOnce(expiresAt: number, reschedule: () => void): Promise<void> {
    if (this.ssoPolling) return;
    if (this._state().step !== 'ssoDeviceAuth') {
      this.clearSsoPolling();
      return;
    }
    if (Date.now() >= expiresAt) {
      this.clearSsoPolling();
      this.dispatch({ type: 'sso/expired' });
      return;
    }

    this.ssoPolling = true;
    try {
      const res = await this.ipc.call('sso_poll');
      if (this._state().step !== 'ssoDeviceAuth') {
        // A prior tick already resolved the flow while this one was in flight.
        this.clearSsoPolling();
        return;
      }
      switch (res.state) {
        case 'pending':
        case 'slow_down':
          reschedule();
          return;
        case 'expired':
          this.clearSsoPolling();
          this.dispatch({ type: 'sso/expired' });
          return;
        case 'authorized':
          this.clearSsoPolling();
          if (res.targets.length === 1) {
            await this.selectSsoTarget(res.targets[0]);
          } else {
            this.dispatch({ type: 'sso/targets', targets: res.targets });
          }
          return;
      }
    } catch (e) {
      this.clearSsoPolling();
      this.dispatch({ type: 'sso/error', message: errMsg(e) });
    } finally {
      this.ssoPolling = false;
    }
  }

  private clearSsoPolling(): void {
    if (this.ssoTimer !== null) {
      clearTimeout(this.ssoTimer);
      this.ssoTimer = null;
    }
  }

  // --- validation outcome + permission audit -------------------------------

  private async handleValidation(
    outcome: ValidationOutcome,
    sourceKind: 'detected' | 'manual' | 'sso',
  ): Promise<void> {
    if (outcome.status === 'ok') {
      this.dispatch({ type: 'validate/ok', identity: outcome.identity });
      await this.checkPermissions();
      return;
    }
    this.dispatch({
      type: 'validate/failed',
      sourceKind,
      kind: outcome.status === 'insufficient' ? 'insufficient-permission' : 'invalid-or-expired',
      message: outcome.message,
    });
  }

  private async checkPermissions(): Promise<void> {
    const current = this._state();
    if (current.step !== 'checkingPermissions') return;
    const identity = current.identity;
    try {
      const audit = await this.ipc.call('permissions_check');
      if (audit.excessive) {
        const recommendedPolicy = await this.ipc.call('policy_minimal_read');
        this.dispatch({ type: 'permissions/excessive', identity, audit, recommendedPolicy });
        return;
      }
      this.dispatch({ type: 'permissions/clean' });
      await this.finalize();
    } catch (e) {
      // Audit could not run at all (neither simulate nor list-policies). Can't prove excess — proceed.
      console.error('[connection] permission audit failed to run', e);
      this.dispatch({ type: 'permissions/clean' });
      await this.finalize();
    }
  }

  private async finalize(): Promise<void> {
    if (this._state().step !== 'persisting') return;
    try {
      const account = await this.ipc.call('connection_finalize');
      this.dispatch({ type: 'persist/done', account });
    } catch (e) {
      this.dispatch({ type: 'error', message: errMsg(e) });
    }
  }

  // --- explicit user actions ----------------------------------------------

  acceptRiskAndContinue(): void {
    if (this._state().step !== 'excessivePermissions') return;
    this.dispatch({ type: 'risk/accept' });
    void this.finalize();
  }

  retry(): void {
    const current = this._state();
    if (current.step !== 'validationFailed') return;
    const sourceKind = current.sourceKind;
    this.dispatch({ type: 'retry' });
    void (async () => {
      try {
        const outcome = await this.ipc.call('credential_revalidate');
        await this.handleValidation(outcome, sourceKind);
      } catch (e) {
        this.dispatch({ type: 'validate/failed', sourceKind, kind: 'invalid-or-expired', message: errMsg(e) });
      }
    })();
  }

  switchMethod(): void {
    this.clearSsoPolling();
    void this.ipc.call('session_discard').catch(() => undefined);
    this.dispatch({ type: 'switch-method' });
    void this.detect();
  }

  async disconnect(): Promise<void> {
    await this.ipc.call('connection_disconnect').catch(() => undefined);
    this.dispatch({ type: 'disconnect' });
    await this.detect();
  }
}
