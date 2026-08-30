import { formatBrl, formatMoney, formatUsd } from './cost';

describe('cost formatting', () => {
  it('formats USD with two decimals', () => {
    expect(formatUsd(3.65)).toBe('$3.65');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('formats BRL in pt-BR style', () => {
    // non-breaking space between R$ and the number
    expect(formatBrl(19.71).replace(/ /g, ' ')).toBe('R$ 19,71');
  });

  it('shows USD only in English', () => {
    expect(formatMoney(10, 'en', 5.4)).toBe('$10.00');
  });

  it('appends an approximate BRL conversion in Portuguese, never replacing USD', () => {
    const out = formatMoney(10, 'pt', 5.4).replace(/ /g, ' ');
    expect(out).toBe('$10.00 (~R$ 54,00)');
  });

  it('falls back to USD only when no rate is available', () => {
    expect(formatMoney(10, 'pt', 0)).toBe('$10.00');
  });
});
