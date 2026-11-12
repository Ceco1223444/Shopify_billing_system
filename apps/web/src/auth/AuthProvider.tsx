import type { MemberRole } from '@happyhome/core';
import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';
import { consumeLoginStartedHere } from './loginOrigin';

export interface Member {
  id: string;
  userId: string;
  displayName: string;
  role: MemberRole;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  /** Signed in, but not an active member of the shop. RLS gives them nothing. */
  | { status: 'no_access'; session: Session }
  | { status: 'ready'; session: Session; member: Member };

interface AuthContextValue {
  state: AuthState;
  signOut: () => Promise<void>;
  /**
   * True when another tab of this browser signed in as a different person and this
   * window silently became that person (browsers share one login across all tabs).
   */
  accountSwitchedElsewhere: boolean;
  dismissAccountSwitched: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // undefined = not known yet, null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [memberState, setMemberState] = useState<{
    userId: string;
    member: Member | null;
  } | null>(null);

  const [accountSwitchedElsewhere, setAccountSwitchedElsewhere] = useState(false);
  // The last person this tab was signed in as (kept across a sign-out).
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) lastUserIdRef.current = data.session.user.id;
      setSession(data.session);
    });
    // Keep this callback synchronous: calling Supabase from inside it can deadlock.
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      const nextUserId = next?.user.id ?? null;
      if (event === 'SIGNED_IN' && nextUserId) {
        const startedHere = consumeLoginStartedHere();
        if (startedHere) {
          setAccountSwitchedElsewhere(false);
        } else if (lastUserIdRef.current && lastUserIdRef.current !== nextUserId) {
          setAccountSwitchedElsewhere(true);
        }
      }
      if (nextUserId) lastUserIdRef.current = nextUserId;
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void supabase
      .from('members')
      .select('id, user_id, display_name, role, active')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const member: Member | null =
          data && data.active
            ? {
                id: data.id,
                userId: data.user_id,
                displayName: data.display_name,
                role: data.role as MemberRole,
              }
            : null;
        setMemberState({ userId, member });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const state: AuthState = useMemo(() => {
    if (session === undefined) return { status: 'loading' };
    if (session === null) return { status: 'signed_out' };
    if (!memberState || memberState.userId !== session.user.id) return { status: 'loading' };
    if (!memberState.member) return { status: 'no_access', session };
    return { status: 'ready', session, member: memberState.member };
  }, [session, memberState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      signOut: async () => {
        await supabase.auth.signOut();
      },
      accountSwitchedElsewhere,
      dismissAccountSwitched: () => setAccountSwitchedElsewhere(false),
    }),
    [state, accountSwitchedElsewhere],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For screens that only render when signed in as a member. */
// eslint-disable-next-line react-refresh/only-export-components
export function useMember(): Member {
  const { state } = useAuth();
  if (state.status !== 'ready') throw new Error('useMember needs a signed-in member');
  return state.member;
}
