/**
 * "Visualizar como": the administrator previews the system with another profile's permissions.
 * The choice travels in a cookie (so it also covers live updates and file links); the server applies
 * it only to administrators and blocks every change while it is on.
 */
const COOKIE = 'fr_view_as';

export function startPreview(role: string, areaId: number | null) {
  document.cookie = `${COOKIE}=${role}${areaId ? `:${areaId}` : ''}; path=/; SameSite=Lax`;
  location.assign('/');
}

export function stopPreview(reload = true) {
  document.cookie = `${COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  if (reload) location.assign('/');
}
