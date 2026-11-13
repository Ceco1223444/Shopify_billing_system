import { compareShipments, formatMoneyCents, isOpenStatus, visibleToPacker } from '@happyhome/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useMember } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import {
  loadShipments,
  mergeShipments,
  mergeTarget,
  useShipmentChanges,
  type ActionError,
  type ShipmentRow,
} from './data';
import { CombinedChip, FlagCounts, StatusBadge } from './parts';

type Filter = 'check' | 'ready' | 'open' | 'all';

const FILTERS: Record<Filter, (s: ShipmentRow) => boolean> = {
  check: (s) => s.status === 'needs_check' || s.status === 'imported',
  ready: (s) => s.status === 'ready',
  open: (s) => isOpenStatus(s.status),
  all: () => true,
};

export function ShipmentsPage() {
  const { t } = useTranslation();
  const member = useMember();
  const isOwner = member.role === 'owner';
  const [rows, setRows] = useState<ShipmentRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(() => {
    loadShipments()
      .then((data) => {
        setRows(data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadShipments()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useShipmentChanges('shipments-list', reload);

  // Packers never see shipments that wait for the owner's check (P3-15).
  const mine = useMemo(
    () => (rows ?? []).filter((s) => isOwner || visibleToPacker(s.status)).sort(compareShipments),
    [rows, isOwner],
  );
  const hiddenFromPacker = isOwner
    ? 0
    : (rows ?? []).filter((s) => !visibleToPacker(s.status)).length;
  const shown = mine.filter(FILTERS[filter]);
  const filters: Filter[] = isOwner ? ['check', 'ready', 'open', 'all'] : ['ready', 'open', 'all'];

  const chosen = mine.filter((s) => s.id && selected.includes(s.id));
  const canMerge = chosen.length === 2 && chosen.every((s) => isOpenStatus(s.status));

  const toggle = (id: string) => {
    setMessage(null);
    setConfirming(false);
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const merge = async () => {
    if (!canMerge) return;
    const [target, source] = mergeTarget(chosen[0]!, chosen[1]!);
    setBusy(true);
    const result = await mergeShipments(target, source);
    setBusy(false);
    setConfirming(false);
    if ('error' in result) {
      setMessage({ ok: false, text: t(`shipments.error.${result.error satisfies ActionError}`) });
    } else {
      setSelected([]);
      setMessage({
        ok: true,
        text: t('shipments.merge.done', {
          reference: `${target.reference ?? ''} + ${source.reference ?? ''}`,
        }),
      });
    }
    reload();
  };

  if (failed && !rows) return <p className="badge badge-error">{t('shipments.loadFailed')}</p>;

  return (
    <section>
      <h1>{t('pages.shipments.title')}</h1>
      <p>{t('pages.shipments.intro')}</p>

      {hiddenFromPacker > 0 && (
        <p className="badge badge-info" data-testid="packer-waiting">
          <Icon name="info" /> {t('shipments.packerWaiting', { count: hiddenFromPacker })}
        </p>
      )}

      <div className="segmented" role="group" aria-label={t('shipments.filter.label')}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            data-testid={`filter-${f}`}
          >
            {t(`shipments.filter.${f}`)} ({mine.filter(FILTERS[f]).length})
          </button>
        ))}
      </div>

      {isOwner && selected.length > 0 && (
        <div className="card action-bar" data-testid="merge-bar">
          <p>{t('shipments.merge.selected', { count: selected.length })}</p>
          {!canMerge && <p className="muted">{t('shipments.merge.needTwo')}</p>}
          {!confirming ? (
            <div className="row actions">
              <button
                type="button"
                className="button-primary"
                disabled={!canMerge}
                onClick={() => setConfirming(true)}
                data-testid="merge-selected"
              >
                {t('shipments.merge.button')}
              </button>
              <button type="button" onClick={() => setSelected([])}>
                {t('shipments.merge.clear')}
              </button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label={t('shipments.merge.confirmTitle')}>
              <p>
                <strong>{t('shipments.merge.confirmTitle')}</strong>
              </p>
              <p>
                {t('shipments.merge.confirmText', {
                  a: chosen[0]?.reference ?? '',
                  b: chosen[1]?.reference ?? '',
                })}
              </p>
              <div className="row actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy}
                  onClick={() => void merge()}
                  data-testid="merge-confirm"
                >
                  {t('shipments.merge.confirm')}
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  {t('shipments.merge.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {message && (
        <p
          className={`badge ${message.ok ? 'badge-ok' : 'badge-error'}`}
          role="status"
          data-testid="list-message"
        >
          <Icon name={message.ok ? 'ok' : 'error'} /> {message.text}
        </p>
      )}

      {!rows ? (
        <p className="muted">{t('app.loading')}</p>
      ) : !shown.length ? (
        <p className="muted">{t('shipments.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table shipment-table" data-testid="shipment-list">
            <thead>
              <tr>
                {isOwner && (
                  <th className="mark-col">
                    <span className="sr-only">{t('shipments.col.select')}</span>
                  </th>
                )}
                <th>{t('shipments.col.orders')}</th>
                <th>{t('shipments.col.recipient')}</th>
                <th>{t('shipments.col.city')}</th>
                <th className="num">{t('shipments.col.cod')}</th>
                <th>{t('shipments.col.status')}</th>
                <th>{t('shipments.col.flags')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} data-shipment={s.id} data-reference={s.reference}>
                  {isOwner && (
                    <td className="mark-col">
                      {isOpenStatus(s.status) && (
                        <input
                          type="checkbox"
                          className="row-check"
                          checked={selected.includes(s.id!)}
                          onChange={() => toggle(s.id!)}
                          aria-label={t('shipments.selectOne', { reference: s.reference ?? '' })}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <Link to={`/shipments/${s.id}`} className="shipment-ref">
                      {s.reference}
                    </Link>
                    <div>
                      <CombinedChip by={s.combined_by} />
                    </div>
                  </td>
                  <td>
                    {s.recipient_name}
                    {s.recipient_phone_raw && <div className="muted">{s.recipient_phone_raw}</div>}
                  </td>
                  <td>{s.city}</td>
                  <td className="num">
                    {s.cod_cents ? (
                      formatMoneyCents(s.cod_cents)
                    ) : (
                      <span className="muted">{t('shipments.noCod')}</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>
                    <FlagCounts red={s.flags_red} amber={s.flags_amber} info={s.flags_info} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
