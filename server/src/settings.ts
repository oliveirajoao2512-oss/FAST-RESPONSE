import { mergeConfig, type AppConfig } from '../../shared/config.js';
import { one, type Db, pool } from './db.js';

let cache: { cfg: AppConfig; at: number } | null = null;

export async function getConfig(db: Db = pool): Promise<AppConfig> {
  if (cache && Date.now() - cache.at < 5000) return cache.cfg;
  const row = await one<{ value: unknown }>("SELECT value FROM settings WHERE key = 'config'", [], db);
  const cfg = mergeConfig(row?.value ?? {});
  cache = { cfg, at: Date.now() };
  return cfg;
}

export function invalidateConfig() {
  cache = null;
}
