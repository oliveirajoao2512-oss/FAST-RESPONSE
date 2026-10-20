import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';

/**
 * Attachment storage. Local disk by default; Supabase Storage (private bucket) when
 * SUPABASE_URL and SUPABASE_SECRET_KEY are set, for hosts without a persistent disk.
 */
export interface Storage {
  readonly name: string;
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements Storage {
  readonly name = 'disco local';
  constructor(private root: string) {}
  private abs(key: string) {
    const abs = path.resolve(this.root, key);
    if (!abs.startsWith(this.root + path.sep)) throw new Error('Caminho de arquivo inválido.');
    return abs;
  }
  async put(key: string, data: Buffer) {
    const abs = this.abs(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data, { flag: 'wx' });
  }
  async get(key: string) {
    return fs.readFile(this.abs(key)).catch(() => null);
  }
  async remove(key: string) {
    await fs.unlink(this.abs(key)).catch(() => {});
  }
}

export class SupabaseStorage implements Storage {
  readonly name = 'Supabase Storage';
  constructor(private url: string, private key: string, private bucket: string) {}
  private headers(extra: Record<string, string> = {}) {
    // New secret keys (sb_secret_…) go in the apikey header only; legacy service_role JWTs also as Bearer.
    const h: Record<string, string> = { apikey: this.key, ...extra };
    if (!this.key.startsWith('sb_')) h.authorization = `Bearer ${this.key}`;
    return h;
  }
  private objectUrl(key: string) {
    return `${this.url}/storage/v1/object/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  async put(key: string, data: Buffer, mime: string) {
    const r = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers({ 'content-type': mime, 'x-upsert': 'false' }),
      body: new Uint8Array(data),
    });
    if (!r.ok) throw new Error(`Falha ao gravar anexo no Supabase Storage (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string) {
    const r = await fetch(this.objectUrl(key), { headers: this.headers() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`Falha ao ler anexo no Supabase Storage (${r.status}).`);
    return Buffer.from(await r.arrayBuffer());
  }
  async remove(key: string) {
    await fetch(`${this.url}/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [key] }),
    }).catch(() => {});
  }
}

export const storage: Storage = env.supabase.url && env.supabase.secretKey
  ? new SupabaseStorage(env.supabase.url.replace(/\/+$/, ''), env.supabase.secretKey, env.supabase.bucket)
  : new LocalStorage(env.uploadDir);
