import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export type ConnState = 'online' | 'reconnecting' | 'offline';

/**
 * Subscribes to server events (SSE). Any change made by another user refreshes the
 * data on screen; when the connection drops the UI says so and resyncs on return.
 */
export function useRealtime(enabled: boolean): ConnState {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnState>('online');
  const timer = useRef<number | null>(null);
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let lostAt = 0;
    const flush = () => {
      timer.current = null;
      const keys = [...pending.current];
      pending.current.clear();
      if (keys.includes('notification')) {
        qc.invalidateQueries({ queryKey: ['notifications'] });
        qc.invalidateQueries({ queryKey: ['me'] });
      }
      if (keys.includes('config')) qc.invalidateQueries({ queryKey: ['meta'] });
      if (keys.includes('quality')) qc.invalidateQueries({ queryKey: ['quality'] });
      if (keys.includes('os')) qc.invalidateQueries({ queryKey: ['os'] });
      if (keys.some((k) => k.startsWith('issue'))) {
        qc.invalidateQueries({ predicate: (q) => !['me', 'meta', 'notifications'].includes(String(q.queryKey[0])) });
      }
    };
    const schedule = (k: string) => {
      pending.current.add(k);
      if (!timer.current) timer.current = window.setTimeout(flush, 400);
    };
    let retry: number | null = null;
    let attempts = 0;
    const connect = () => {
      es?.close();
      es = new EventSource('/api/events');
      es.addEventListener('ready', () => {
        if (lostAt) qc.invalidateQueries();
        lostAt = 0;
        attempts = 0;
        setState('online');
      });
      es.addEventListener('issue.changed', () => schedule('issue'));
      es.addEventListener('notification', () => schedule('notification'));
      es.addEventListener('config.changed', () => schedule('config'));
      es.addEventListener('quality.changed', () => schedule('quality'));
      es.addEventListener('os.changed', () => schedule('os'));
      es.onerror = () => {
        if (!lostAt) lostAt = Date.now();
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        // the browser gives up on some failures; reconnect ourselves with backoff
        if (es?.readyState === EventSource.CLOSED) reconnectSoon();
      };
    };
    const reconnectSoon = (delay?: number) => {
      if (retry) clearTimeout(retry);
      attempts++;
      retry = window.setTimeout(connect, delay ?? Math.min(1000 * 2 ** attempts, 30_000));
    };
    connect();
    const off = () => setState('offline');
    const on = () => {
      setState('reconnecting');
      reconnectSoon(300);
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      if (retry) clearTimeout(retry);
      es?.close();
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, [enabled, qc]);
  return state;
}
