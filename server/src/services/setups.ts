/**
 * Read-only link to the "Controle de Setup" app (Firestore project controle-f7242, collection `setups`).
 * Fast Response never writes there: it only asks which machines are in setup now and what happened today,
 * through Firestore's REST API. Shown only to the administrator for now (João's request, 27/11/2026).
 *
 * SETUP_FIRESTORE_PROJECT changes the project; SETUP_SOURCE=off turns the link off.
 */

export type SetupStatus = 'Em andamento' | 'Aguardando Produção' | 'Finalizado';
export interface SetupRow {
  id: string;
  machine: string;
  pn: string | null;
  user: string | null;
  status: SetupStatus;
  startedAt: string;
  /** end of the setup itself; production may start later ("Aguardando Produção") */
  finishedAt: string | null;
  productionAt: string | null;
  stopAfter: string | null;
}
export interface SetupSnapshot { ok: boolean; error?: string; rows: SetupRow[]; fetchedAt: string }
type Fetcher = (sinceMs: number) => Promise<SetupRow[]>;

const project = () => process.env.SETUP_FIRESTORE_PROJECT || 'controle-f7242';
const enabled = () => process.env.SETUP_SOURCE !== 'off' && process.env.NODE_ENV !== 'test';

const val = (v: any): any =>
  v == null ? null
    : 'stringValue' in v ? v.stringValue
      : 'integerValue' in v ? Number(v.integerValue)
        : 'doubleValue' in v ? v.doubleValue
          : 'booleanValue' in v ? v.booleanValue
            : null;
const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

async function runQuery(where: unknown): Promise<any[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${project()}/databases/(default)/documents:runQuery`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'setups' }], where } }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Controle de Setup respondeu ${r.status}`);
  const out = (await r.json()) as any[];
  return out.filter((x) => x.document).map((x) => Object.fromEntries(Object.entries(x.document.fields ?? {}).map(([k, v]) => [k, val(v)])));
}

export function toRow(d: Record<string, any>): SetupRow | null {
  if (!d.maquina || !d.inicio_timestamp) return null;
  const status: SetupStatus = d.status || (d.fim_timestamp ? 'Finalizado' : 'Em andamento');
  return {
    id: String(d.id ?? ''),
    machine: String(d.maquina).trim(),
    pn: d.pn ? String(d.pn) : null,
    user: d.usuario ? String(d.usuario) : null,
    status,
    startedAt: iso(d.inicio_timestamp)!,
    finishedAt: iso(d.fim_timestamp),
    productionAt: iso(d.inicio_producao_timestamp),
    stopAfter: d.teve_parada_pos_inicio ? (d.motivo_parada_pos_inicio ?? null) : null,
  };
}

/** setups still open (any start date) plus every setup started since `sinceMs` */
const firestoreFetcher: Fetcher = async (sinceMs) => {
  const [open, recent] = await Promise.all([
    runQuery({ fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'Em andamento' }, { stringValue: 'Aguardando Produção' }] } } } }),
    runQuery({ fieldFilter: { field: { fieldPath: 'inicio_timestamp' }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: String(Math.floor(sinceMs)) } } }),
  ]);
  const byId = new Map<string, SetupRow>();
  for (const d of [...recent, ...open]) {
    const row = toRow(d);
    if (row) byId.set(row.id || `${row.machine}|${row.startedAt}`, row);
  }
  return [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
};

let fetcher: Fetcher | null = null;
let cache: { key: number; at: number; snap: SetupSnapshot } | null = null;

/** tests plug a fake source here; null goes back to the default */
export function setSetupFetcher(f: Fetcher | null) { fetcher = f; cache = null; }

/** cached for 30 s, so a TV refreshing every 30 s does not hammer Firestore */
export async function setupSnapshot(sinceMs: number): Promise<SetupSnapshot | null> {
  const f = fetcher ?? (enabled() ? firestoreFetcher : null);
  if (!f) return null;
  const now = Date.now();
  if (cache && cache.key === sinceMs && now - cache.at < 30_000) return cache.snap;
  try {
    const snap = { ok: true, rows: await f(sinceMs), fetchedAt: new Date(now).toISOString() };
    cache = { key: sinceMs, at: now, snap };
    return snap;
  } catch (e) {
    // keep showing the last good data, flagged as stale
    if (cache) return { ...cache.snap, ok: false, error: (e as Error).message };
    return { ok: false, error: (e as Error).message, rows: [], fetchedAt: new Date(now).toISOString() };
  }
}

export const machineKey = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');
