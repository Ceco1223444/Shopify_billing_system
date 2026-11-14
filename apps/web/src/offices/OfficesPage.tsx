import { formatDateTime, type SupportedCarrier } from '@happyhome/core';
import type { PointType } from '@happyhome/core/couriers';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMember } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { currentLocale } from '../i18n';
import { usePointTypes } from '../lib/settings';
import {
  fetchPointsInCity,
  searchPoints,
  startOfficeSync,
  useOfficeOverview,
  type MapPoint,
} from './data';
import OfficeMap from './OfficeMap';
import {
  carrierSyncState,
  countsByCarrier,
  syncErrorKey,
  type CarrierCounts,
  type CarrierSyncState,
} from './syncStatus';

const CARRIERS: SupportedCarrier[] = ['econt', 'speedy'];
/** Quick picks for the map: the biggest towns (names as the couriers write them). */
const QUICK_CITIES = ['Пловдив', 'София', 'Варна', 'Бургас', 'Русе', 'Стара Загора'];

/** P4-26 / P4-27: the owner's view of the courier offices and lockers. */
export function OfficesPage() {
  const { t } = useTranslation();
  const member = useMember();
  if (member.role !== 'owner') {
    return (
      <section>
        <h1>{t('pages.offices.title')}</h1>
        <p className="badge badge-info" data-testid="offices-owner-only">
          <Icon name="info" /> {t('offices.ownerOnly')}
        </p>
      </section>
    );
  }
  return <OwnerOffices />;
}

function OwnerOffices() {
  const { t } = useTranslation();
  const overview = useOfficeOverview();
  const types = usePointTypes();
  const allTypes = types.includes('locker') && types.includes('mobile');
  const [refresh, setRefresh] = useState<'idle' | 'starting' | 'started' | 'failed'>('idle');
  const [city, setCity] = useState<string>(QUICK_CITIES[0]!);

  const counts = useMemo(
    () => (overview.stats ? countsByCarrier(overview.stats) : null),
    [overview.stats],
  );

  async function onRefresh() {
    setRefresh('starting');
    const result = await startOfficeSync();
    setRefresh(result.ok ? 'started' : 'failed');
    await overview.reload();
  }

  return (
    <section>
      <h1>{t('pages.offices.title')}</h1>
      <p>{t('pages.offices.intro')}</p>
      {!allTypes && (
        <p className="badge badge-info" data-testid="offices-only">
          <Icon name="info" /> {t('offices.onlyOffices')}
        </p>
      )}

      <div className="row wrap">
        <button
          type="button"
          className="button-primary"
          onClick={() => void onRefresh()}
          disabled={refresh === 'starting' || overview.running}
          data-testid="offices-refresh"
        >
          {t('offices.refresh')}
        </button>
        {refresh === 'started' && (
          <p className="badge badge-info" role="status">
            <Icon name="wait" /> {t('offices.refreshStarted')}
          </p>
        )}
        {refresh === 'failed' && (
          <p className="badge badge-error" role="alert">
            <Icon name="error" /> {t('offices.refreshFailed')}
          </p>
        )}
      </div>

      {overview.error && (
        <p className="badge badge-error" role="alert">
          <Icon name="error" /> {t('offices.loadFailed')}
        </p>
      )}

      {overview.runs && counts ? (
        <div className="grid-2">
          {CARRIERS.map((carrier) => (
            <CarrierCard
              key={carrier}
              carrier={carrier}
              counts={counts[carrier]}
              types={types}
              state={carrierSyncState(overview.runs ?? [], carrier)}
            />
          ))}
        </div>
      ) : (
        !overview.error && (
          <p className="muted" role="status">
            {t('app.loading')}
          </p>
        )
      )}

      <CityMap city={city} onCity={setCity} types={types} />
      <PointSearch onShowCity={setCity} types={types} />
    </section>
  );
}

