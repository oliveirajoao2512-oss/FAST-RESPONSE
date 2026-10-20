#!/usr/bin/env bash
# Backup completo (banco + anexos) da instalação via docker compose.
# Uso: scripts/backup.sh [pasta-destino]      (padrão: ./backups)
# Agende diariamente (cron) e copie a pasta para outro servidor/armazenamento.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
echo "→ banco de dados"
docker compose exec -T db pg_dump -U fastresponse -d fastresponse -Fc > "$DEST/fastresponse-$STAMP.dump"
echo "→ anexos"
docker compose exec -T app tar czf - -C /data uploads > "$DEST/uploads-$STAMP.tar.gz"
echo "Backup gerado:"
ls -lh "$DEST/fastresponse-$STAMP.dump" "$DEST/uploads-$STAMP.tar.gz"
