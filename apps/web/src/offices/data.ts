import type { WorkingHours } from '@happyhome/core/couriers';
import { useCallback, useEffect, useState } from 'react';
import { supabase, supabasePublishableKey, supabaseUrl } from '../lib/supabase';
import { SYNC_RUN_COLUMNS, type PointStat, type SyncRun } from './syncStatus';

export interface MapPoint {
  id: string;
  carrier: 'econt' | 'speedy';
  external_id: string;
  type: 'office' | 'locker' | 'mobile';
  name_bg: string;
  city: string | null;
  postcode: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  coord_confidence?: number | null;
  working_hours?: WorkingHours | null;
}

type RunsListener = (runs: SyncRun[]) => void;
const runsListeners = new Set<RunsListener>();

/** Called with every freshly loaded run list (the banner follows the offices page this way). */
export function subscribeSyncRuns(listener: RunsListener): () => void {
  runsListeners.add(listener);
  return () => {
    runsListeners.delete(listener);
  };
}

export async function fetchSyncRuns(limit = 30): Promise<SyncRun[]> {
  const { data, error } = await supabase
    .from('courier_sync_runs')
    .select(SYNC_RUN_COLUMNS)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const runs = (data ?? []) as unknown as SyncRun[];
  for (const listener of runsListeners) listener(runs);
  return runs;
}

export async function fetchPointStats(): Promise<PointStat[]> {
  const { data, error } = await supabase.rpc('courier_points_stats');
  if (error) throw error;
  return (data ?? []) as PointStat[];
}

export async function fetchPointsInCity(query: string): Promise<MapPoint[]> {
  const { data, error } = await supabase.rpc('points_in_city', { p_query: query });
  if (error) throw error;
  return (data ?? []) as MapPoint[];
}

export async function searchPoints(query: string): Promise<MapPoint[]> {
  const { data, error } = await supabase.rpc('search_points', { p_query: query, p_limit: 20 });
  if (error) throw error;
  return (data ?? []) as MapPoint[];
}

export type StartSyncResult = { ok: true } | { ok: false; reason: 'owner_only' | 'failed' };

/** "Обнови офисите": starts both syncs; the work goes on in the background (P4-13). */
export async function startOfficeSync(): Promise<StartSyncResult> {
  const { data: session } = await supabase.auth.getSession();
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/courier-sync`, {
      method: 'POST',
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${session.session?.access_token ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'start' }),
    });
    if (res.status === 403) return { ok: false, reason: 'owner_only' };
    return res.ok ? { ok: true } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Runs + counts, refreshed every few seconds while a sync is running. */
export function useOfficeOverview() {
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [stats, setStats] = useState<PointStat[] | null>(null);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([fetchSyncRuns(), fetchPointStats()]);
      setRuns(r);
      setStats(s);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSyncRuns(), fetchPointStats()])
      .then(([r, s]) => {
        if (cancelled) return;
        setRuns(r);
        setStats(s);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = !!runs?.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(timer);
  }, [running, reload]);

  return { runs, stats, error, reload, running };
}
