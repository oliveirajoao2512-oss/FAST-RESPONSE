import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { one, q } from '../db.js';
import { getConfig } from '../settings.js';
import { parse } from '../validation.js';

export const DEFAULT_STEP_TEMPLATES = [
  {
    name: 'Manutenção de molde',
    steps: ['Diagnosticar o problema', 'Definir a intervenção necessária', 'Separar materiais e ferramentas', 'Executar a manutenção',
      'Realizar teste de funcionamento', 'Validar o resultado', 'Encerrar a pendência'],
  },
  { name: 'Análise de causa (simples)', steps: ['Conter o problema', 'Identificar a causa raiz', 'Implementar ação corretiva', 'Verificar eficácia'] },
];

/** Reference data used by forms and filters (any authenticated user). */
export async function metaRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    requireUser(req, { allowPendingPassword: true });
    const cfg = await getConfig();
    const [areas, categories, users, templates] = await Promise.all([
      q('SELECT id, slug, name, color, sort FROM areas WHERE active ORDER BY sort'),
      q('SELECT id, name, area_id, is_safety, requires_evidence, active FROM categories ORDER BY active DESC, name'),
      q(`SELECT id, name, role, area_id, active FROM users ORDER BY name`),
      one<{ value: any }>("SELECT value FROM settings WHERE key = 'step_templates'"),
    ]);
    return {
      areas, categories, users,
      stepTemplates: templates?.value ?? DEFAULT_STEP_TEMPLATES,
      config: { timezone: cfg.timezone, deadline: cfg.deadline, workflow: cfg.workflow, scoring: cfg.scoring, complexity: cfg.complexity, recurrence: cfg.recurrence, escalation: cfg.escalation },
    };
  });

  app.get('/api/assets', async (req) => {
    requireUser(req);
    const qs = parse(z.object({ q: z.string().max(60).default(''), type: z.string().max(20).optional(), all: z.coerce.boolean().optional() }), req.query);
    if (qs.all) return q('SELECT a.*, ar.name AS area_name FROM assets a LEFT JOIN areas ar ON ar.id = a.area_id ORDER BY a.type, a.sort, a.code');
    const term = `%${qs.q}%`;
    // Registered assets first, then references already used in issues.
    return q(
      `SELECT * FROM (
         SELECT type, code, description, 0 AS rank FROM assets WHERE active AND (code ILIKE $1 OR description ILIKE $1) AND ($2::text IS NULL OR type = $2)
         UNION
         SELECT DISTINCT asset_type, asset_ref, NULL, 1 FROM issues WHERE asset_ref ILIKE $1 AND ($2::text IS NULL OR asset_type = $2)
       ) x ORDER BY rank, code LIMIT 15`, [term, qs.type ?? null]);
  });
}
