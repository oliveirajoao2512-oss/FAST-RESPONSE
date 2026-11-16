export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

/**
 * This tab's login slot (see server/src/auth.ts): each tab or app window keeps its own login, so two people can use
 * the system side by side on the same computer. Kept in sessionStorage, which belongs to the tab and survives reloads.
 */
const SLOT_KEY = 'fr-slot';
/** Stored after "Sair": this tab stays on the login screen instead of taking the browser's latest login. */
const LOGGED_OUT = '-';
const readSlot = () => {
  try {
    return sessionStorage.getItem(SLOT_KEY);
  } catch {
    return null;
  }
};
export function getSlot(): string | null {
  const s = readSlot();
  return s && s !== LOGGED_OUT ? s : null;
}
/** A tab that has no login of its own and was not logged out takes a copy of the browser's latest login. */
export const shouldAdoptLogin = () => readSlot() === null;
/** `null` = this tab logged out. */
export function setSlot(slot: string | null) {
  try {
    sessionStorage.setItem(SLOT_KEY, slot ?? LOGGED_OUT);
  } catch {
    /* storage blocked: the tab falls back to the browser's default login */
  }
}
/** URL for a link, image or download, carrying this tab's login (those requests cannot send headers). */
export function withSlot(url: string): string {
  const slot = getSlot();
  if (!slot) return url;
  return `${url}${url.includes('?') ? '&' : '?'}slot=${encodeURIComponent(slot)}`;
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
        // this tab's login; '-' after "Sair", so the tab does not fall back to another window's login
        ...(readSlot() ? { 'x-fr-slot': readSlot()! } : {}),
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
    if (res.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/adopt')) onUnauthorized?.();
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
