import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, qs } from './api';

export function useIssues(params: Record<string, unknown>, enabled = true) {
  return useQuery({
    queryKey: ['issues', params],
    queryFn: () => get(`/api/issues${qs(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function usePersistentState<T extends string>(key: string, def: T): [T, (v: T) => void] {
  let initial = def;
  try {
    initial = (localStorage.getItem(key) as T) ?? def;
  } catch {}
  const state = useQueryState(key, initial);
  return state;
}

import { useState } from 'react';
function useQueryState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  return [v, (n: T) => {
    setV(n);
    try { localStorage.setItem(key, n); } catch {}
  }];
}
