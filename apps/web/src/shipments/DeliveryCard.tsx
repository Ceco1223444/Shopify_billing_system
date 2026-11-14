/**
 * The "Доставка" card of a shipment (Phase 5): where it goes and why, the call tools for an
 * uncertain or wrong destination (owner and packers: the owner's decision), the office picker,
 * the address correction that runs the detection again, and the owner's "decide again".
 */
import { displayPhone, formatDateTime, telHref } from '@happyhome/core';
import { addressLinks, addressText, callScript, type DetectionInput } from '@happyhome/core/detect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { currentLocale } from '../i18n';
import { fetchPointsInCity, searchPoints, type MapPoint } from '../offices/data';
import type { OrderDetail, ShipmentRow } from './data';
import {
  alternativesOf,
  certaintyOf,
  deliveryHintsOf,
  deliveryReasonsOf,
  detectNow,
  isManualDelivery,
  loadCalls,
  needsCall,
  pointName,
  recordCall,
  resetDelivery,
  scriptDecisionOf,
  suggestionOf,
  updateAddress,
  type AddressFields,
  type CallOutcome,
  type CallRow,
  type DeliveryError,
  type StoredPoint,
} from './delivery';
import { CarrierBadge, CertaintyChip, DeliveryTypeLabel } from './deliveryParts';

/** P5-18: the detection runs again this long after the last address save. */
const REDETECT_DEBOUNCE_MS = 600;

function inputOf(s: ShipmentRow): DetectionInput {
  return {
    address1: s.address1,
    address2: s.address2,
    company: null,
    notes: [],
    city: s.city,
    zip: s.zip,
    country: null,
    shippingMethod: null,
  };
}

function PointLine({
  point,
}: {
  point: Pick<StoredPoint, 'carrier' | 'type' | 'name_bg' | 'address_text'> & {
    distance_km?: number | null;
  };
}) {
  const lang = currentLocale();
  return (
    <span className="point-line">
      <CarrierBadge carrier={point.carrier} /> <DeliveryTypeLabel type={point.type} />{' '}
      <strong>{pointName(point, lang)}</strong>
      {point.address_text && <span className="muted"> · {point.address_text}</span>}
    </span>
  );
}

