import readline from 'node:readline/promises';
import { hashPassword, passwordProblem } from '../auth.js';
import { migrate, pool, q } from '../db.js';

// Usage: npm run create-admin -w server  (interactive) — creates or resets an administrator.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await migrate(() => {});
const name = (await rl.question('Nome: ')).trim();
const email = (await rl.question('E-mail: ')).trim().toLowerCase();
const password = await rl.question('Senha provisória: ');
rl.close();
const problem = passwordProblem(password);
if (!name || !email || problem) {
  console.error(problem ?? 'Nome e e-mail são obrigatórios.');
  process.exit(1);
}
await q(
  `INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ($1,$2,$3,'admin',true)
   ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', active = true, must_change_password = true, failed_logins = 0, locked_until = NULL`,
  [name, email, await hashPassword(password)],
);
console.log(`Administrador ${email} pronto. Troca de senha obrigatória no primeiro acesso.`);
await pool.end();
