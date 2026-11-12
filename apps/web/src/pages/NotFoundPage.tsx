import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section>
      <h1>{t('pages.notFound.title')}</h1>
      <p>
        <Link to="/shipments">{t('pages.notFound.back')}</Link>
      </p>
    </section>
  );
}
