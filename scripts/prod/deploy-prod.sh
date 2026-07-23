#!/usr/bin/env bash
# SkladyX · деплой на PROD. Запускать ЛОКАЛЬНО (с мака), из корня репозитория.
#
# Target зашит жёстко и НЕ параметризуется — это защита от выкатки не в тот контур.
# Prod-деплой разрешён только по явной команде владельца («выкатывай на prod»)
# и требует двух подтверждающих переменных окружения.
#
# Использование:
#   DEPLOY_ENV=prod CONFIRM_PROD_DEPLOY=rostagro ./scripts/prod/deploy-prod.sh
#
# ВНИМАНИЕ: откат кода НЕ откатывает миграции Prisma (migrate deploy — forward-only).
# Если релиз содержал миграции, откат схемы — только restore из бэкапа (docs/RESTORE.md).
set -euo pipefail

# ─── ЗАШИТЫЙ TARGET (prod) ──────────────────────────────────────────────────
ENV_NAME="prod"
TARGET_PATH="/opt/skladyx"
COMPOSE_FILE="docker-compose.yml"
APP_PORT="3003"
PUBLIC_URL="https://rostagro.skladyx.ru"
EXPECTED_APP_URL="https://rostagro.skladyx.ru"          # маркер контура в целевом .env
BACKUP_SCRIPT="/opt/skladyx/scripts/prod/backup-all.sh"
BACKUP_LOG="/opt/backups/backup.log"
PG_BACKUP_DIR="/opt/backups/postgres"
UP_BACKUP_DIR="/opt/backups/uploads"
BACKUP_MAX_AGE_MIN=10          # дамп должен быть создан не раньше, чем N минут назад
# ────────────────────────────────────────────────────────────────────────────

SERVER_IP="${SKLADYX_SERVER_IP:-104.171.136.35}"
SERVER_USER="${SKLADYX_SERVER_USER:-root}"
SERVER_HOSTNAME="sklad-prod-01"
SSH_KEY="${SKLADYX_SSH_KEY:-$HOME/.ssh/sklad_prod_ed25519}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15)

RSYNC_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.env'
  --exclude 'uploads' --exclude 'backups' --exclude 'logs'
  --exclude '*.tsbuildinfo' --exclude '.DS_Store'
)

say()  { echo "[deploy:${ENV_NAME}] $*"; }
die()  { echo "[deploy:${ENV_NAME}] ОСТАНОВЛЕНО: $*" >&2; exit 1; }
ssh_() { ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_IP}" "$@"; }

say "=== СТАРТ ($(date '+%F %T')) → ${ENV_NAME} ${TARGET_PATH} ==="

# ─── GUARD 0: явное подтверждение prod-деплоя ──────────────────────────────
[ "${DEPLOY_ENV:-}" = "prod" ] || \
  die "нет DEPLOY_ENV=prod. Prod-деплой только по явной команде владельца."
[ "${CONFIRM_PROD_DEPLOY:-}" = "rostagro" ] || \
  die "нет CONFIRM_PROD_DEPLOY=rostagro. Запуск: DEPLOY_ENV=prod CONFIRM_PROD_DEPLOY=rostagro $0"
say "подтверждение prod-деплоя принято"

# ─── GUARD 1: скрипт локальный, не запускать на сервере ────────────────────
[ "$(hostname -s 2>/dev/null || hostname)" = "$SERVER_HOSTNAME" ] && \
  die "запущен на сервере (${SERVER_HOSTNAME}). Деплой запускается ЛОКАЛЬНО с мака."

# ─── GUARD 2: запуск из корня локального репозитория ───────────────────────
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "не git-репозиторий"
REPO_ROOT="$(git rev-parse --show-toplevel)"
[ "$PWD" = "$REPO_ROOT" ] || die "запускать из корня репозитория: ${REPO_ROOT}"
[ -f "$COMPOSE_FILE" ] || die "в корне нет ${COMPOSE_FILE} — это не тот репозиторий"

# ─── GUARD 3: рабочее дерево чистое ────────────────────────────────────────
[ -z "$(git status --porcelain)" ] || die "рабочее дерево не чистое (git status). Закоммить или спрячь изменения."

# ─── GUARD 4: ветка main ───────────────────────────────────────────────────
BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "main" ] || die "текущая ветка '${BRANCH}', ожидается 'main'"

