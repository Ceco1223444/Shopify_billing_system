import { DEFAULT_LOCALE, INTL_LOCALE, isAppLocale, type AppLocale } from '@happyhome/core';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import bg from './locales/bg.json';
import en from './locales/en.json';

export const resources = {
  bg: { translation: bg },
  en: { translation: en },
} as const;

const STORAGE_KEY = 'happyhome.locale';

/** The chosen language is a per-computer convenience; storage may be unavailable. */
function readStoredLocale(): AppLocale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isAppLocale(stored)) return stored;
  } catch {
    // private window or blocked storage: fall back to Bulgarian
  }
  return DEFAULT_LOCALE;
}

function applyDocumentLocale(locale: AppLocale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.title = i18n.t('app.documentTitle');
}

export function currentLocale(): AppLocale {
  return isAppLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LOCALE;
}

export function intlLocale(): string {
  return INTL_LOCALE[currentLocale()];
}

export async function setLocale(locale: AppLocale): Promise<void> {
  await i18n.changeLanguage(locale);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // not remembered on this computer; the choice still applies until reload
  }
  applyDocumentLocale(locale);
}

export const i18nReady = i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: readStoredLocale(),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: ['bg', 'en'],
    interpolation: { escapeValue: false }, // React escapes already
  })
  .then(() => applyDocumentLocale(currentLocale()));

export default i18n;
