import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { LOCALES, MESSAGES } from './messages';

describe('i18n', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  it('has the same set of keys in every locale', () => {
    const [reference, ...rest] = LOCALES.map((l) => Object.keys(MESSAGES[l]).sort());
    for (const keys of rest) {
      expect(keys).toEqual(reference);
    }
  });

  it('has no empty strings', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim().length).withContext(`${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('translates, substitutes params, switches at runtime, and falls back to the key', () => {
    const i18n = TestBed.inject(I18nService);

    i18n.setLocale('en');
    expect(i18n.t('common.back')).toBe('Back');
    expect(i18n.t('failed.method', { method: 'SSO' })).toBe('Method: SSO');

    i18n.setLocale('pt');
    expect(i18n.t('common.back')).toBe('Voltar');
    expect(i18n.t('failed.method', { method: 'SSO' })).toBe('Método: SSO');

    expect(i18n.t('this.key.does.not.exist')).toBe('this.key.does.not.exist');
  });
});
