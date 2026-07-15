#!/usr/bin/env bash
# SkladyX · бэкап PostgreSQL (custom format -Fc, удобен для pg_restore).
#
# Секретов не содержит: pg_dump идёт через локальный сокет контейнера db
# (pg_hba.conf: `local all all trust`), пароль БД не требуется и не печатается.
#
# Конфиг через env (значения по умолчанию — под prod sklad-prod-01):
#   SKLADYX_DIR            каталог compose-проекта (там docker-compose.yml)   [/opt/skladyx]
#   SKLADYX_PG_BACKUP_DIR  куда складывать дампы                              [/opt/backups/postgres]
#   SKLADYX_RETENTION_DAYS сколько дней хранить                               [14]
set -euo pipefail

PROJECT_DIR="${SKLADYX_DIR:-/opt/skladyx}"
BACKUP_DIR="${SKLADYX_PG_BACKUP_DIR:-/opt/backups/postgres}"
RETENTION_DAYS="${SKLADYX_RETENTION_DAYS:-14}"
DB_SERVICE="db"
DB_USER="skladyx"
DB_NAME="skladyx"

log() { echo "[$(date '+%F %T')] postgres: $*"; }

ts="$(date +%Y%m%d-%H%M%S)"
out="${BACKUP_DIR}/skladyx-postgres-${ts}.dump"

mkdir -p "$BACKUP_DIR"
cd "$PROJECT_DIR"

log "start dump -> ${out}"
if docker compose exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$out"; then
  if [ -s "$out" ]; then
    log "OK ${out} ($(du -h "$out" | cut -f1))"
  else
    log "ERROR: дамп пустой, удаляю ${out}"; rm -f "$out"; exit 1
  fi
else
  rc=$?
  log "ERROR: pg_dump завершился с ошибкой (rc=${rc}), удаляю частичный файл"
  rm -f "$out"; exit 1
fi

# retention: удалить дампы старше N дней
deleted="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'skladyx-postgres-*.dump' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
log "retention: старше ${RETENTION_DAYS}д удалено = ${deleted}"
