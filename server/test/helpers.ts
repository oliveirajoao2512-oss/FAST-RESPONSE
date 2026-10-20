import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { migrate, one, pool, q } from '../src/db.js';
import { invalidateConfig } from '../src/settings.js';

export const PASSWORD = 'Senha12345';

/** Recreates the test database schema from the migrations. */
export async function resetDb() {
  if (!process.env.DATABASE_URL?.includes('test')) throw new Error('Os testes só rodam em um banco cujo nome contém "test".');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  invalidateConfig();
}

export async function areaId(slug: string): Promise<number> {
  return (await one<{ id: number }>('SELECT id FROM areas WHERE slug = $1', [slug]))!.id;
}

export async function createUser(name: string, role: string, areaSlug: string | null) {
  const area = areaSlug ? await areaId(areaSlug) : null;
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@teste.local`;
  const row = await one<{ id: string }>(
    `INSERT INTO users (name, email, role, area_id, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,false) RETURNING id`,
    [name, email, role, area, await hashPassword(PASSWORD)]);
  return { id: row!.id, email, name, role };
}

export class Client {
  cookie = '';
  constructor(public app: FastifyInstance) {}
  async login(email: string, password = PASSWORD) {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: email, password }, headers: { 'x-requested-with': 'fast-response' } });
    if (r.statusCode !== 200) throw new Error(`login falhou: ${r.body}`);
    const c = r.cookies.find((c) => c.name === 'fr_session')!;
    this.cookie = `fr_session=${c.value}`;
    return this;
  }
  async req(method: string, url: string, payload?: unknown) {
    const r = await this.app.inject({
      method: method as any, url, payload: payload as any,
      headers: { cookie: this.cookie, 'x-requested-with': 'fast-response' },
    });
    let body: any = r.body;
    try { body = r.json(); } catch {}
    return { status: r.statusCode, body };
  }
  get(url: string) { return this.req('GET', url); }
  post(url: string, payload: unknown = {}) { return this.req('POST', url, payload); }
  patch(url: string, payload: unknown) { return this.req('PATCH', url, payload); }
  put(url: string, payload: unknown) { return this.req('PUT', url, payload); }
  async issue(id: string) {
    const r = await this.get(`/api/issues/${id}`);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body;
  }
}

export async function setup() {
  await resetDb();
  const app = await buildApp();
  const users = {
    admin: await createUser('Admin Teste', 'admin', null),
    gestor: await createUser('Gestor Teste', 'gestor', null),
    liderMan: await createUser('Lider Manutencao', 'lider', 'manutencao'),
    liderFerr: await createUser('Lider Ferramentaria', 'lider', 'ferramentaria'),
    liderProd: await createUser('Lider Producao', 'lider', 'producao'),
    tecMan: await createUser('Tecnico Manutencao', 'colaborador', 'manutencao'),
    tecFerr: await createUser('Ferramenteiro', 'colaborador', 'ferramentaria'),
    operador: await createUser('Operador Producao', 'colaborador', 'producao'),
  };
  const c = async (k: keyof typeof users) => new Client(app).login(users[k].email);
  return { app, users, c, q };
}
