import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLatestSender,
  openPrivateChannel,
  type ChannelStatus,
  type RealtimeHost,
} from './realtime';

/**
 * Fake with the two realtime-js behaviours that caused the bug:
 * - channel(topic) returns the EXISTING channel for a topic that is still registered;
 * - removeChannel is asynchronous (a server round trip) and removes by topic.
 */
class FakeChannel {
  subscribeCalls = 0;
  closed = false;
  statusCallback: ((status: ChannelStatus) => void) | undefined;
  constructor(readonly topic: string) {}
  subscribe(callback: (status: ChannelStatus) => void) {
    this.subscribeCalls += 1;
    this.statusCallback = callback;
    setTimeout(() => callback('SUBSCRIBED'), 5);
    return this;
  }
  on() {
    return this;
  }
}

function fakeHost(removeDelayMs = 30) {
  let registered: FakeChannel[] = [];
  const created: FakeChannel[] = [];
  const host = {
    channel(topic: string) {
      const full = `realtime:${topic}`;
      const existing = registered.find((c) => c.topic === full);
      if (existing) return existing;
      const fresh = new FakeChannel(full);
      registered.push(fresh);
      created.push(fresh);
      return fresh;
    },
    removeChannel(channel: FakeChannel) {
      return new Promise<'ok'>((resolve) =>
        setTimeout(() => {
          channel.closed = true;
          channel.statusCallback?.('CLOSED');
          registered = registered.filter((c) => c.topic !== channel.topic);
          resolve('ok');
        }, removeDelayMs),
      );
    },
    getChannels: () => [...registered],
    realtime: { setAuth: async () => undefined },
  };
  return { host: host as unknown as RealtimeHost, created, registered: () => registered };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe('openPrivateChannel', () => {
  it('re-opening a topic while the old channel is still closing gets a fresh channel', async () => {
    const { host, created, registered } = fakeHost();
    const close1 = openPrivateChannel(host, 'shop:presence', { setup: () => {} });
    await settle();
    close1();
    openPrivateChannel(host, 'shop:presence', { setup: () => {} }); // immediately, like a re-mount
    await settle();

    expect(created).toHaveLength(2);
    expect(created[0]!.closed).toBe(true);
    expect(created[1]).not.toBe(created[0]);
    expect(created[1]!.subscribeCalls).toBe(1);
    expect(registered()).toEqual([created[1]]);
  });

  it('open, close, open in the same tick (React StrictMode) subscribes exactly once', async () => {
    const { host, created } = fakeHost();
    const setup = vi.fn();
    const close = openPrivateChannel(host, 'shop:probe:x', { setup });
    close();
    openPrivateChannel(host, 'shop:probe:x', { setup });
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0]!.subscribeCalls).toBe(1);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('reports no status from a channel after it was closed', async () => {
    const { host } = fakeHost();
    const onStatus = vi.fn();
    const close = openPrivateChannel(host, 'shop:probe:y', { setup: () => {}, onStatus });
    await settle();
    expect(onStatus).toHaveBeenCalledWith('SUBSCRIBED', undefined);
    onStatus.mockClear();

    close();
    await settle();
    expect(onStatus).not.toHaveBeenCalled(); // no late "CLOSED" -> no false "Няма връзка"
  });

  it('re-opens a fresh channel when the server closes it (e.g. presence rate limit)', async () => {
    const { host, created } = fakeHost(10);
    const onStatus = vi.fn();
    openPrivateChannel(host, 'shop:presence', { setup: () => {}, onStatus, reopenDelayMs: 20 });
    await settle(60);
    created[0]!.statusCallback!('CLOSED'); // the server closes the channel
    await settle(200);

    expect(created).toHaveLength(2);
    expect(created[1]!.subscribeCalls).toBe(1);
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual([
      'SUBSCRIBED',
      'CLOSED',
      'SUBSCRIBED',
    ]);
  });

  it('does not re-open after the component closed the channel', async () => {
    const { host, created } = fakeHost(10);
    const close = openPrivateChannel(host, 'shop:probe:z', { setup: () => {}, reopenDelayMs: 50 });
    await settle(60);
    created[0]!.statusCallback!('CLOSED');
    close(); // before the re-open timer fires
    await settle(200);
    expect(created).toHaveLength(1);
  });

  it('uses a private channel and passes the presence key', async () => {
    const { host } = fakeHost();
    const spy = vi.spyOn(host, 'channel');
    openPrivateChannel(host, 'shop:presence', { presenceKey: 'user-1', setup: () => {} });
    await settle();
    expect(spy).toHaveBeenCalledWith('shop:presence', {
      config: { private: true, presence: { key: 'user-1' } },
    });
  });
});

describe('createLatestSender (presence updates)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends only the latest of many quick changes, once', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sender = createLatestSender<string | null>(send, 300);
    // Leave and re-open a shipment three times in a row (each is null, then the id).
    for (let i = 0; i < 3; i += 1) {
      sender.schedule(null);
      sender.schedule('shipment-1');
    }
    vi.advanceTimersByTime(299);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('shipment-1');
  });

  it('never sends the same value twice in a row, until told to forget', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sender = createLatestSender<{ shipment: string | null }>(send, 100);
    sender.sendNow({ shipment: 'a' });
    sender.schedule({ shipment: 'a' });
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);

    sender.forget(); // e.g. after a reconnect
    sender.sendNow({ shipment: 'a' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('drops a waiting value on cancel', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sender = createLatestSender<string>(send, 100);
    sender.schedule('x');
    sender.cancel();
    vi.advanceTimersByTime(500);
    expect(send).not.toHaveBeenCalled();
  });
});
