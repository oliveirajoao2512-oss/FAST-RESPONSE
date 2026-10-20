export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  const isForm = body instanceof FormData;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-requested-with': 'fast-response',
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique a rede e tente novamente — nenhuma alteração foi perdida no servidor.', 'offline');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/login')) onUnauthorized?.();
    const msg = data?.erro ?? (res.status >= 500 ? 'Erro no servidor. Tente novamente.' : `Erro ${res.status}`);
    throw new ApiError(res.status, msg, data?.codigo, data?.detalhes);
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>('PUT', url, body);

export function qs(params: Record<string, unknown>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (Array.isArray(e.details) && e.details.every((d) => typeof d === 'string')) return `${e.message} ${e.details.join(' ')}`;
    return e.message;
  }
  return 'Erro inesperado.';
}
