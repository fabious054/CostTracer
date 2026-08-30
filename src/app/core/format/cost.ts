import { Locale } from '../i18n/messages';

/**
 * Money formatting for the estimated-cost lines (ADR 0003). The core ships USD figures + a fixed
 * USD→BRL rate; this is the webview's whole job on top: format USD, and — only when the UI is in
 * Portuguese — append the approximate BRL conversion in parentheses (never replacing the USD).
 * The surrounding "estimated / projection / approximate" wording comes from i18n, not here.
 */

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatBrl(amount: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * `$3.65` in English; `$3.65 (~R$ 19,71)` in Portuguese. Pass `withBrl = false` to keep the
 * BRL suffix off aggregate figures (detector/group/account-context totals), where it just
 * doubles the string length and forces the pt layout to wrap — BRL stays on the headline
 * figure and the per-resource chip.
 */
export function formatMoney(
  monthlyUsd: number,
  locale: Locale,
  fxUsdBrl: number,
  withBrl = true,
): string {
  const usd = formatUsd(monthlyUsd);
  if (!withBrl || locale !== 'pt' || !fxUsdBrl) return usd;
  return `${usd} (~${formatBrl(monthlyUsd * fxUsdBrl)})`;
}
