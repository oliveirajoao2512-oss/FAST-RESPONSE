import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export interface Area { id: number; slug: string; name: string; color: string }
export interface Category { id: number; name: string; area_id: number | null; is_safety: boolean; requires_evidence: boolean; active: boolean }
export interface UserLite { id: string; name: string; role: string; area_id: number | null; active: boolean }
export interface Meta {
  areas: Area[];
  categories: Category[];
  users: UserLite[];
  stepTemplates: { name: string; steps: string[] }[];
  config: any;
}

export function useMeta() {
  const q = useQuery<Meta>({ queryKey: ['meta'], queryFn: () => get('/api/meta'), staleTime: 5 * 60_000 });
  return q.data;
}

export const areaBySlug = (m: Meta | undefined, slug?: string) => m?.areas.find((a) => a.slug === slug);
export const areaById = (m: Meta | undefined, id?: number | null) => m?.areas.find((a) => a.id === id);
export const userName = (m: Meta | undefined, id?: string | null) => m?.users.find((u) => u.id === id)?.name;
