#!/usr/bin/env bash
# SkladyX · общий бэкап: PostgreSQL + uploads. Пишет общий статус в stdout
# (cron перенаправляет в /opt/backups/backup.log). Возвращает ненулевой код,
# если хотя бы один под-скрипт упал (но выполняет оба независимо).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[$(date '+%F %T')] backup-all: $*"; }

log "=== START ==="
rc=0
"${DIR}/backup-postgres.sh" || rc=$?
"${DIR}/backup-uploads.sh"  || rc=$?

if [ "$rc" -eq 0 ]; then
  log "=== DONE OK ==="
else
  log "=== DONE WITH ERRORS (rc=${rc}) ==="
fi
exit "$rc"
