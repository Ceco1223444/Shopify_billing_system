import type { Json } from '@happyhome/core';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

/** A stored setting value (the column is NOT NULL). */
export type SettingValue = Exclude<Json, null>;

async function fetchSettings(): Promise<Record<string, Json>> {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((s) => [s.key, s.value]));
}

/** All shop settings (key -> value). Members read them; only the owner can save (RLS). */
export function useSettings() {
  const [values, setValues] = useState<Record<string, Json> | null>(null);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try {
      setValues(await fetchSettings());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((v) => {
        if (!cancelled) setValues(v);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (entries: Record<string, SettingValue>) => {
    for (const [key, value] of Object.entries(entries)) {
      const { error: saveError } = await supabase.from('settings').update({ value }).eq('key', key);
      if (saveError) throw saveError;
    }
    setValues((v) => ({ ...(v ?? {}), ...entries }));
  }, []);

  return { values, error, reload, save };
}
