#!/usr/bin/env bash
# Runs the UI test suite against a throwaway database (fastresponse_e2e).
# Requires: local PostgreSQL with role able to create databases, built web (npm run build -w web).
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${E2E_DB:-fastresponse_e2e}
PGURL=${E2E_PG:-postgresql://fr:fr@localhost:5432}
psql "$PGURL/postgres" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
fuser -k 3100/tcp 2>/dev/null || true
mkdir -p data/e2e
cd server
PORT=3100 DATABASE_URL="$PGURL/$DB" ADMIN_EMAIL=admin@e2e.local ADMIN_PASSWORD=Admin12345 BCRYPT_COST=8 \
  UPLOAD_DIR=../data/e2e/uploads JOB_INTERVAL_SECONDS=10 npx tsx src/index.ts > ../data/e2e/server.log 2>&1 < /dev/null &
cd ..
for i in $(seq 1 30); do curl -sf localhost:3100/api/health >/dev/null && break; sleep 1; done
set +e
BASE_URL=http://localhost:3100 npx playwright test "$@"
code=$?
fuser -k 3100/tcp >/dev/null 2>&1 || true
exit $code
