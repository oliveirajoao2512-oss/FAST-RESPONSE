import { hashPassword, passwordProblem } from '../auth.js';
import { one, q } from '../db.js';

/**
 * First start: if there are no users, creates the administrator from
 * ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME. No other users are created.
 */
export async function ensureBootstrapAdmin(log: (m: string) => void) {
  const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if (n!.n > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log('Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_PASSWORD ou rode "npm run create-admin" para criar o administrador.');
    return;
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD inválida: ${problem}`);
  await q(
    `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ($1,$2,$3,'admin',true)`,
    [process.env.ADMIN_NAME ?? 'Administrador', email.toLowerCase(), await hashPassword(password)],
  );
  log(`Administrador inicial criado: ${email} (troca de senha obrigatória no primeiro acesso).`);
}
