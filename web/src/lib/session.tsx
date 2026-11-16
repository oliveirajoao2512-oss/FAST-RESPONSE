import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { Role } from '@shared/constants';
import { can, type Actor } from '@shared/permissions';
import { get, post, setSlot, setUnauthorizedHandler, shouldAdoptLogin } from './api';
import { setTimezone } from './format';
import { stopPreview } from './preview';

export interface Me extends Actor {
  name: string;
  email: string | null;
  role: Role;
  mustChangePassword: boolean;
  area: { id: number; name: string; slug: string } | null;
  /** Administrator previewing another profile (read-only). */
  preview?: boolean;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  unread: number;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue>(null!);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      // a new tab or window starts with the browser's latest login, in a copy of its own (see /api/auth/adopt)
      if (shouldAdoptLogin()) {
        try {
          setSlot((await post<{ slot: string }>('/api/auth/adopt')).slot);
        } catch {
          /* nobody logged in on this browser: the login screen */
        }
      }
      try {
        const r = await get('/api/auth/me');
        setTimezone(r.timezone);
        return r;
      } catch (e: any) {
        if (e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  useEffect(() => {
    setUnauthorizedHandler(() => qc.setQueryData(['me'], null));
  }, [qc]);
  const value: SessionValue = {
    me: q.data?.user ?? null,
    loading: q.isLoading,
    unread: q.data?.unreadNotifications ?? 0,
    refresh: () => q.refetch(),
    // back to the login screen with nothing left in memory: a full reload, so no screen keeps the previous user's data
    logout: async () => {
      stopPreview(false);
      await post('/api/auth/logout').catch(() => {});
      setSlot(null);
      location.replace('/');
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
export const useMe = () => useContext(Ctx).me!;
export { can };
