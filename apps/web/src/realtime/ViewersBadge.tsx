import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { formatNameList } from '../lib/listFormat';
import { usePresence } from './PresenceProvider';

/** "Мама гледа тази пратка" — shown when someone else has the same shipment open. */
export function ViewersBadge({ shipmentId }: { shipmentId: string }) {
  const { t } = useTranslation();
  const viewers = usePresence().viewersOf(shipmentId);
  if (viewers.length === 0) return null;
  return (
    <p className="badge badge-info" role="status" data-testid="viewers-badge">
      <Icon name="eyes" />{' '}
      {t('presence.viewing', { count: viewers.length, names: formatNameList(viewers) })}
    </p>
  );
}
