import {
  displayPhone,
  formatDateTime,
  formatMoneyCents,
  isOpenStatus,
  packerCanSee,
  telHref,
} from '@happyhome/core';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useMember } from '../auth/AuthProvider';
import { FlagList, type FlagItem } from '../components/FlagBadge';
import { Icon } from '../components/Icon';
import { currentLocale } from '../i18n';
import {
  codOf,
  contentsOf,
  keepApart,
  loadShipment,
  mergeShipments,
  mergeTarget,
  reasonsOf,
  splitOrder,
  useShipmentChanges,
  type ActionError,
  type FlagRow,
  type LoadedShipment,
} from './data';
import { DeliveryCard } from './DeliveryCard';
import { CombinedChip, StatusBadge } from './parts';

interface SideBySideOrder {
  order_id: string;
  order: string;
  created_at: string | null;
  name: string | null;
  phone: string | null;
  address: string | null;
  total_cents: number | null;
  products: { sku: string | null; name: string; quantity: number | null }[];
}

/** P3-08: both orders side by side. */
function SideBySide({ orders }: { orders: SideBySideOrder[] }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const rows: { label: string; value: (o: SideBySideOrder) => ReactNode }[] = [
    {
      label: t('shipments.detail.dupCreated'),
      value: (o) => (o.created_at ? formatDateTime(o.created_at, locale) : '—'),
    },
    { label: t('shipments.detail.dupName'), value: (o) => o.name ?? '—' },
    { label: t('shipments.detail.dupPhone'), value: (o) => o.phone ?? '—' },
    { label: t('shipments.detail.dupAddress'), value: (o) => o.address ?? '—' },
    {
      label: t('shipments.detail.dupProducts'),
      value: (o) => (
        <ul className="plain-list">
          {o.products.map((p, i) => (
            <li key={i}>
              {t('shipments.detail.contentsLine', { quantity: p.quantity ?? 1, name: p.name })}
            </li>
          ))}
        </ul>
      ),
    },
    {
      label: t('shipments.detail.dupTotal'),
      value: (o) => (o.total_cents != null ? formatMoneyCents(o.total_cents) : '—'),
    },
  ];
  return (
    <div className="table-wrap">
      <table className="table side-by-side" data-testid="side-by-side">
        <caption className="sr-only">{t('shipments.detail.duplicateTitle')}</caption>
        <thead>
          <tr>
            <th />
            {orders.map((o) => (
              <th key={o.order_id}>{o.order}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {orders.map((o) => (
                <td key={o.order_id}>{r.value(o)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Confirm({
  text,
  yes,
  busy,
  onYes,
  onNo,
  testId,
}: {
  text: string;
  yes: string;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="confirm" role="group" aria-label={text}>
      <p>
        <strong>{text}</strong>
      </p>
      <div className="row actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={onYes}
          data-testid={testId}
        >
          {yes}
        </button>
        <button type="button" onClick={onNo}>
          {t('shipments.merge.cancel')}
        </button>
      </div>
    </div>
  );
}

export function ShipmentPage() {
  const { t } = useTranslation();
  const { shipmentId = '' } = useParams();
  const member = useMember();
  const navigate = useNavigate();
  const isOwner = member.role === 'owner';
  const locale = currentLocale();
  const [loaded, setLoaded] = useState<{ id: string; data: LoadedShipment | null } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null); // which confirm is open
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; link?: string } | null>(null);

  const reload = useCallback(() => {
    loadShipment(shipmentId)
      .then((d) => setLoaded({ id: shipmentId, data: d }))
      .catch(() => setFailedId(shipmentId));
  }, [shipmentId]);

  useEffect(() => {
    let cancelled = false;
    loadShipment(shipmentId)
      .then((d) => {
        if (!cancelled) setLoaded({ id: shipmentId, data: d });
      })
      .catch(() => {
        if (!cancelled) setFailedId(shipmentId);
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId]);
  useShipmentChanges(`shipment:${shipmentId}`, reload);

  const data = loaded?.id === shipmentId ? loaded.data : undefined;
  const back = (
    <p>
      <Link to="/shipments">{t('shipments.detail.back')}</Link>
    </p>
  );
  if (failedId === shipmentId)
    return <p className="badge badge-error">{t('shipments.loadFailed')}</p>;
  if (data === undefined) return <p className="muted">{t('app.loading')}</p>;
  if (data === null)
    return (
      <section>
        {back}
        <p>{t('shipments.detail.notFound')}</p>
      </section>
    );

  const s = data.shipment;
  if (!isOwner && !packerCanSee(s)) {
    return (
      <section>
        {back}
        <p className="badge badge-info" data-testid="packer-hidden">
          <Icon name="info" /> {t('shipments.detail.packerHidden')}
        </p>
      </section>
    );
  }

  const open = isOpenStatus(s.status);
  const fail = (error: ActionError) =>
    setMessage({ ok: false, text: t(`shipments.error.${error}`) });

  const doSplit = async (orderId: string, orderName: string) => {
    setBusy(true);
    const r = await splitOrder(orderId, s.version);
    setBusy(false);
    setAsking(null);
    if ('error' in r) fail(r.error);
    else
      setMessage({
        ok: true,
        text: t('shipments.detail.splitDone', { order: orderName }),
        link: `/shipments/${r.newId}`,
      });
    reload();
  };

  const doMerge = async (otherId: string) => {
    setBusy(true);
    const other = await loadShipment(otherId);
    if (!other) {
      setBusy(false);
      fail('other');
      return;
    }
    // The earlier shipment keeps its place; this page follows the merged shipment.
    const [target, source] = mergeTarget(s, other.shipment);
    const r = await mergeShipments(target, source);
    setBusy(false);
    setAsking(null);
    if ('error' in r) {
      fail(r.error);
      reload();
    } else if (r.id !== shipmentId) navigate(`/shipments/${r.id}`);
    else reload();
  };

  const doKeepApart = async (otherId: string) => {
    setBusy(true);
    const error = await keepApart(shipmentId, otherId);
    setBusy(false);
    if (error) fail(error);
    else setMessage({ ok: true, text: t('shipments.detail.keptApart') });
    reload();
  };

  const orderName = new Map(data.orders.map((o) => [o.id, o.name]));
  const openFlags = data.flags.filter((f) => f.resolved_at === null);
  const resolved = data.flags.length - openFlags.length;

  const extraFor = (f: FlagRow): ReactNode => {
    const d = (f.details ?? {}) as {
      other_shipment_id?: string;
      other_reference?: string;
      related?: { order_id: string; order: string }[];
      orders?: SideBySideOrder[];
    };
    if (f.code === 'MERGE_SUGGESTED' && d.other_shipment_id) {
      const other = d.other_shipment_id;
      return (
        <div>
          <Link to={`/shipments/${other}`}>{t('shipments.detail.openOther')}</Link>
          {isOwner && open && f.resolved_at === null && (
            <>
              {asking === `merge:${f.id}` ? (
                <Confirm
                  text={t('shipments.detail.mergeConfirm', { reference: d.other_reference ?? '' })}
                  yes={t('shipments.merge.confirm')}
                  busy={busy}
                  onYes={() => void doMerge(other)}
                  onNo={() => setAsking(null)}
                  testId="merge-suggested-confirm"
                />
              ) : (
                <div className="row actions">
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => setAsking(`merge:${f.id}`)}
                    data-testid="merge-suggested"
                  >
                    {t('shipments.detail.mergeWith', { reference: d.other_reference ?? '' })}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void doKeepApart(other)}
                    data-testid="keep-apart"
                  >
                    {t('shipments.detail.keepApart')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      );
    }
    if (f.code === 'CUSTOMER_HAS_WAYBILLED_SHIPMENT' && d.other_shipment_id) {
      return (
        <Link to={`/shipments/${d.other_shipment_id}`}>{t('shipments.detail.openOther')}</Link>
      );
    }
    if (
      (f.code === 'DUPLICATE_ORDER_SUSPECTED' || f.code === 'SIMILAR_ORDER_SUSPECTED') &&
      d.orders
    ) {
      return <SideBySide orders={d.orders} />;
    }
    if (d.related?.length) {
      return (
        <p className="related">
          {t('shipments.detail.related')}{' '}
          {d.related.map((r, i) => {
            const where = data.shipmentOfOrder.get(r.order_id);
            return (
              <span key={r.order_id}>
                {i > 0 && ', '}
                {where ? <Link to={`/shipments/${where}`}>{r.order}</Link> : r.order}
              </span>
            );
          })}
        </p>
      );
    }
    return null;
  };

  const items: FlagItem[] = openFlags
    .slice()
    .sort(
      (a, b) =>
        ['red', 'amber', 'info'].indexOf(a.severity) - ['red', 'amber', 'info'].indexOf(b.severity),
    )
    .map((f) => ({
      id: f.id,
      severity: f.severity as FlagItem['severity'],
      message: locale === 'bg' ? f.message_bg : f.message_en,
      reason: locale === 'bg' ? f.reason_bg : f.reason_en,
      order: f.order_id ? (orderName.get(f.order_id) ?? null) : null,
      extra: extraFor(f),
    }));

  const cod = codOf(s);
  const contents = contentsOf(s);
  const tel = telHref(s.recipient_phone_norm);

  return (
    <section data-testid="shipment-detail">
      {back}
      <h1 data-testid="shipment-reference">{s.reference}</h1>
      <div className="row wrap">
        <StatusBadge status={s.status} />
        <CombinedChip by={s.combined_by} />
      </div>

      {message && (
        <p
          className={`badge ${message.ok ? 'badge-ok' : 'badge-error'}`}
          role="status"
          data-testid="detail-message"
        >
          <Icon name={message.ok ? 'ok' : 'error'} /> {message.text}{' '}
          {message.link && <Link to={message.link}>{t('shipments.detail.openNew')}</Link>}
        </p>
      )}

      <h2>{t('shipments.detail.flags')}</h2>
      <div className="card" data-testid="shipment-flags">
        {items.length ? (
          <FlagList flags={items} />
        ) : (
          <p className="muted">{t('shipments.detail.noFlags')}</p>
        )}
        {resolved > 0 && (
          <p className="muted">{t('shipments.detail.resolved', { count: resolved })}</p>
        )}
      </div>

      <DeliveryCard shipment={s} orders={data.orders} isOwner={isOwner} onChanged={reload} />

      <div className="grid-2">
        <div className="card">
          <h2>{t('shipments.detail.recipient')}</h2>
          <dl className="kv">
            <dt>{t('shipments.detail.recipient')}</dt>
            <dd>{s.recipient_name ?? '—'}</dd>
            <dt>{t('shipments.detail.phone')}</dt>
            <dd>
              {tel ? (
                <>
                  <a href={tel} className="tel-link">
                    <Icon name="phone" /> {displayPhone(s.recipient_phone_norm)}
                  </a>
                  {s.recipient_phone_raw && (
                    <div className="muted">
                      {t('shipments.detail.phoneTyped', { phone: s.recipient_phone_raw })}
                    </div>
                  )}
                </>
              ) : (
                <span className="muted">
                  {s.recipient_phone_raw || t('shipments.detail.noPhone')}
                </span>
              )}
            </dd>
            <dt>{t('shipments.detail.email')}</dt>
            <dd className="wrap-anywhere">{s.recipient_email ?? '—'}</dd>
            <dt>{t('shipments.detail.address')}</dt>
            <dd>
              {[s.address1, s.address2].filter(Boolean).join(', ')}
              <div>{[s.zip, s.city].filter(Boolean).join(' ')}</div>
            </dd>
          </dl>
          {(s.order_count ?? 0) > 1 && (
            <p className="muted">{t('shipments.detail.fromEarliest')}</p>
          )}
        </div>

        <div className="card">
          <h2>{t('shipments.detail.cod')}</h2>
          <p data-testid="cod-total">
            <strong>
              {s.cod_cents
                ? t('shipments.detail.codTotal', { amount: formatMoneyCents(s.cod_cents) })
                : t('shipments.detail.codNone')}
            </strong>
          </p>
          <table className="table" data-testid="cod-breakdown">
            <thead>
              <tr>
                <th>{t('shipments.detail.codOrder')}</th>
                <th>{t('shipments.detail.codPayment')}</th>
                <th className="num">{t('shipments.detail.codAmount')}</th>
                <th>{t('shipments.detail.codSource')}</th>
              </tr>
            </thead>
            <tbody>
              {cod.map((c) => (
                <tr key={c.order_id}>
                  <td>{c.order}</td>
                  <td>
                    {c.cod
                      ? t('shipments.detail.paymentCod')
                      : t('shipments.detail.paymentPrepaid')}
                  </td>
                  <td className="num">{formatMoneyCents(c.amount_cents)}</td>
                  <td>{t(`shipments.detail.source.${c.source}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>{t('shipments.detail.contents')}</h2>
        {contents.length ? (
          <ul className="plain-list" data-testid="contents">
            {contents.map((c, i) => (
              <li key={i}>
                {t('shipments.detail.contentsLine', { quantity: c.quantity ?? 1, name: c.name })}{' '}
                <span className="muted">
                  {c.sku ? `${c.sku} · ` : ''}
                  {c.order}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('shipments.detail.noContents')}</p>
        )}
      </div>

      <h2>{t('shipments.detail.orders')}</h2>
      <ul className="order-cards" data-testid="shipment-orders">
        {data.orders.map((o) => (
          <li key={o.id} className="card" data-order={o.name}>
            <p>
              <strong>{o.name}</strong>{' '}
              <span className="muted">
                {o.created_at_shopify &&
                  t('shipments.detail.orderCreated', {
                    date: formatDateTime(o.created_at_shopify, locale),
                  })}
              </span>
            </p>
            <p className="muted">
              {[
                o.shipping_name,
                o.phone_raw,
                o.payment_method,
                o.total_cents != null ? formatMoneyCents(o.total_cents) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {isOwner && open && data.orders.length > 1 && (
              <>
                {asking === `split:${o.id}` ? (
                  <Confirm
                    text={t('shipments.detail.splitConfirm', { order: o.name })}
                    yes={t('shipments.detail.splitYes')}
                    busy={busy}
                    onYes={() => void doSplit(o.id, o.name)}
                    onNo={() => setAsking(null)}
                    testId="split-confirm"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setAsking(`split:${o.id}`)}
                    data-testid="split"
                  >
                    {t('shipments.detail.split')}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      <h2>{t('shipments.detail.why')}</h2>
      <ul className="plain-list muted" data-testid="decision-reasons">
        {reasonsOf(s).map((r, i) => (
          <li key={i}>{locale === 'bg' ? r.bg : r.en}</li>
        ))}
      </ul>
    </section>
  );
}
