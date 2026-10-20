import nodemailer from 'nodemailer';
import { env } from './env.js';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export function emailEnabled() {
  return Boolean(env.smtp.host);
}

export async function sendEmail(to: string, subject: string, text: string) {
  if (!emailEnabled()) throw new Error('SMTP não configurado');
  transport ??= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  await transport.sendMail({ from: env.smtp.from, to, subject, text });
}
