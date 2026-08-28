import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { MessageKey } from '../../../core/i18n/messages';
import { SsoTarget } from '../../../core/models/aws';
import { WizardShellComponent } from '../ui/wizard-shell.component';

/**
 * Risk tiers, narrowest → widest:
 *  - readonly : recommended (ReadOnlyAccess / ViewOnlyAccess / SecurityAudit)
 *  - other    : unknown custom name — no claim
 *  - elevated : more than needed but usable (PowerUserAccess, *FullAccess)
 *  - broad    : much more than needed but still usable (AdministratorAccess)
 *  - blocked  : never — CostTracer will not connect with this (Billing)
 */
type RoleRisk = 'readonly' | 'other' | 'elevated' | 'broad' | 'blocked';

interface RoleRow {
  target: SsoTarget;
  risk: RoleRisk;
}
interface AccountGroup {
  accountId: string;
  accountName: string;
  roles: RoleRow[];
}

const RISK_ORDER: Record<RoleRisk, number> = {
  readonly: 0,
  other: 1,
  elevated: 2,
  broad: 3,
  blocked: 4,
};

const BADGE_KEY: Partial<Record<RoleRisk, MessageKey>> = {
  readonly: 'sso.target.badge.readonly',
  elevated: 'sso.target.badge.elevated',
  broad: 'sso.target.badge.broad',
  blocked: 'sso.target.badge.blocked',
};

/**
 * Classify a permission-set name heuristically — it is only a name, and the permission audit on
 * the next screen is the real check. So we annotate every role and disable only `blocked`.
 */
function classify(roleName: string): RoleRisk {
  const n = roleName.toLowerCase();
  if (/billing/.test(n)) return 'blocked';
  if (/administrator|(?:^|[^a-z])admin(?:[^a-z]|$)/.test(n)) return 'broad';
  if (/poweruser|power-user|full-?access/.test(n)) return 'elevated';
  if (/read-?only|view-?only|security-?audit|^audit/.test(n)) return 'readonly';
  return 'other';
}

/**
 * Step `ssoSelectTarget`. Shown when the SSO token maps to more than one account/role. Roles are
 * grouped by account, ordered narrowest-first, and graded. `Billing` is shown but not selectable;
 * everything else stays the user's choice.
 */
@Component({
  selector: 'ct-step-sso-select-target',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent],
  template: `
    <ct-wizard-shell [title]="i18n.t('sso.target.title')" [subtitle]="i18n.t('sso.target.subtitle')">
      <p class="ct-alert ct-alert--warning note">{{ i18n.t('sso.target.note') }}</p>

      @for (group of groups(); track group.accountId) {
        <section class="group">
          <h3>{{ group.accountName }} <span>{{ group.accountId }}</span></h3>
          <ul>
            @for (row of group.roles; track row.target.roleName) {
              <li>
                <button
                  type="button"
                  class="ct-btn ct-btn--block target"
                  [attr.data-risk]="row.risk"
                  [disabled]="row.risk === 'blocked'"
                  (click)="row.risk !== 'blocked' && store.selectSsoTarget(row.target)"
                >
                  <span class="role">{{ row.target.roleName }}</span>
                  @if (badgeKey(row.risk); as key) {
                    <span class="badge">{{ i18n.t(key) }}</span>
                  }
                </button>
              </li>
            }
          </ul>
        </section>
      }

      <div class="ct-row">
        <button type="button" class="ct-btn ct-btn--ghost" (click)="store.switchMethod()">
          {{ i18n.t('common.back') }}
        </button>
      </div>
    </ct-wizard-shell>
  `,
  styles: [
    `
      .note {
        margin: 0 0 14px;
      }
      .group {
        margin-bottom: 12px;
      }
      h3 {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ct-text-dim);
        margin: 0 0 2px;
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      h3 span {
        font-weight: 400;
        text-transform: none;
        letter-spacing: 0;
        color: var(--ct-text-faint);
        font-variant-numeric: tabular-nums;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .target {
        border: 0;
        border-bottom: 1px solid var(--ct-border-faint);
        border-radius: 0;
        background: transparent;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 2px;
        text-align: left;
      }
      .target:hover:not(:disabled) {
        background: var(--ct-inset);
      }
      .role {
        font-size: 12.5px;
      }

      [data-risk='readonly'] .role {
        color: var(--ct-ok);
        font-weight: 600;
      }
      [data-risk='elevated'] .role {
        color: var(--ct-warn);
      }
      [data-risk='broad'] .role {
        color: var(--ct-warn);
        font-weight: 600;
      }
      .target[data-risk='blocked'] {
        opacity: 0.38;
        cursor: not-allowed;
      }

      .badge {
        flex: none;
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      [data-risk='readonly'] .badge {
        background: color-mix(in srgb, var(--ct-ok) 14%, transparent);
        color: var(--ct-ok);
      }
      [data-risk='elevated'] .badge {
        background: var(--ct-warn-bg);
        color: var(--ct-warn);
      }
      [data-risk='broad'] .badge {
        background: var(--ct-warn-bg);
        color: var(--ct-warn);
        border-color: currentColor;
      }
      [data-risk='blocked'] .badge {
        background: var(--ct-inset);
        color: var(--ct-text-faint);
      }
    `,
  ],
})
export class SsoSelectTargetComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected badgeKey(risk: RoleRisk): MessageKey | undefined {
    return BADGE_KEY[risk];
  }

  protected readonly groups = computed<AccountGroup[]>(() => {
    const s = this.store.state();
    const targets: readonly SsoTarget[] = s.step === 'ssoSelectTarget' ? s.targets : [];

    const byAccount = new Map<string, AccountGroup>();
    for (const target of targets) {
      let group = byAccount.get(target.accountId);
      if (!group) {
        group = { accountId: target.accountId, accountName: target.accountName, roles: [] };
        byAccount.set(target.accountId, group);
      }
      group.roles.push({ target, risk: classify(target.roleName) });
    }

    const groups = [...byAccount.values()];
    for (const group of groups) {
      group.roles.sort(
        (a, b) =>
          RISK_ORDER[a.risk] - RISK_ORDER[b.risk] ||
          a.target.roleName.localeCompare(b.target.roleName),
      );
    }
    return groups;
  });
}
