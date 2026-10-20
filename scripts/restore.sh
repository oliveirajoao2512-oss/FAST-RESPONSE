#!/usr/bin/env bash
# Restaura um backup gerado por scripts/backup.sh. SUBSTITUI todos os dados atuais.
# Uso: scripts/restore.sh backups/fastresponse-AAAAMMDD-HHMMSS.dump backups/uploads-AAAAMMDD-HHMMSS.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?informe o arquivo .dump}"
UPLOADS="${2:?informe o arquivo uploads-*.tar.gz}"
read -r -p "Isto apaga os dados atuais e restaura '$DUMP'. Digite RESTAURAR para continuar: " ok
[ "$ok" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
docker compose stop app
docker compose exec -T db psql -U fastresponse -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS fastresponse WITH (FORCE)" -c "CREATE DATABASE fastresponse OWNER fastresponse"
docker compose exec -T db pg_restore -U fastresponse -d fastresponse --no-owner --exit-on-error < "$DUMP"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /data/uploads && tar xzf - -C /data' < "$UPLOADS"
docker compose start app
echo "Restauração concluída."
