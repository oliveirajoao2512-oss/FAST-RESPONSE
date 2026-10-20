import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseStorage } from '../src/storage.js';

// Minimal stand-in for the Supabase Storage REST API, to check the requests the driver sends.
const objects = new Map<string, Buffer>();
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers });
      if (req.headers.apikey !== 'sb_secret_teste') return res.writeHead(401).end('{"error":"unauthorized"}');
      const prefix = '/storage/v1/object/anexos';
      if (req.method === 'POST' && req.url!.startsWith(prefix + '/')) {
        const key = decodeURIComponent(req.url!.slice(prefix.length + 1));
        if (objects.has(key)) return res.writeHead(409).end('{"error":"Duplicate"}');
        objects.set(key, Buffer.concat(chunks));
        return res.writeHead(200).end('{}');
      }
      if (req.method === 'GET' && req.url!.startsWith(prefix + '/')) {
        const data = objects.get(decodeURIComponent(req.url!.slice(prefix.length + 1)));
        return data ? res.writeHead(200).end(data) : res.writeHead(400).end('{"error":"not_found"}');
      }
      if (req.method === 'DELETE' && req.url === prefix) {
        for (const k of JSON.parse(Buffer.concat(chunks).toString()).prefixes) objects.delete(k);
        return res.writeHead(200).end('[]');
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('armazenamento de anexos no Supabase Storage', () => {
  it('grava, lê e remove em bucket privado usando a chave secreta', async () => {
    const s = new SupabaseStorage(base, 'sb_secret_teste', 'anexos');
    const data = Buffer.from([0, 1, 2, 250]);
    await s.put('2026/10/abc', data, 'image/png');
    expect(seen[0].headers['content-type']).toBe('image/png');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect((await s.get('2026/10/abc'))!.equals(data)).toBe(true);
    await expect(s.put('2026/10/abc', data, 'image/png')).rejects.toThrow(/409/);
    await s.remove('2026/10/abc');
    expect(await s.get('2026/10/abc')).toBeNull();
  });
  it('falha de autenticação vira erro claro', async () => {
    const s = new SupabaseStorage(base, 'chave-errada', 'anexos');
    await expect(s.put('x', Buffer.from('a'), 'text/plain')).rejects.toThrow(/401/);
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer chave-errada');
  });
});