/** "Друг офис": search by name / address, or pick from the shipment's town. */
function PointPicker({
  city,
  busy,
  onPick,
  onClose,
}: {
  city: string | null;
  busy: boolean;
  onPick: (p: MapPoint) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MapPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!city) return;
    fetchPointsInCity(city)
      .then((points) => {
        if (!cancelled) setResults(points.slice(0, 40));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [city]);

  const search = async () => {
    if (!query.trim()) return;
    setFailed(false);
    try {
      setResults(await searchPoints(query.trim()));
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="confirm picker" data-testid="point-picker">
      <p>
        <strong>{t('delivery.picker.title')}</strong>
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="sr-only" htmlFor="picker-query">
          {t('delivery.picker.label')}
        </label>
        <input
          id="picker-query"
          value={query}
          placeholder={t('delivery.picker.label')}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="picker-query"
        />
        <button type="submit">{t('delivery.picker.search')}</button>
      </form>
      {failed && <p className="badge badge-error">{t('delivery.picker.failed')}</p>}
      {results && !results.length && <p className="muted">{t('delivery.picker.none')}</p>}
      {results && results.length > 0 && (
        <ul className="plain-list picker-results" data-testid="picker-results">
          {results.map((p) => (
            <li key={p.id} className="row wrap">
              <PointLine point={p} />
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(p)}
                data-testid="picker-choose"
                data-point={p.id}
              >
                {t('delivery.picker.choose')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row actions">
        <button type="button" onClick={onClose}>
          {t('shipments.merge.cancel')}
        </button>
      </div>
    </div>
  );
}

function AddressEditor({
  shipment: s,
  onSaved,
  onError,
  onClose,
}: {
  shipment: ShipmentRow;
  onSaved: () => void;
  onError: (e: DeliveryError) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<AddressFields>({
    address1: s.address1 ?? '',
    address2: s.address2 ?? '',
    city: s.city ?? '',
    zip: s.zip ?? '',
  });
  const [busy, setBusy] = useState(false);
  const field = (key: keyof AddressFields) => (
    <>
      <label htmlFor={`addr-${key}`}>{t(`delivery.address.${key}`)}</label>
      <input
        id={`addr-${key}`}
        value={fields[key]}
        onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
        data-testid={`addr-${key}`}
      />
    </>
  );
  const save = async () => {
    setBusy(true);
    const r = await updateAddress(s, fields);
    setBusy(false);
    if ('error' in r) onError(r.error);
    else onSaved();
  };
  return (
    <form
      className="confirm"
      data-testid="address-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {field('address1')}
      {field('address2')}
      <div className="grid-2">
        <div>{field('city')}</div>
        <div>{field('zip')}</div>
      </div>
      <p className="muted">{t('delivery.address.hint')}</p>
      <div className="row actions">
        <button type="submit" className="button-primary" disabled={busy} data-testid="address-save">
          {t('delivery.address.save')}
        </button>
        <button type="button" onClick={onClose}>
          {t('shipments.merge.cancel')}
        </button>
      </div>
    </form>
  );
}

export function DeliveryCard({
  shipment: s,
  orders,
  isOwner,
  onChanged,
}: {
  shipment: ShipmentRow;
  orders: OrderDetail[];
  isOwner: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const lang = currentLocale();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [panel, setPanel] = useState<'picker' | 'refuse' | 'address' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reloadCalls = useCallback(() => {
    loadCalls(s.id)
      .then(setCalls)
      .catch(() => setCalls([]));
  }, [s.id]);

  useEffect(() => {
    let cancelled = false;
    loadCalls(s.id)
      .then((c) => {
        if (!cancelled) setCalls(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [s.id, s.call_attempts, s.version]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const certainty = certaintyOf(s);
  const open = ['imported', 'needs_check', 'ready'].includes(s.status);
  const callNow = needsCall(s);
  const suggestion = suggestionOf(s);
  const alternatives = alternativesOf(s);
  const reasons = deliveryReasonsOf(s);
  const hints = deliveryHintsOf(s);
  const manual = isManualDelivery(s);
  const tel = telHref(s.recipient_phone_norm);
  const decision = scriptDecisionOf(s);
  const refs = orders.map((o) => o.name).join(lang === 'bg' ? ' и ' : ' and ');
  const script = decision ? callScript(decision, refs, { address: addressText(inputOf(s)) }) : null;
  const links = s.delivery_rule === 'F' ? addressLinks(inputOf(s)) : null;
  const noAnswers = calls.filter((c) => c.outcome === 'no_answer');
  const methods = [
    ...new Set(orders.flatMap((o) => (o.shipping_method ? [o.shipping_method] : []))),
  ];
  // "Потвърди предложението": the suggested point, the matched point, or a home address.
  const canConfirm = !!suggestion || !!s.office_id || s.delivery_type === 'address';

  const fail = (e: DeliveryError) => setMessage({ ok: false, text: t(`delivery.error.${e}`) });

  const outcome = async (o: CallOutcome, options: { pointId?: string; note?: string } = {}) => {
    setBusy(true);
    setMessage(null);
    const pointId =
      o === 'confirmed' ? (suggestion?.id ?? s.office_id ?? undefined) : options.pointId;
    const error = await recordCall(s, o, { pointId, note: options.note });
    setBusy(false);
    if (error) {
      fail(error);
    } else {
      setPanel(null);
      setNote('');
      setMessage({ ok: true, text: t(`delivery.done.${o}`) });
    }
    reloadCalls();
    onChanged();
  };

  // P5-18: after an address save the trigger marks the shipment for detection; run it now.
  const addressSaved = () => {
    setPanel(null);
    setMessage({ ok: true, text: t('delivery.address.saved') });
    onChanged();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void detectNow([s.id]).then(() => onChanged());
    }, REDETECT_DEBOUNCE_MS);
  };

  const reset = async () => {
    setBusy(true);
    const error = await resetDelivery(s.id);
    setBusy(false);
    if (error) fail(error);
    else {
      setMessage({ ok: true, text: t('delivery.reset.done') });
      void detectNow([s.id]).then(() => onChanged());
    }
    onChanged();
  };

  return (
    <div
      className="card delivery-card"
      data-testid="delivery-card"
      data-certainty={certainty ?? 'pending'}
    >
      <h2>{t('delivery.title')}</h2>
      <div className="row wrap">
        <CarrierBadge carrier={s.carrier} />
        <DeliveryTypeLabel type={s.delivery_type} />
        <CertaintyChip shipment={s} />
        {manual && (
          <span className="chip" data-testid="delivery-manual">
            {t('delivery.manual')}
          </span>
        )}
      </div>

      {s.office_name && (
        <p data-testid="delivery-office">
          <strong>{s.office_name}</strong>
          {s.office_address && <span className="muted"> · {s.office_address}</span>}
        </p>
      )}
      {!certainty && <p className="muted">{t('delivery.pending')}</p>}

      {message && (
        <p
          className={`badge ${message.ok ? 'badge-ok' : 'badge-error'}`}
          role="status"
          data-testid="delivery-message"
        >
          <Icon name={message.ok ? 'ok' : 'error'} /> {message.text}
        </p>
      )}

      {reasons.length > 0 && (
        <>
          <h3>{t('delivery.why')}</h3>
          <ul className="plain-list" data-testid="delivery-reasons">
            {reasons.map((r, i) => (
              <li key={i} data-code={r.code}>
                {lang === 'bg' ? r.bg : r.en}
              </li>
            ))}
          </ul>
        </>
      )}
      {hints.length > 0 && (
        <ul className="plain-list muted" data-testid="delivery-hints">
          {hints.map((h, i) => (
            <li key={i}>
              <Icon name="info" /> {lang === 'bg' ? h.bg : h.en}
            </li>
          ))}
        </ul>
      )}

      {suggestion && certainty !== 'certain' && (
        <p data-testid="delivery-suggestion">
          {t('delivery.suggestionLabel')} <PointLine point={suggestion} />
        </p>
      )}
      {alternatives.length > 0 && certainty !== 'certain' && (
        <>
          <p>{t('delivery.alternatives')}</p>
          <ul className="plain-list" data-testid="delivery-alternatives">
            {alternatives.map((p) => (
              <li key={p.id} className="row wrap">
                <PointLine point={p} />
                {callNow && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void outcome('other_point', { pointId: p.id })}
                    data-testid="choose-alternative"
                  >
                    {t('delivery.picker.choose')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {links && (
        <p className="row wrap" data-testid="address-links">
          <a href={links.maps} target="_blank" rel="noreferrer noopener">
            {t('delivery.links.maps')}
          </a>
          <a href={links.search} target="_blank" rel="noreferrer noopener">
            {t('delivery.links.search')}
          </a>
        </p>
      )}
      {methods.length > 0 && (
        <p className="muted small" data-testid="shipping-method">
          {t('delivery.shippingMethod', { method: methods.join(', ') })}
        </p>
      )}
      {/* Geoapify's free plan asks for this link; the data is OpenStreetMap's (ODbL). */}
      <p className="muted small" data-testid="geocoder-credit">
        {t('delivery.credit.lead')}{' '}
        <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer noopener">
          {t('delivery.credit.geoapify')}
        </a>
        {' · '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
          {t('delivery.credit.osm')}
        </a>
      </p>

      {callNow && (
        <div className="call-box" data-testid="call-box">
          <h3>
            <Icon name="phone" /> {t('delivery.call.title')}
          </h3>
          {tel ? (
            <p>
              <a href={tel} className="tel-link" data-testid="call-tel">
                <Icon name="phone" /> {displayPhone(s.recipient_phone_norm)}
              </a>
            </p>
          ) : (
            <p className="badge badge-warn">
              <Icon name="warn" /> {t('delivery.call.noPhone')}
            </p>
          )}
          {script && (
            <blockquote className="call-script" data-testid="call-script" lang="bg">
              {script}
            </blockquote>
          )}
          {noAnswers.length > 0 && (
            <div data-testid="call-attempts">
              <p>{t('delivery.call.attempts', { count: noAnswers.length })}</p>
              <ul className="plain-list muted">
                {noAnswers.map((c) => (
                  <li key={c.id}>
                    {formatDateTime(c.created_at, lang)}
                    {c.by ? ` · ${c.by}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {panel === 'picker' ? (
            <PointPicker
              city={s.city}
              busy={busy}
              onPick={(p) => void outcome('other_point', { pointId: p.id })}
              onClose={() => setPanel(null)}
            />
          ) : panel === 'refuse' ? (
            <form
              className="confirm"
              data-testid="refuse-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) void outcome('refused', { note: note.trim() });
              }}
            >
              <label htmlFor="refuse-reason">{t('delivery.call.refuseReason')}</label>
              <input
                id="refuse-reason"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="refuse-reason"
              />
              <div className="row actions">
                <button
                  type="submit"
                  className="button-primary"
                  disabled={busy || !note.trim()}
                  data-testid="refuse-confirm"
                >
                  {t('delivery.call.refuseConfirm')}
                </button>
                <button type="button" onClick={() => setPanel(null)}>
                  {t('shipments.merge.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <div className="row actions call-actions">
              {canConfirm && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy}
                  onClick={() => void outcome('confirmed')}
                  data-testid="call-confirm"
                >
                  <Icon name="ok" /> {t('delivery.call.confirm')}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => setPanel('picker')}
                data-testid="call-other-point"
              >
                {t('delivery.call.otherPoint')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void outcome('home_address')}
                data-testid="call-home"
              >
                {t('delivery.call.home')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void outcome('no_answer')}
                data-testid="call-no-answer"
              >
                {t('delivery.call.noAnswer')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPanel('refuse')}
                data-testid="call-refused"
              >
                <Icon name="error" /> {t('delivery.call.refused')}
              </button>
            </div>
          )}
        </div>
      )}

      {open && panel !== 'address' && (
        <div className="row actions">
          <button type="button" onClick={() => setPanel('address')} data-testid="address-edit">
            {t('delivery.address.edit')}
          </button>
          {isOwner && manual && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void reset()}
              data-testid="delivery-reset"
            >
              {t('delivery.reset.button')}
            </button>
          )}
        </div>
      )}
      {open && panel === 'address' && (
        <AddressEditor
          shipment={s}
          onSaved={addressSaved}
          onError={fail}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
