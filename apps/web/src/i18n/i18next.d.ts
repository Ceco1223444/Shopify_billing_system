import 'i18next';
import type bg from './locales/bg.json';

// Type-checks every t('...') key against the Bulgarian locale file.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof bg;
    };
  }
}
