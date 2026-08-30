import { AccountInfo, CallerIdentity, PermissionAudit } from '../models/aws';
import { ConnectionState, reduce } from './connection.state';

const identity: CallerIdentity = {
  accountId: '123456789012',
  userId: 'AIDAEXAMPLE',
  arn: 'arn:aws:iam::123456789012:user/costtracer',
};

const account: AccountInfo = {
  accountId: '123456789012',
  arn: identity.arn,
  userId: identity.userId,
  regions: ['us-east-1'],
  regionsDiscovered: true,
  sourceKind: 'manual',
};

const audit: PermissionAudit = {
  method: 'simulate',
  excessive: true,
  findings: [{ kind: 'simulated-action-allowed', label: 'ec2:TerminateInstances', detail: 'allowed' }],
};

describe('connection reducer', () => {
  it('resumes straight to connected on a valid saved session', () => {
    expect(reduce({ step: 'booting' }, { type: 'boot/resumed', account }).step).toBe('connected');
  });

  it('walks the happy path from method selection to connected', () => {
    let s: ConnectionState = { step: 'methodSelect', detected: null, notice: null };
    s = reduce(s, { type: 'method/manual' });
    expect(s.step).toBe('manualEntry');
    s = reduce(s, { type: 'validate/started', sourceKind: 'manual' });
    expect(s.step).toBe('validating');
    s = reduce(s, { type: 'validate/ok', identity });
    expect(s.step).toBe('checkingPermissions');
    s = reduce(s, { type: 'permissions/clean' });
    expect(s.step).toBe('persisting');
    s = reduce(s, { type: 'persist/done', account });
    expect(s.step).toBe('connected');
  });

  it('routes both validation failure kinds to validationFailed and stays there', () => {
    const validating: ConnectionState = { step: 'validating', sourceKind: 'manual' };

    const invalid = reduce(validating, {
      type: 'validate/failed',
      sourceKind: 'manual',
      kind: 'invalid-or-expired',
      message: 'The security token is invalid.',
    });
    expect(invalid).toEqual({
      step: 'validationFailed',
      sourceKind: 'manual',
      kind: 'invalid-or-expired',
      message: 'The security token is invalid.',
    });

    const insufficient = reduce(validating, {
      type: 'validate/failed',
      sourceKind: 'sso',
      kind: 'insufficient-permission',
      message: 'ec2:DescribeVolumes denied.',
    });
    expect(insufficient.step).toBe('validationFailed');
  });

  it('NEVER falls back from validationFailed to method selection on its own', () => {
    const failed: ConnectionState = {
      step: 'validationFailed',
      sourceKind: 'manual',
      kind: 'invalid-or-expired',
      message: 'nope',
    };
    // A second failure event, an error, a detect result — none of these may escape the screen.
    expect(reduce(failed, { type: 'validate/failed', sourceKind: 'manual', kind: 'invalid-or-expired', message: 'x' })).toBe(failed);
    expect(reduce(failed, { type: 'detect/done', detected: null, notice: null })).toBe(failed);
    expect(reduce(failed, { type: 'boot/no-session' })).toBe(failed);
  });

  it('retries by returning to validating with the same source kind', () => {
    const failed: ConnectionState = {
      step: 'validationFailed',
      sourceKind: 'sso',
      kind: 'insufficient-permission',
      message: 'nope',
    };
    expect(reduce(failed, { type: 'retry' })).toEqual({ step: 'validating', sourceKind: 'sso' });
  });

  it('leaves validationFailed only via an explicit switch-method', () => {
    const failed: ConnectionState = {
      step: 'validationFailed',
      sourceKind: 'manual',
      kind: 'invalid-or-expired',
      message: 'nope',
    };
    expect(reduce(failed, { type: 'switch-method' }).step).toBe('detecting');
  });

  it('shows the excessive-permissions alert only when the audit says so', () => {
    const checking: ConnectionState = { step: 'checkingPermissions', identity };
    expect(reduce(checking, { type: 'permissions/clean' }).step).toBe('persisting');
    const alerted = reduce(checking, {
      type: 'permissions/excessive',
      identity,
      audit,
      recommendedPolicy: '{}',
    });
    expect(alerted.step).toBe('excessivePermissions');
  });

  it('continues to persisting when the user accepts the risk', () => {
    const alerted: ConnectionState = {
      step: 'excessivePermissions',
      identity,
      audit,
      recommendedPolicy: '{}',
    };
    expect(reduce(alerted, { type: 'risk/accept' })).toEqual({ step: 'persisting', identity });
  });

  it('only allows disconnect from the connected screen', () => {
    const connected: ConnectionState = { step: 'connected', account };
    expect(reduce(connected, { type: 'disconnect' }).step).toBe('detecting');
    const booting: ConnectionState = { step: 'booting' };
    expect(reduce(booting, { type: 'disconnect' })).toBe(booting);
  });

  it('treats illegal (state, event) pairs as no-ops that preserve identity', () => {
    const detecting: ConnectionState = { step: 'detecting' };
    expect(reduce(detecting, { type: 'validate/ok', identity })).toBe(detecting);
    expect(reduce(detecting, { type: 'risk/accept' })).toBe(detecting);
    expect(reduce(detecting, { type: 'persist/done', account })).toBe(detecting);
  });

  it('sends an SSO expiry back to ssoStart with a notice, not out of the flow', () => {
    const device: ConnectionState = {
      step: 'ssoDeviceAuth',
      auth: {
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://device.sso.example',
        verificationUriComplete: 'https://device.sso.example?user_code=ABCD-EFGH',
        expiresAt: Date.now() + 60_000,
        intervalSec: 5,
      },
    };
    const next = reduce(device, { type: 'sso/expired' });
    expect(next.step).toBe('ssoStart');
    expect((next as { notice: string }).notice).toBe('notice.ssoExpired');
  });
});
