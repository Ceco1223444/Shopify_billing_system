import { combinedReasons } from '@happyhome/core';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../components/Icon';

const STATUS_STYLE: Record<string, { cls: string; icon: IconName }> = {
  imported: { cls: 'badge-info', icon: 'wait' },
  needs_check: { cls: 'badge-warn', icon: 'warn' },
  ready: { cls: 'badge-ok', icon: 'ok' },
  waiting_manual_waybill: { cls: 'badge-info', icon: 'wait' },
  waybill_created: { cls: 'badge-info', icon: 'check' },
  printed: { cls: 'badge-info', icon: 'check' },
  printed_draft: { cls: 'badge-info', icon: 'check' },
  handed_over: { cls: 'badge-ok', icon: 'check' },
  delivered: { cls: 'badge-ok', icon: 'ok' },
  returned: { cls: 'badge-error', icon: 'error' },
  cancelled: { cls: 'badge-error', icon: 'error' },
};

/** Status as colour + icon + word. */
export function StatusBadge({ status }: { status: string | null }) {
  const { t } = useTranslation();
  const s = STATUS_STYLE[status ?? ''] ?? { cls: 'badge-muted', icon: 'info' as const };
  return (
    <span
      className={`badge badge-small ${s.cls}`}
      data-testid="shipment-status"
      data-status={status}
    >
      <Icon name={s.icon} />{' '}
      {t(`shipments.status.${status ?? 'imported'}` as 'shipments.status.ready')}
    </span>
  );
}

/** P3-17: "Обединени: телефон" / "имейл" / "ръчно". */
export function CombinedChip({ by }: { by: readonly string[] | null }) {
  const { t } = useTranslation();
  const reasons = combinedReasons(by);
  if (!reasons.length) return null;
  return (
    <span className="chip" data-testid="combined-chip">
      {t('shipments.combined', {
        reasons: reasons.map((r) => t(`shipments.combinedBy.${r}`)).join(', '),
      })}
    </span>
  );
}

export function FlagCounts({
  red,
  amber,
  info,
}: {
  red: number | null;
  amber: number | null;
  info: number | null;
}) {
  const { t } = useTranslation();
  const all: { key: string; icon: IconName; cls: string; count: number }[] = [
    { key: 'red', icon: 'error', cls: 'count-red', count: red ?? 0 },
    { key: 'amber', icon: 'warn', cls: 'count-amber', count: amber ?? 0 },
    { key: 'info', icon: 'info', cls: 'count-info', count: info ?? 0 },
  ];
  const parts = all.filter((p) => p.count > 0);
  if (!parts.length) return <span className="muted">{t('shipments.flagCount.none')}</span>;
  return (
    <span className="flag-counts" data-testid="flag-counts">
      {parts.map((p) => (
        <span key={p.key} className={p.cls}>
          <Icon name={p.icon} />{' '}
          {t(`shipments.flagCount.${p.key}` as 'shipments.flagCount.red', { count: p.count })}
        </span>
      ))}
    </span>
  );
}
