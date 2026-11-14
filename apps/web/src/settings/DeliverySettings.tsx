/**
 * Phase 5 settings (owner): how far an office may be to be suggested instead of the home
 * address, which courier takes home deliveries on a tie, and extra words for the detection
 * (added to the built-in list, never replacing it). Saving decides again for open shipments.
 */
import type { Json } from '@happyhome/core';
import {
  BASE_DICTIONARY,
  DICTIONARY_CATEGORIES,
  type DictionaryAdditions,
  type DictionaryCategory,
} from '@happyhome/core/detect';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import type { SettingValue } from '../lib/settings';
import { supabase } from '../lib/supabase';
import { startDetection } from '../shipments/delivery';

const words = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  ),
];

function additionsOf(value: Json | undefined): DictionaryAdditions {
  const out: DictionaryAdditions = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const c of DICTIONARY_CATEGORIES) {
    const list = (value as Record<string, Json>)[c];
    if (Array.isArray(list)) out[c] = list.filter((w): w is string => typeof w === 'string');
  }
  return out;
}

export function DeliverySettings({
  values,
  save,
}: {
  values: Record<string, Json>;
  save: (entries: Record<string, SettingValue>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState(String(values.office_range_km ?? 1));
  const [tie, setTie] = useState(values.home_carrier_tie_break === 'speedy' ? 'speedy' : 'econt');
  const [extra, setExtra] = useState<Record<DictionaryCategory, string>>(() => {
    const a = additionsOf(values.detection_dictionary);
    return Object.fromEntries(
      DICTIONARY_CATEGORIES.map((c) => [c, (a[c] ?? []).join(', ')]),
    ) as Record<DictionaryCategory, string>;
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'bad_range'>('idle');
  const [marked, setMarked] = useState(0);

  const submit = async () => {
    const km = Number(range.replace(',', '.'));
    if (!Number.isFinite(km) || km <= 0 || km > 50) {
      setState('bad_range');
      return;
    }
    setState('saving');
    const dictionary: DictionaryAdditions = {};
    for (const c of DICTIONARY_CATEGORIES) {
      const list = words(extra[c]);
      if (list.length) dictionary[c] = list;
    }
    try {
      await save({
        office_range_km: km,
        home_carrier_tie_break: tie,
        detection_dictionary: dictionary as SettingValue,
      });
      const { data } = await supabase.rpc('delivery_redetect_open');
      setMarked(data ?? 0);
      void startDetection();
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid="delivery-settings"
    >
      <label htmlFor="office-range">{t('settings.delivery.range')}</label>
      <input
        id="office-range"
        inputMode="decimal"
        value={range}
        onChange={(e) => setRange(e.target.value)}
        className="input-short"
        data-testid="office-range"
      />
      <p className="muted">{t('settings.delivery.rangeHint')}</p>

      <fieldset className="plain-fieldset">
        <legend>{t('settings.delivery.tie')}</legend>
        {(['econt', 'speedy'] as const).map((c) => (
          <label key={c} className="radio">
            <input
              type="radio"
              name="tie-break"
              value={c}
              checked={tie === c}
              onChange={() => setTie(c)}
              data-testid={`tie-${c}`}
            />{' '}
            {t(`offices.carrier.${c}`)}
          </label>
        ))}
        <p className="muted">{t('settings.delivery.tieHint')}</p>
      </fieldset>

      <h3>{t('settings.delivery.words')}</h3>
      <p className="muted">{t('settings.delivery.wordsHint')}</p>
      {DICTIONARY_CATEGORIES.map((c) => (
        <div key={c}>
          <label htmlFor={`words-${c}`}>{t(`settings.delivery.category.${c}`)}</label>
          <input
            id={`words-${c}`}
            value={extra[c]}
            onChange={(e) => setExtra((x) => ({ ...x, [c]: e.target.value }))}
            data-testid={`words-${c}`}
          />
          <p className="muted small">
            {t('settings.delivery.builtIn', { words: BASE_DICTIONARY[c].slice(0, 8).join(', ') })}
          </p>
        </div>
      ))}

      <div className="row actions">
        <button
          type="submit"
          className="button-primary"
          disabled={state === 'saving'}
          data-testid="delivery-settings-save"
        >
          {t('settings.delivery.save')}
        </button>
      </div>
      {state === 'saved' && (
        <p className="badge badge-ok" role="status" data-testid="delivery-settings-saved">
          <Icon name="ok" /> {t('settings.delivery.saved', { count: marked })}
        </p>
      )}
      {state === 'bad_range' && (
        <p className="badge badge-error" role="status">
          <Icon name="error" /> {t('settings.delivery.badRange')}
        </p>
      )}
      {state === 'failed' && (
        <p className="badge badge-error" role="status">
          <Icon name="error" /> {t('settings.delivery.failed')}
        </p>
      )}
    </form>
  );
}
