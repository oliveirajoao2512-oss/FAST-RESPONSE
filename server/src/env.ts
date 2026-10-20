import fs from 'node:fs';
import path from 'node:path';

// Loads .env from the working directory or the repository root; variables already set win.
for (const f of [path.resolve('.env'), path.resolve('../.env')]) {
  if (fs.existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}

function num(name: string, def: number) {
  const v = process.env[name];
  return v ? Number(v) : def;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://fr:fr@localhost:5432/fastresponse',
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './data/uploads'),
  maxUploadMb: num('MAX_UPLOAD_MB', 15),
  sessionDays: num('SESSION_DAYS', 7),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  webDist: process.env.WEB_DIST ?? path.resolve(process.cwd(), '../web/dist'),
  jobsEnabled: process.env.JOBS_ENABLED !== 'false',
  jobIntervalSeconds: num('JOB_INTERVAL_SECONDS', 60),
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    secretKey: process.env.SUPABASE_SECRET_KEY ?? '',
    bucket: process.env.SUPABASE_BUCKET ?? 'anexos',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'Fast Response <fastresponse@localhost>',
  },
};
