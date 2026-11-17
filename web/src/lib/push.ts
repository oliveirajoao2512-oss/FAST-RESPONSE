import { useCallback, useEffect, useState } from 'react';
import { get, post } from './api';
import { isIos, isStandalone } from './install';

/**
 * Notifications on this phone/tablet/computer (Web Push). They arrive with the app closed. The device follows the
 * person logged in: activating registers it for them, "Sair" removes it, and the next login takes it over again.
 */
export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  // the worker is registered on load (production build); wait for it, but never forever
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  return reg ?? (await navigator.serviceWorker.getRegistration()) ?? null;
}

const toKey = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : isIos() ? 'iPhone/iPad' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Aparelho';
  const br = /edg\//i.test(ua) ? 'Edge' : /firefox/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'navegador';
  return `${os} · ${br}${isStandalone() ? ' (app)' : ''}`;
};

const send = (sub: PushSubscription) => {
  const j = sub.toJSON();
  return post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys, device: deviceName() });
};

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return 'off';
  const s = await post<{ here: boolean }>('/api/push/status', { endpoint: sub.endpoint }).catch(() => ({ here: false }));
  return s.here ? 'on' : 'off';
}

/** Asks permission (needs a tap), registers the device and sends a test notification. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) throw new Error('O aplicativo ainda está carregando. Tente de novo em alguns segundos.');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
  }
  await send(sub);
  await post('/api/push/test').catch(() => {});
  return 'on';
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
}

/** On login: a device that already allowed notifications passes to the person now logged in, with no question. */
export async function syncPush() {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const reg = await registration();
    if (!reg) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
    }
    await send(sub);
  } catch { /* the menu shows the state and lets the person try again */ }
}

export function usePush() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => { pushState().then(setState).catch(() => setState('unsupported')); }, []);
  useEffect(refresh, [refresh]);
  const run = (fn: () => Promise<PushState | void>) => async () => {
    setBusy(true); setError(null);
    try { const s = await fn(); if (s) setState(s); else refresh(); } catch (e: any) { setError(e?.message ?? 'Não foi possível ativar os avisos.'); } finally { setBusy(false); }
  };
  return { state, busy, error, enable: run(enablePush), disable: run(async () => { await disablePush(); return 'off' as const; }) };
}
