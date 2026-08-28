import { computed, effect, Injectable, signal } from '@angular/core';
import { Locale, LOCALES, MESSAGES, MessageKey } from './messages';

const STORAGE_KEY = 'ct.locale';

function detectInitial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'pt') return saved;
  } catch {
    /* private mode / storage blocked */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return nav.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

/**
 * Runtime i18n. `t()` reads the `locale` signal, so any template expression that calls it
 * re-evaluates when the language changes (zoneless + signals — no reload, no rebuild).
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly locale = signal<Locale>(detectInitial());
  readonly locales = LOCALES;

  private readonly dict = computed(() => MESSAGES[this.locale()]);

  constructor() {
    effect(() => {
      const locale = this.locale();
      try {
        localStorage.setItem(STORAGE_KEY, locale);
      } catch {
        /* ignore */
      }
      if (typeof document !== 'undefined') {
        document.documentElement.lang = locale;
      }
    });
  }

  readonly t = (
    key: MessageKey | (string & {}),
    params?: Record<string, string | number>,
  ): string => {
    let out: string = this.dict()[key as MessageKey] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
      }
    }
    return out;
  };

  setLocale(locale: Locale): void {
    this.locale.set(locale);
  }
}
