import { Locale } from '../i18n/messages';

/**
 * The exact moment of an event — date **and** time, no seconds (e.g. `29/08/2026, 23:58`).
 * Use this everywhere the UI pins something to a precise instant (last scan, "monitored
 * since"), so two scans run on the same day are still tellable apart and an important
 * event's timing is unambiguous.
 *
 * Relative phrasings ("6 days of observation", "created 300 days ago") are a separate,
 * deliberate choice and stay day-granular — they do not go through this.
 */
export function formatEventTime(unixSecs: number, locale: Locale): string {
  const tag = locale === 'pt' ? 'pt-BR' : 'en-US';
  return new Date(unixSecs * 1000).toLocaleString(tag, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
