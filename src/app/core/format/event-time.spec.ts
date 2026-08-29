import { formatEventTime } from './event-time';

// 2026-08-29 23:58:12 local time
const ts = Math.floor(new Date(2026, 7, 29, 23, 58, 12).getTime() / 1000);

describe('formatEventTime', () => {
  it('shows date and time down to the minute, pt-BR order', () => {
    expect(formatEventTime(ts, 'pt')).toBe('29/08/2026, 23:58');
  });

  it('shows date and time for en-US, no seconds', () => {
    const out = formatEventTime(ts, 'en');
    expect(out).toContain('08/29/2026');
    expect(out).toMatch(/11:58\s?PM/i);
    expect(out).not.toMatch(/:12/); // seconds dropped
  });
});
