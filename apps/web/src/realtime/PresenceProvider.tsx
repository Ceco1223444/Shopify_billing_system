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

export function PresenceProvider({ member, children }: { member: Member; children: ReactNode }) {
  const [metas, setMetas] = useState<PresenceMeta[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribedRef = useRef(false);
  const meRef = useRef<PresenceMeta>({
    user_id: member.userId,
    display_name: member.displayName,
    shipment_id: null,
  });

  useEffect(() => {
    meRef.current = { ...meRef.current, user_id: member.userId, display_name: member.displayName };
    const channel = supabase.channel(PRESENCE_TOPIC, {
      config: { private: true, presence: { key: member.userId } },
    });
    channelRef.current = channel;

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresenceMeta>();
      setMetas(Object.values(state).flat());
    });

    void supabase.realtime.setAuth().then(() =>
      channel.subscribe((status) => {
        subscribedRef.current = status === 'SUBSCRIBED';
        if (status === 'SUBSCRIBED') void channel.track(meRef.current);
      }),
    );

    return () => {
      subscribedRef.current = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [member.userId, member.displayName]);

  const setViewingShipment = useCallback((shipmentId: string | null) => {
    meRef.current = { ...meRef.current, shipment_id: shipmentId };
    if (subscribedRef.current) void channelRef.current?.track(meRef.current);
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
