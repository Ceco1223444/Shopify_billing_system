import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Member } from '../auth/AuthProvider';
import { createLatestSender, openPrivateChannel } from '../lib/realtime';
import { supabase } from '../lib/supabase';

/** What each open app window tells the others. One presence key per person. */
export interface PresenceMeta {
  user_id: string;
  display_name: string;
  /** The shipment this window is looking at, or null. */
  shipment_id: string | null;
}

interface PresenceContextValue {
  /** Other people with the app open (each person once), excluding me. */
  othersOnline: { userId: string; displayName: string }[];
  /** Other people looking at a given shipment right now. */
  viewersOf: (shipmentId: string) => string[];
  setViewingShipment: (shipmentId: string | null) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

/** Private channel: only active members can join (see realtime.messages policies). */
export const PRESENCE_TOPIC = 'shop:presence';

/** Quiet period before a presence change is sent (opening/leaving shipments quickly). */
const PRESENCE_UPDATE_DELAY_MS = 300;

export function PresenceProvider({ member, children }: { member: Member; children: ReactNode }) {
  const [metas, setMetas] = useState<PresenceMeta[]>([]);
  /** Sends my presence state; set while the presence channel is open. */
  const senderRef = useRef<ReturnType<typeof createLatestSender<PresenceMeta>> | null>(null);
  const meRef = useRef<PresenceMeta>({
    user_id: member.userId,
    display_name: member.displayName,
    shipment_id: null,
  });

  useEffect(() => {
    meRef.current = { ...meRef.current, user_id: member.userId, display_name: member.displayName };
    let channel: RealtimeChannel | null = null;
    let subscribed = false;

    // Presence updates are combined: only the latest state is sent, after a short quiet
    // period, and never twice in a row (the server closes channels that send too many).
    const sender = createLatestSender<PresenceMeta>((meta) => {
      if (subscribed) void channel?.track(meta);
    }, PRESENCE_UPDATE_DELAY_MS);
    senderRef.current = sender;

    const close = openPrivateChannel(supabase, PRESENCE_TOPIC, {
      presenceKey: member.userId,
      setup: (fresh) => {
        channel = fresh;
        fresh.on('presence', { event: 'sync' }, () => {
          setMetas(Object.values(fresh.presenceState<PresenceMeta>()).flat());
        });
      },
      onStatus: (status) => {
        subscribed = status === 'SUBSCRIBED';
        if (status === 'SUBSCRIBED') {
          // New join (first time or after a reconnect): announce the current state now.
          sender.forget();
          sender.sendNow(meRef.current);
        } else if (status === 'CLOSED') {
          setMetas([]); // closed by the server; a fresh channel is on its way
        }
      },
    });

    return () => {
      sender.cancel();
      if (senderRef.current === sender) senderRef.current = null;
      close();
    };
  }, [member.userId, member.displayName]);

  const setViewingShipment = useCallback((shipmentId: string | null) => {
    meRef.current = { ...meRef.current, shipment_id: shipmentId };
    // Before the channel is open this only updates meRef; it is sent on SUBSCRIBED.
    senderRef.current?.schedule(meRef.current);
  }, []);

  const value = useMemo<PresenceContextValue>(() => {
    const others = metas.filter((m) => m.user_id !== member.userId);
    const byUser = new Map<string, string>();
    for (const m of others) byUser.set(m.user_id, m.display_name);
    return {
      othersOnline: [...byUser].map(([userId, displayName]) => ({ userId, displayName })),
      viewersOf: (shipmentId) => [
        ...new Set(others.filter((m) => m.shipment_id === shipmentId).map((m) => m.display_name)),
      ],
      setViewingShipment,
    };
  }, [metas, member.userId, setViewingShipment]);

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePresence(): PresenceContextValue {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error('usePresence must be used inside <PresenceProvider>');
  return ctx;
}

/** Call on a shipment screen: tells the others "I am looking at this shipment". */
// eslint-disable-next-line react-refresh/only-export-components
export function useViewingShipment(shipmentId: string | null) {
  const { setViewingShipment } = usePresence();
  useEffect(() => {
    setViewingShipment(shipmentId);
    return () => setViewingShipment(null);
  }, [shipmentId, setViewingShipment]);
}
