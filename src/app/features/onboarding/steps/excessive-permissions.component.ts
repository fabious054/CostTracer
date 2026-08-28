import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConnectionStore } from '../../../core/connection/connection.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { MessageKey } from '../../../core/i18n/messages';
import { RiskFinding } from '../../../core/models/aws';
import { PolicyBlockComponent } from '../ui/policy-block.component';
import { WizardShellComponent } from '../ui/wizard-shell.component';

interface FindingGroup {
  headingKey: MessageKey;
  count: number;
  labels: string[];
}

/**
 * Step `excessivePermissions`. The audit can return a dozen near-identical findings (one per
 * simulated action), so they are grouped by kind: one explanation line + a compact scrollable
 * list of the offending names. The two actions stay visible below.
 */
@Component({
  selector: 'ct-step-excessive-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WizardShellComponent, PolicyBlockComponent],
  template: `
    @if (view(); as v) {
      <ct-wizard-shell [title]="i18n.t('excessive.title')" [subtitle]="i18n.t('excessive.subtitle')">
        <div class="ct-alert ct-alert--warning" role="alert">
          <strong>{{ i18n.t('excessive.strong') }}</strong>
          {{ i18n.t('excessive.checkedVia', { method: i18n.t(methodKey(v.audit.method)) }) }}
        </div>

        @for (group of groups(); track group.headingKey) {
          <p class="group-head">{{ i18n.t(group.headingKey, { count: group.count }) }}</p>
          <ul class="names">
            @for (label of group.labels; track label) {
              <li>{{ label }}</li>
            }
          </ul>
        }

        <ct-policy-block [policy]="v.recommendedPolicy" />

        <div class="ct-row">
          <button type="button" class="ct-btn ct-btn--danger" (click)="store.acceptRiskAndContinue()">
            {{ i18n.t('excessive.continue') }}
          </button>
          <button type="button" class="ct-btn" (click)="store.switchMethod()">
            {{ i18n.t('excessive.goBack') }}
          </button>
        </div>
      </ct-wizard-shell>
    }
  `,
  styles: [
    `
      .group-head {
        margin: 12px 0 6px;
        font-size: 12px;
      }
      .names {
        list-style: none;
        margin: 0 0 4px;
        padding: 6px 10px;
        background: var(--ct-inset);
        border-radius: var(--ct-radius-sm);
        max-height: 148px;
        overflow-y: auto;
        font-family: var(--ct-mono);
        font-size: 11.5px;
        line-height: 1.65;
      }
      .names li {
        white-space: nowrap;
      }
      ct-policy-block {
        display: block;
        margin: 14px 0 16px;
      }
    `,
  ],
})
export class ExcessivePermissionsComponent {
  protected readonly store = inject(ConnectionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly view = computed(() => {
    const s = this.store.state();
    return s.step === 'excessivePermissions' ? s : null;
  });

  protected readonly groups = computed<FindingGroup[]>(() => {
    const audit = this.view()?.audit;
    if (!audit) return [];
    const byKind = new Map<RiskFinding['kind'], string[]>();
    for (const f of audit.findings) {
      const list = byKind.get(f.kind) ?? [];
      list.push(f.label);
      byKind.set(f.kind, list);
    }
    return [...byKind.entries()].map(([kind, labels]) => ({
      headingKey: this.headingKey(kind),
      count: labels.length,
      labels,
    }));
  });

  private headingKey(kind: RiskFinding['kind']): MessageKey {
    switch (kind) {
      case 'broad-managed-policy':
        return 'excessive.kind.broadManagedPolicy';
      case 'wildcard-action-statement':
        return 'excessive.kind.wildcardActionStatement';
      default:
        return 'excessive.kind.simulatedActionAllowed';
    }
  }

  protected methodKey(m: 'simulate' | 'list-policies' | 'inconclusive'): MessageKey {
    return m === 'simulate'
      ? 'auditMethod.simulate'
      : m === 'list-policies'
        ? 'auditMethod.listPolicies'
        : 'auditMethod.inconclusive';
  }
}
