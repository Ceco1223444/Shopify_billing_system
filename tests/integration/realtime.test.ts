import type { RealtimeChannel } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, anonClient, signedInClient, type Client } from '../support/clients';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

const LIMIT_MS = 3000;

let owner: Client;
let packer: Client;
const channels: [Client, RealtimeChannel][] = [];

beforeAll(async () => {
  await ensureTestUsers();
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
});

afterAll(async () => {
  for (const [client, channel] of channels) await client.removeChannel(channel);
});

/** Subscribes and resolves once Realtime confirms the database listener is attached. */
function subscribeReady(client: Client, channel: RealtimeChannel): Promise<void> {
  channels.push([client, channel]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime did not become ready')), 15_000);
    channel.on('system', {}, (payload: { extension?: string; status?: string }) => {
      if (payload.extension === 'postgres_changes' && payload.status === 'ok') {
        clearTimeout(timer);
        resolve();
      }
    });
    void client.realtime.setAuth().then(() =>
      channel.subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(err ?? new Error(status));
        }
      }),
    );
  });
}

/** Resolves with the status a private-channel join ends in. */
function joinStatus(client: Client, topic: string): Promise<string> {
  const channel = client.channel(topic, { config: { private: true } });
  channels.push([client, channel]);
  return new Promise((resolve) => {
    void client.realtime.setAuth().then(() =>
      channel.subscribe((status) => {
        if (status !== 'CLOSED') resolve(status);
      }),
    );
  });
}

describe('live sync', () => {
  it(`delivers changes to orders, shipments, flags and products to another member in < ${LIMIT_MS} ms`, async () => {
    const seen = new Map<string, number>();
    const tables = ['orders', 'shipments', 'flags', 'products'] as const;
    const channel = packer.channel(`shop:test:${uniq('db')}`, { config: { private: true } });
    for (const table of tables) {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table }, () => {
        if (!seen.has(table)) seen.set(table, Date.now());
      });
    }
    await subscribeReady(packer, channel);

    const started = Date.now();
    const name = uniq('#RT');
    const { data: order } = await owner.from('orders').insert({ name }).select('id').single();
    const { data: shipment } = await owner.from('shipments').insert({}).select('id').single();
    await owner.from('flags').insert({
      shipment_id: shipment!.id,
      severity: 'info',
      code: 'TEST',
      message_bg: 'Тест',
      message_en: 'Test',
    });
    const { data: product } = await owner
      .from('products')
      .insert({ sku: uniq('RT'), name: 'Realtime test' })
      .select('id')
      .single();

    await expect.poll(() => seen.size, { timeout: LIMIT_MS, interval: 50 }).toBe(tables.length);
    for (const table of tables) expect(seen.get(table)! - started, table).toBeLessThan(LIMIT_MS);

    const admin = adminClient();
    await admin.from('shipments').delete().eq('id', shipment!.id); // cascades to flags
    await admin.from('orders').delete().eq('id', order!.id);
    await admin.from('products').delete().eq('id', product!.id);
  });
});

describe('private channels (presence)', () => {
  it('let members join', async () => {
    expect(await joinStatus(packer, 'shop:presence')).toBe('SUBSCRIBED');
  });

  it('refuse a signed-in user who is not a member', async () => {
    const outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
    expect(await joinStatus(outsider, 'shop:presence')).toBe('CHANNEL_ERROR');
  });

  it('refuse a signed-out visitor', async () => {
    expect(await joinStatus(anonClient(), 'shop:presence')).toBe('CHANNEL_ERROR');
  });
});