# ─── GUARD 5: main == origin/main ──────────────────────────────────────────
say "git fetch origin main…"
git fetch origin main --quiet
LOCAL_SHA="$(git rev-parse main)"; REMOTE_SHA="$(git rev-parse origin/main)"
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || \
  die "main (${LOCAL_SHA:0:7}) != origin/main (${REMOTE_SHA:0:7}). Сначала push/pull."
say "деплоим коммит ${LOCAL_SHA:0:7}"

# ─── GUARD 6: сервер тот самый ─────────────────────────────────────────────
REMOTE_HOST="$(ssh_ 'hostname -s 2>/dev/null || hostname')" || die "нет ssh-доступа к ${SERVER_IP}"
[ "$REMOTE_HOST" = "$SERVER_HOSTNAME" ] || die "на ${SERVER_IP} hostname='${REMOTE_HOST}', ожидается '${SERVER_HOSTNAME}'"

# ─── GUARD 7: маркер контура — APP_URL в целевом .env ──────────────────────
# Наличие compose-файла контуры НЕ различает: оба файла лежат в обоих каталогах.
ssh_ "test -d '${TARGET_PATH}'" || die "на сервере нет каталога ${TARGET_PATH}"
ssh_ "test -f '${TARGET_PATH}/.env'" || die "в ${TARGET_PATH} нет .env — контур не инициализирован"
TARGET_APP_URL="$(ssh_ "grep -E '^APP_URL=' '${TARGET_PATH}/.env' | head -1 | cut -d= -f2-")"
[ "$TARGET_APP_URL" = "$EXPECTED_APP_URL" ] || \
  die "маркер контура не совпал: в ${TARGET_PATH}/.env APP_URL='${TARGET_APP_URL}', ожидается '${EXPECTED_APP_URL}'. Похоже, это ДРУГОЙ контур — деплой отменён."
say "маркер контура OK (APP_URL=${TARGET_APP_URL})"

# ─── GUARD 8: свежий бэкап ПЕРЕД выкаткой + доказательство его пригодности ─
# Мало запустить backup-all.sh: нужно доказать, что PostgreSQL-дамп создан ИМЕННО
# этим запуском и физически читается. backup-all.sh путь к дампу не возвращает
# (пишет только человекочитаемый лог, куда пишет и cron), поэтому опознаём дамп
# по маркеру времени: файл, созданный ПОЗЖЕ маркера = результат нашего запуска.
BACKUP_MARKER="/tmp/skladyx-deploy-backup-marker.$$"

say "снимаю свежий бэкап prod перед выкаткой: ${BACKUP_SCRIPT}"
ssh_ "touch '${BACKUP_MARKER}'" || die "не удалось создать маркер времени на сервере"
if ! ssh_ "${BACKUP_SCRIPT} >> ${BACKUP_LOG} 2>&1"; then
  ssh_ "rm -f '${BACKUP_MARKER}'" || true
  die "бэкап упал — prod-деплой остановлен. Смотри ${BACKUP_LOG}"
fi

# 8.1 — дамп, созданный позже маркера (т.е. этим запуском)
FRESH_DUMP="$(ssh_ "find '${PG_BACKUP_DIR}' -maxdepth 1 -type f -name 'skladyx-postgres-*.dump' -newer '${BACKUP_MARKER}' -print 2>/dev/null | sort | tail -1")"
FRESH_UPLOAD="$(ssh_ "find '${UP_BACKUP_DIR}' -maxdepth 1 -type f -name 'skladyx-uploads-*.tar.gz' -newer '${BACKUP_MARKER}' -print 2>/dev/null | sort | tail -1")"
ssh_ "rm -f '${BACKUP_MARKER}'" || true

[ -n "$FRESH_DUMP" ] || \
  die "backup-all.sh отработал, но НОВОГО дампа в ${PG_BACKUP_DIR} не появилось — деплой остановлен. Смотри ${BACKUP_LOG}"
say "свежий дамп: ${FRESH_DUMP}"

# 8.2 — файл существует и не пустой
ssh_ "test -s '${FRESH_DUMP}'" \
  || die "дамп ${FRESH_DUMP} отсутствует или пустой — деплой остановлен"

