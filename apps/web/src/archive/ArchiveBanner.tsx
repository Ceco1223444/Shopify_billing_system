import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Icon } from '../components/Icon';
import { useArchive } from './ArchiveProvider';

/** P2-21: "N CSV файла чакат архивиране" for the owner, until the files are archived. */
export function ArchiveBanner() {
  const { t } = useTranslation();
  const archive = useArchive();
  const location = useLocation();
  if (!archive || archive.busy || !archive.waiting.length) return null;
  return (
    <div className="notice notice-warn" role="status" data-testid="archive-banner">
      <p>
        <Icon name="warn" /> {t('settings.archive.banner', { count: archive.waiting.length })}
      </p>
      {location.pathname !== '/settings' && (
        <Link className="button-secondary" to="/settings#archive">
          {t('settings.archive.bannerLink')}
        </Link>
      )}
    </div>
  );
}
