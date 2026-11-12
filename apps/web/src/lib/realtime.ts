import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

/** The parts of the Supabase client this module uses (a fake in unit tests). */
export type RealtimeHost = Pick<SupabaseClient, 'channel' | 'removeChannel' | 'getChannels'> & {
  realtime: { setAuth: (token?: string | null) => Promise<void> };
};

export interface OpenChannelOptions {
  /** Presence key (one per person). Omit for channels without presence. */
  presenceKey?: string;
  /** Register .on(...) listeners here. Called once for every brand-new channel. */
  setup: (channel: RealtimeChannel) => void;
  /** Join status. Never called after the returned close function ran. */
  onStatus?: (status: ChannelStatus, error?: Error) => void;
  /** First wait before re-opening a channel the server closed (doubles each time, max 30 s). */
  reopenDelayMs?: number;
}

/** How long a re-open waits for the previous channel on the same topic to close. */
const MAX_WAIT_FOR_CLOSE_MS = 3000;
const MAX_REOPEN_DELAY_MS = 30_000;

/** Topics whose previous channel is still closing. */
const closing = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quietly = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined,
  );

/**
 * Opens a PRIVATE Realtime channel and returns a function that closes it.
 *
 * Use this instead of `supabase.channel(...).subscribe()` in components. Two problems it
 * prevents, both seen against the hosted project and reproduced locally with added
 * WebSocket latency (tests/e2e/reconnect.spec.ts):
 *
 * 1. Re-opening a topic too early. realtime-js hands back the existing channel when a topic
 *    is asked for again, and the server closes the older join when one socket joins a topic
 *    twice. If a screen re-opens a topic while the previous channel is still open or closing
 *    (React StrictMode in dev, quick navigation, account switch), that late close kills the
 *    NEW subscription: "Няма връзка" and the person drops out of presence.
 *    -> wait until the previous channel is gone, then create a fresh one, subscribe once.
 *
 * 2. Server-side close. The server closes a channel it does not like (e.g. "Client presence
 *    rate limit exceeded") and realtime-js does not re-join after a close.
 *    -> re-open a fresh channel after a back-off.
 *
 * One component owns each topic.
 */
export function openPrivateChannel(
  client: RealtimeHost,
  topic: string,
  { presenceKey, setup, onStatus, reopenDelayMs = 2000 }: OpenChannelOptions,
): () => void {
  let active = true;
  let channel: RealtimeChannel | null = null;
  let removal: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  /** The latest connect attempt; close() waits for it. */
  let current: Promise<void> = Promise.resolve();

  const report = (status: ChannelStatus, error?: Error) => {
    if (active) onStatus?.(status, error);
  };

  async function connect(waitFor: Promise<void>): Promise<void> {
    await Promise.race([waitFor, sleep(MAX_WAIT_FOR_CLOSE_MS)]);
    if (!active) return;
    // A channel still registered under this topic (e.g. its close timed out) would be reused.
    for (const stale of client.getChannels().filter((c) => c.topic === `realtime:${topic}`)) {
      await quietly(client.removeChannel(stale));
    }
    if (!active) return;
    await client.realtime.setAuth();
    if (!active) return;

    const fresh = client.channel(topic, {
      config: { private: true, ...(presenceKey ? { presence: { key: presenceKey } } : {}) },
    });
    channel = fresh;
    setup(fresh);
    fresh.subscribe((status, error) => {
      if (!active || channel !== fresh) return; // a channel we already let go of
      if (status === 'SUBSCRIBED') failures = 0;
      report(status as ChannelStatus, error);
      if (status === 'CLOSED') {
        // We did not ask for this: the server closed the channel. Start again, fresh.
        channel = null;
        removal = quietly(client.removeChannel(fresh));
        const delay = Math.min(reopenDelayMs * 2 ** failures, MAX_REOPEN_DELAY_MS);
        failures += 1;
        retryTimer = setTimeout(() => {
          current = run(removal);
        }, delay);
      }
    });
  }

  async function run(waitFor: Promise<void>) {
    try {
      await connect(waitFor);
    } catch (error) {
      report('CHANNEL_ERROR', error instanceof Error ? error : undefined);
    }
  }

  current = run(closing.get(topic) ?? Promise.resolve());

  return () => {
    if (!active) return;
    active = false;
    clearTimeout(retryTimer);
    const done: Promise<void> = current
      .then(() => removal)
      .then(async () => {
        if (channel) await quietly(client.removeChannel(channel));
      })
      .finally(() => {
        if (closing.get(topic) === done) closing.delete(topic);
      });
    closing.set(topic, done);
  };
}

/**
 * Sends only the LATEST value, after `delayMs` of quiet, and never the same value twice in
 * a row. Presence updates go through this: the server closes a client's presence channel
 * when it sends too many updates ("Client presence rate limit exceeded").
 */
export function createLatestSender<T>(send: (value: T) => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { value: T } | null = null;
  let lastKey: string | null = null;

  const flush = () => {
    timer = undefined;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    const key = JSON.stringify(value);
    if (key === lastKey) return;
    lastKey = key;
    send(value);
  };

  return {
    /** Send this value soon (replaces any value still waiting). */
    schedule(value: T) {
      pending = { value };
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    /** Send this value now (e.g. right after (re)connecting). */
    sendNow(value: T) {
      clearTimeout(timer);
      pending = { value };
      flush();
    },
    /** Forget what was sent, so the next value goes out even if unchanged (after a reconnect). */
    forget() {
      lastKey = null;
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}
