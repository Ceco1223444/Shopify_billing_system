/**
 * Delivery chips (Phase 5): carrier badge, type icon, office name and a certainty chip with the
 * reason. Colour is never the only signal: every chip has an icon and a word.
 */
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../components/Icon';
import { currentLocale } from '../i18n';
import type { ShipmentRow } from './data';
import {
  certaintyOf,
  deliveryReasonsOf,
  pointName,
  suggestionOf,
  type Certainty,
} from './delivery';

const CERTAINTY: Record<Certainty | 'pending', { cls: string; icon: IconName }> = {
  certain: { cls: 'badge-ok', icon: 'ok' },
  uncertain: { cls: 'badge-warn', icon: 'phone' },
  error: { cls: 'badge-error', icon: 'error' },
  pending: { cls: 'badge-muted', icon: 'wait' },
};

export function CarrierBadge({ carrier }: { carrier: string | null }) {
  const { t } = useTranslation();
  if (carrier !== 'econt' && carrier !== 'speedy') return null;
  return (
    <span
      className={`carrier-badge carrier-${carrier}`}
      data-testid="carrier-badge"
      data-carrier={carrier}
    >
      {t(`offices.carrier.${carrier}`)}
    </span>
  );
}

const TYPE_ICON: Record<string, string> = {
  office: '🏢',
  locker: '📦',
  mobile: '🚐',
  address: '🏠',
};

/** Office / locker / address: an icon and the word. */
export function DeliveryTypeLabel({ type }: { type: string | null }) {
  const { t } = useTranslation();
  if (!type || !TYPE_ICON[type]) return null;
  return (
    <span className="delivery-type" data-testid="delivery-type" data-type={type}>
      <span aria-hidden="true">{TYPE_ICON[type]}</span>{' '}
      {t(`delivery.type.${type}` as 'delivery.type.office')}
    </span>
  );
}

export function CertaintyChip({ shipment }: { shipment: ShipmentRow }) {
  const { t } = useTranslation();
  const c = certaintyOf(shipment);
  const style = CERTAINTY[c ?? 'pending'];
  return (
    <span
      className={`badge badge-small ${style.cls}`}
      data-testid="certainty-chip"
      data-certainty={c ?? 'pending'}
    >
      <Icon name={style.icon} /> {t(`delivery.certainty.${c ?? 'pending'}`)}
    </span>
  );
}

/** The queue cell: badge + type + office (or the suggestion) + chip + the first reason. */
export function DeliveryCell({ shipment: s }: { shipment: ShipmentRow }) {
  const { t } = useTranslation();
  const lang = currentLocale();
  const c = certaintyOf(s);
  const sug = suggestionOf(s);
  const reason = deliveryReasonsOf(s)[0];
  return (
    <div className="delivery-cell" data-testid="delivery-cell">
      <div className="row wrap tight">
        <CarrierBadge carrier={s.carrier} />
        <DeliveryTypeLabel type={s.delivery_type} />
      </div>
      {s.office_name ? (
        <div className="office-name" data-testid="office-name">
          {s.office_name}
        </div>
      ) : sug && c !== 'certain' ? (
        <div className="muted" data-testid="delivery-suggestion">
          {t('delivery.suggested', { point: pointName(sug, lang) })}
        </div>
      ) : null}
      <CertaintyChip shipment={s} />
      {c && reason && (
        <div className="muted small" data-testid="certainty-reason">
          {lang === 'bg' ? reason.bg : reason.en}
        </div>
      )}
    </div>
  );
}
