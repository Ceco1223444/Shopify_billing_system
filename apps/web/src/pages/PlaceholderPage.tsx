import { useTranslation } from 'react-i18next';

export type PlaceholderPageKey =
  'shipments' | 'import' | 'products' | 'stock' | 'reports' | 'settings';

/** Empty page with its title. Each phase replaces one of these with the real screen. */
export function PlaceholderPage({ page }: { page: PlaceholderPageKey }) {
  const { t } = useTranslation();
  return (
    <section>
      <h1>{t(`pages.${page}.title`)}</h1>
      <p>{t(`pages.${page}.intro`)}</p>
      <p className="muted">{t('pages.comingSoon')}</p>
    </section>
  );
}