# 8.3 — возраст дампа меньше ${BACKUP_MAX_AGE_MIN} минут
ssh_ "find '${FRESH_DUMP}' -mmin -${BACKUP_MAX_AGE_MIN} | grep -q ." \
  || die "дамп ${FRESH_DUMP} старше ${BACKUP_MAX_AGE_MIN} мин — он не от этого запуска, деплой остановлен"

# 8.4 — дамп физически читается: pg_restore --list разбирает оглавление (БД не трогаем)
TOC_LINES="$(ssh_ "set -o pipefail; cd '${TARGET_PATH}' && docker compose -f '${COMPOSE_FILE}' exec -T db pg_restore --list < '${FRESH_DUMP}' 2>/dev/null | wc -l")" \
  || die "дамп ${FRESH_DUMP} НЕ читается (pg_restore --list завершился с ошибкой) — деплой остановлен"
[ "${TOC_LINES:-0}" -gt 0 ] 2>/dev/null \
  || die "оглавление дампа ${FRESH_DUMP} пустое — дамп непригоден, деплой остановлен"

say "бэкап проверен: не пустой, свежее ${BACKUP_MAX_AGE_MIN} мин, оглавление читается (${TOC_LINES} записей)"
ssh_ "ls -lh '${FRESH_DUMP}'"
if [ -n "$FRESH_UPLOAD" ]; then
  ssh_ "ls -lh '${FRESH_UPLOAD}'"
else
  say "ВНИМАНИЕ: свежий архив uploads не найден (backup-all.sh вернул успех) — проверь ${BACKUP_LOG}"
fi

# ─── ВЫКАТКА ───────────────────────────────────────────────────────────────
say "rsync → ${SERVER_USER}@${SERVER_IP}:${TARGET_PATH}/ (--delete, .env исключён)"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
  ./ "${SERVER_USER}@${SERVER_IP}:${TARGET_PATH}/"

say "docker compose config --quiet (валидация без вывода секретов)"
ssh_ "cd '${TARGET_PATH}' && docker compose -f '${COMPOSE_FILE}' config --quiet" \
  || die "compose-конфиг невалиден"

say "docker compose up -d --build"
ssh_ "cd '${TARGET_PATH}' && docker compose -f '${COMPOSE_FILE}' up -d --build" 2>&1 | tail -12

# ─── ПРОВЕРКИ ПОСЛЕ ДЕПЛОЯ ────────────────────────────────────────────────
say "ждём готовности приложения…"
for i in $(seq 1 40); do
  code="$(ssh_ "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${APP_PORT}/login" || echo 000)"
  [ "$code" = "200" ] && { say "app готов (${i}×2s)"; break; }
  sleep 2
done

say "--- проверки на сервере (127.0.0.1:${APP_PORT}) ---"
ssh_ "curl -s -o /dev/null -w '  /login     %{http_code}\n' http://127.0.0.1:${APP_PORT}/login"
ssh_ "curl -s -o /dev/null -w '  /warehouse %{http_code} -> %{redirect_url}\n' http://127.0.0.1:${APP_PORT}/warehouse"
ssh_ "curl -s -o /dev/null -w '  /app       %{http_code} -> %{redirect_url}\n' http://127.0.0.1:${APP_PORT}/app"

say "--- проверки снаружи (${PUBLIC_URL}) ---"
curl -s -o /dev/null -w "  /login     %{http_code}\n" "${PUBLIC_URL}/login"
curl -s -o /dev/null -w "  /warehouse %{http_code} -> %{redirect_url}\n" "${PUBLIC_URL}/warehouse"
curl -s -o /dev/null -w "  /app       %{http_code} -> %{redirect_url}\n" "${PUBLIC_URL}/app"

say "--- статус контейнеров ---"
ssh_ "cd '${TARGET_PATH}' && docker compose -f '${COMPOSE_FILE}' ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'"

say "--- db наружу не опубликована? ---"
ssh_ "ss -tlnp 2>/dev/null | grep -q ':5432' && echo '  !!! 5432 ОПУБЛИКОВАН' || echo '  ок: 5432 на хосте не слушается'"

say "=== ГОТОВО: ${ENV_NAME} обновлён до ${LOCAL_SHA:0:7} → ${PUBLIC_URL}/warehouse ==="
say "ПОМНИ: откат кода не откатывает миграции Prisma. Если релиз содержал миграции —"
say "       откат схемы только через restore из бэкапа (docs/RESTORE.md)."
