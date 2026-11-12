import { APP_LOCALES } from '@happyhome/core';
import { useTranslation } from 'react-i18next';
import { currentLocale, setLocale } from '../i18n';

export function LanguageToggle() {
  const { t } = useTranslation();
  const active = currentLocale();
  return (
    <div className="lang-toggle" role="group" aria-label={t('language.label')}>
      {APP_LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={active === locale}
          title={t(locale === 'bg' ? 'language.bgName' : 'language.enName')}
          onClick={() => void setLocale(locale)}
        >
          {t(locale === 'bg' ? 'language.bg' : 'language.en')}
        </button>
      ))}
    </div>
  );
}
