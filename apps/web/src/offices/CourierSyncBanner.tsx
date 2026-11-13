import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import type { SupportedCarrier } from '@happyhome/core';
import { Icon } from '../components/Icon';
import { fetchSyncRuns, subscribeSyncRuns } from './data';
import { failedCarriers } from './syncStatus';

/**
 * P4-10: red banner for the owner when a courier's office list did not update
 * ("Списъкът с офиси на Спиди не се обнови"). The old list stays in use; the banner goes away
 * after the next successful update. Checked on every page change and whenever the offices page
 * reloads the runs.
 */
export function CourierSyncBanner() {
  const { t } = useTranslation();
  const location = useLocation();
  const [failed, setFailed] = useState<SupportedCarrier[]>([]);

  // The offices page reloads the runs while a sync is going: follow those too.
  useEffect(() => subscribeSyncRuns((runs) => setFailed(failedCarriers(runs))), []);

  useEffect(() => {
    // The listener above receives the result. A failed check shows no banner: the offices
    // page shows that error.
    fetchSyncRuns().catch(() => undefined);
  }, [location.pathname]);

  if (!failed.length) return null;
  return (
    <div className="notice notice-error" role="alert" data-testid="courier-sync-banner">
      {failed.map((carrier) => (
        <p key={carrier}>
          <Icon name="error" /> {t(`offices.banner.${carrier}`)}
        </p>
      ))}
      {location.pathname !== '/offices' && (
        <Link className="button-secondary" to="/offices">
          {t('offices.banner.link')}
        </Link>
      )}
    </div>
  );
}
