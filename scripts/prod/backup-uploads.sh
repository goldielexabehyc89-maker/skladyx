#!/usr/bin/env bash
# SkladyX · бэкап uploads (docker volume skladyx_skladyx_uploads) в tar.gz.
#
# App НЕ останавливаем — снимаем tar текущего состояния тома в режиме read-only
# через одноразовый helper-контейнер (образ postgres:16-alpine уже есть на сервере,
# нового pull не требуется).
#
# Конфиг через env (значения по умолчанию — под prod):
#   SKLADYX_UP_BACKUP_DIR    куда складывать архивы          [/opt/backups/uploads]
#   SKLADYX_UPLOADS_VOLUME   имя docker-тома uploads         [skladyx_skladyx_uploads]
#   SKLADYX_HELPER_IMAGE     образ с tar/gzip                [postgres:16-alpine]
#   SKLADYX_RETENTION_DAYS   сколько дней хранить            [14]
set -euo pipefail

BACKUP_DIR="${SKLADYX_UP_BACKUP_DIR:-/opt/backups/uploads}"
VOLUME="${SKLADYX_UPLOADS_VOLUME:-skladyx_skladyx_uploads}"
HELPER_IMAGE="${SKLADYX_HELPER_IMAGE:-postgres:16-alpine}"
RETENTION_DAYS="${SKLADYX_RETENTION_DAYS:-14}"

log() { echo "[$(date '+%F %T')] uploads: $*"; }

ts="$(date +%Y%m%d-%H%M%S)"
fname="skladyx-uploads-${ts}.tar.gz"
out="${BACKUP_DIR}/${fname}"

mkdir -p "$BACKUP_DIR"

log "start tar volume=${VOLUME} -> ${out}"
if docker run --rm \
      -v "${VOLUME}:/data:ro" \
      -v "${BACKUP_DIR}:/backup" \
      "$HELPER_IMAGE" \
      tar czf "/backup/${fname}" -C /data . ; then
  if [ -s "$out" ]; then
    files="$(tar tzf "$out" 2>/dev/null | grep -vc '/$' || true)"
    log "OK ${out} ($(du -h "$out" | cut -f1), файлов~${files})"
  else
    log "ERROR: архив пустой, удаляю ${out}"; rm -f "$out"; exit 1
  fi
else
  rc=$?
  log "ERROR: tar завершился с ошибкой (rc=${rc}), удаляю частичный файл"
  rm -f "$out"; exit 1
fi

# retention: удалить архивы старше N дней
deleted="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'skladyx-uploads-*.tar.gz' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
log "retention: старше ${RETENTION_DAYS}д удалено = ${deleted}"
