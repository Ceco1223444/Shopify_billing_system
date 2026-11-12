import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Icon } from '../components/Icon';
import { openPrivateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';
import { usePresence, useViewingShipment } from '../realtime/PresenceProvider';
import { ViewersBadge } from '../realtime/ViewersBadge';

/** A fixed id that never matches a real shipment, for the presence check. */
export const TEST_SHIPMENT_ID = '00000000-0000-4000-8000-000000000001';

type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Connection check (dev only): edits one diagnostics row (table sync_probe) and
 * shows presence on a pretend shipment. Used by the realtime end-to-end test.
 */
export function DevSyncPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const label = params.get('probe') ?? 'default';

  const [dbValue, setDbValue] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  useViewingShipment(TEST_SHIPMENT_ID);
  const { viewersOf } = usePresence();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Create the row the first time; ignore the conflict if the other window already did.
      const { error: upsertError } = await supabase
        .from('sync_probe')
        .upsert({ label, value: '' }, { onConflict: 'label', ignoreDuplicates: true });
      if (upsertError) throw upsertError;
      const { data, error: selectError } = await supabase
        .from('sync_probe')
        .select('value')
        .eq('label', label)
        .single();
      if (selectError) throw selectError;
      if (!cancelled) setDbValue(data.value);
    }

    const close = openPrivateChannel(supabase, `shop:probe:${label}`, {
      setup: (channel) => {
        channel
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'sync_probe', filter: `label=eq.${label}` },
            (payload) => {
              const row = payload.new as { value?: string };
              if (!cancelled && typeof row.value === 'string') setDbValue(row.value);
            },
          )
          // "live" only once the database-changes listener is really attached.
          .on('system', {}, (payload: { extension?: string; status?: string }) => {
            if (cancelled) return;
            if (payload.extension === 'postgres_changes' && payload.status === 'ok') {
              setStatus('live');
              // Catch anything written between the first load and the listener being ready.
              load().catch((e: unknown) => setError(String((e as Error).message ?? e)));
            }
          });
      },
      onStatus: (s) => {
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') setStatus('offline');
      },
    });
    load().catch((e: unknown) => setError(String((e as Error).message ?? e)));

    return () => {
      cancelled = true;
      close();
    };
  }, [label]);

  async function save() {
    setSaveState('saving');
    setError(null);
    const { error: updateError } = await supabase
      .from('sync_probe')
      .update({ value: draft })
      .eq('label', label);
    if (updateError) {
      setError(updateError.message);
      setSaveState('idle');
      return;
    }
    setSaveState('saved');
  }

  return (
    <section>
      <h1>{t('dev.title')}</h1>
      <p>{t('dev.intro')}</p>

      <p
        className={`badge ${status === 'live' ? 'badge-ok' : status === 'offline' ? 'badge-error' : 'badge-info'}`}
        data-testid="probe-status"
        data-status={status}
        role="status"
      >
        <Icon name={status === 'live' ? 'live' : status === 'offline' ? 'offline' : 'wait'} />{' '}
        {t(`dev.status.${status}`)}
      </p>

      <div className="card">
        <label htmlFor="probe-input">{t('dev.sharedText')}</label>
        <div className="row">
          <input
            id="probe-input"
            data-testid="probe-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaveState('idle');
            }}
          />
          <button
            type="button"
            className="button-primary"
            data-testid="probe-save"
            disabled={saveState === 'saving'}
            onClick={() => void save()}
          >
            {saveState === 'saving' ? t('dev.saving') : t('dev.save')}
          </button>
        </div>
        {saveState === 'saved' && (
          <p className="muted" role="status">
            <Icon name="check" /> {t('dev.saved')}
          </p>
        )}
        <p>
          {t('dev.currentValue')}:{' '}
          <strong data-testid="probe-value">{dbValue === '' ? t('dev.empty') : dbValue}</strong>
        </p>
        {error && (
          <p className="badge badge-error" role="alert">
            {t('dev.error', { message: error })}
          </p>
        )}
      </div>

      <div className="card">
        <h2>{t('dev.presenceTitle')}</h2>
        <p>{t('dev.presenceIntro')}</p>
        <ViewersBadge shipmentId={TEST_SHIPMENT_ID} />
        {viewersOf(TEST_SHIPMENT_ID).length === 0 && (
          <p className="muted" data-testid="presence-nobody">
            {t('dev.presenceNobody')}
          </p>
        )}
      </div>
    </section>
  );
}
