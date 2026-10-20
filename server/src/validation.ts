import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message }));
    throw badRequest(`Dados inválidos: ${fields.map((f) => `${f.campo || 'valor'} (${f.mensagem})`).join('; ')}`, fields);
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const isoDate = z.coerce.date();
export const optText = (max = 4000) =>
  z.string().max(max).transform((s) => s.trim()).nullish().transform((s) => (s ? s : null));