function CarrierCard({
  carrier,
  counts,
  types,
  state,
}: {
  carrier: SupportedCarrier;
  counts: CarrierCounts;
  types: PointType[];
  state: CarrierSyncState;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const status = state.running ? 'running' : state.failed ? 'failed' : state.lastOk ? 'ok' : null;
  const badge = { running: 'badge-info', failed: 'badge-error', ok: 'badge-ok' } as const;
  const icon = { running: 'wait', failed: 'error', ok: 'ok' } as const;
  const lastOkAt = state.lastOk?.finished_at ?? null;
  const unused =
    (types.includes('locker') ? 0 : counts.locker) + (types.includes('mobile') ? 0 : counts.mobile);

  return (
    <div className="card" data-testid={`offices-card-${carrier}`}>
      <h2>{t(`offices.carrier.${carrier}`)}</h2>
      {status && (
        <p className={`badge ${badge[status]}`} data-testid={`offices-status-${carrier}`}>
          <Icon name={icon[status]} /> {t(`offices.status.${status}`)}
        </p>
      )}
      <ul className="plain-list" data-testid={`offices-counts-${carrier}`}>
        <li>{t('offices.count.office', { count: counts.office })}</li>
        {types.includes('locker') && <li>{t('offices.count.locker', { count: counts.locker })}</li>}
        {types.includes('mobile') && counts.mobile > 0 && (
          <li>{t('offices.count.mobile', { count: counts.mobile })}</li>
        )}
        {unused > 0 && (
          <li className="muted" data-testid={`offices-unused-${carrier}`}>
            {t('offices.count.notUsed', { count: unused })}
          </li>
        )}
      </ul>
      <p>{t('offices.withCoords', { count: counts.withCoords, total: counts.active })}</p>
      {counts.inactive > 0 && (
        <p className="muted">{t('offices.inactive', { count: counts.inactive })}</p>
      )}
      <p data-testid={`offices-last-ok-${carrier}`}>
        {lastOkAt
          ? t('offices.lastOk', { date: formatDateTime(lastOkAt, locale) })
          : t('offices.neverOk')}
      </p>
      {state.lastOk && (
        <p className="muted">
          {t('offices.lastRun', {
            inserted: state.lastOk.inserted + state.lastOk.reactivated,
            updated: state.lastOk.updated,
            deactivated: state.lastOk.deactivated,
          })}
        </p>
      )}
      {state.failed && (
        <div className="confirm" data-testid={`offices-error-${carrier}`}>
          <p>
            <Icon name="error" /> {t(`offices.errors.${syncErrorKey(state.failed.error_code)}`)}
          </p>
          <p className="muted">
            {t('offices.failedAt', {
              date: formatDateTime(state.failed.finished_at ?? state.failed.started_at, locale),
            })}
          </p>
          {state.lastOk && <p>{t('offices.keptOld')}</p>}
        </div>
      )}
      <p className="muted">{t(`offices.source.${carrier}`)}</p>
    </div>
  );
}

type Loaded = { city: string; points: MapPoint[] } | { city: string; error: true } | null;

function CityMap({
  city,
  onCity,
  types,
}: {
  city: string;
  onCity: (city: string) => void;
  types: PointType[];
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState(city);
  const [shownCity, setShownCity] = useState(city);
  const [loaded, setLoaded] = useState<Loaded>(null);
  // "Покажи на картата" in the search sets the town from outside: show it in the field too.
  if (city !== shownCity) {
    setShownCity(city);
    setInput(city);
  }

  useEffect(() => {
    let cancelled = false;
    fetchPointsInCity(city, types)
      .then((points) => {
        if (!cancelled) setLoaded({ city, points });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ city, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [city, types]);

  const letters = useMemo(
    () => ({
      econt: t('offices.carrier.econt').charAt(0),
      speedy: t('offices.carrier.speedy').charAt(0),
    }),
    [t],
  );
  const describe = useCallback(
    (p: MapPoint) => ({
      carrier: t(`offices.carrier.${p.carrier}`),
      type: t(`offices.type.${p.type}`),
    }),
    [t],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (value) onCity(value);
  }

  const points = loaded && 'points' in loaded ? loaded.points : [];
  const missing = points.filter((p) => p.lat === null || p.lng === null).length;

  return (
    <div className="card" id="map">
      <h2>{t('offices.map.title')}</h2>
      <p>{t('offices.map.intro')}</p>
      <form className="row wrap" onSubmit={onSubmit}>
        <div>
          <label htmlFor="offices-city">{t('offices.map.cityLabel')}</label>
          <input
            id="offices-city"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="button-secondary office-city-submit">
          {t('offices.map.show')}
        </button>
      </form>
      <div className="row wrap office-quick">
        {QUICK_CITIES.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === city}
            onClick={() => onCity(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {loaded && 'error' in loaded && (
        <p className="badge badge-error" role="alert">
          <Icon name="error" /> {t('offices.map.loadFailed')}
        </p>
      )}
      {loaded && 'points' in loaded && (
        <p role="status" data-testid="offices-map-count">
          {points.length
            ? t('offices.map.found', { count: points.length, city: loaded.city })
            : t('offices.map.none', { city: loaded.city })}
          {missing > 0 && <> {t('offices.map.noCoords', { count: missing })}</>}
        </p>
      )}
      <p className="muted">
        {types.length === 1 && types[0] === 'office'
          ? t('offices.map.legendOffices')
          : t('offices.map.legend')}
      </p>
      <OfficeMap
        points={points}
        label={t('offices.map.label', { city: loaded?.city ?? city })}
        letters={letters}
        describe={describe}
      />
      {points.length > 0 && <PointTable points={points} />}
    </div>
  );
}

function PointTable({
  points,
  onShowCity,
  testId,
}: {
  points: MapPoint[];
  onShowCity?: (city: string) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="table-wrap office-list" data-testid={testId}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('offices.table.carrier')}</th>
            <th scope="col">{t('offices.table.type')}</th>
            <th scope="col">{t('offices.table.name')}</th>
            <th scope="col">{t('offices.table.address')}</th>
            {onShowCity && <th scope="col" aria-label={t('offices.search.showCity')} />}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id} data-testid="office-row">
              <td>{t(`offices.carrier.${p.carrier}`)}</td>
              <td>{t(`offices.type.${p.type}`)}</td>
              <td>{p.name_bg}</td>
              <td>{p.address_text}</td>
              {onShowCity && (
                <td>
                  {p.city && (
                    <button type="button" onClick={() => onShowCity(p.city!)}>
                      {t('offices.search.showCity')}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PointSearch({
  onShowCity,
  types,
}: {
  onShowCity: (city: string) => void;
  types: PointType[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; points: MapPoint[] } | null>(null);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    try {
      setResult({ query: q, points: await searchPoints(q, types) });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  function show(city: string) {
    onShowCity(city);
    document.getElementById('map')?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <div className="card">
      <h2>{t('offices.search.title')}</h2>
      <form className="row wrap" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <label htmlFor="offices-search">{t('offices.search.label')}</label>
          <input
            id="offices-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="button-secondary office-city-submit">
          {t('offices.search.submit')}
        </button>
      </form>
      {failed && (
        <p className="badge badge-error" role="alert">
          <Icon name="error" /> {t('offices.loadFailed')}
        </p>
      )}
      {result &&
        (result.points.length ? (
          <PointTable points={result.points} onShowCity={show} testId="offices-search-results" />
        ) : (
          <p role="status">{t('offices.search.none', { query: result.query })}</p>
        ))}
    </div>
  );
}
