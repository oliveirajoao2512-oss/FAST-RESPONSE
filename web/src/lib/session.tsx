import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { Role } from '@shared/constants';
import { can, type Actor } from '@shared/permissions';
import { get, post, setUnauthorizedHandler } from './api';
import { setTimezone } from './format';

export interface Me extends Actor {
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  area: { id: number; name: string; slug: string } | null;
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
    logout: async () => {
      await post('/api/auth/logout').catch(() => {});
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
export const useMe = () => useContext(Ctx).me!;
export { can };
