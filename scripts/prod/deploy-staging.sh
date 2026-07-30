#!/usr/bin/env bash
# SkladyX · деплой на STAGING. Запускать ЛОКАЛЬНО (с мака), из корня репозитория.
#
# Target зашит жёстко и НЕ параметризуется — это защита от выкатки не в тот контур.
# Скрипт сам ходит на сервер по ssh. Секретов не содержит и .env не трогает
# (.env в exclude-списке rsync).
#
# Использование:
#   ./scripts/prod/deploy-staging.sh
set -euo pipefail

# ─── ЗАШИТЫЙ TARGET (staging) ───────────────────────────────────────────────
ENV_NAME="staging"
TARGET_PATH="/opt/skladyx-staging"
COMPOSE_FILE="docker-compose.staging.yml"
APP_PORT="3013"
PUBLIC_URL="https://staging-rostagro.skladyx.ru"
EXPECTED_APP_URL="https://staging-rostagro.skladyx.ru"   # маркер контура в целевом .env
# Host для локальных curl (иначе при TENANT_AUTH=true запрос без нужного Host отклоняется).
HOST_HEADER="${EXPECTED_APP_URL#https://}"
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
  code="$(ssh_ "curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${HOST_HEADER}' http://127.0.0.1:${APP_PORT}/login" || echo 000)"
  [ "$code" = "200" ] && { say "app готов (${i}×2s)"; break; }
  sleep 2
done

say "--- проверки на сервере (127.0.0.1:${APP_PORT}, Host: ${HOST_HEADER}) ---"
ssh_ "curl -s -o /dev/null -w '  /login     %{http_code}\n' -H 'Host: ${HOST_HEADER}' http://127.0.0.1:${APP_PORT}/login"
ssh_ "curl -s -o /dev/null -w '  /warehouse %{http_code} -> %{redirect_url}\n' -H 'Host: ${HOST_HEADER}' http://127.0.0.1:${APP_PORT}/warehouse"
ssh_ "curl -s -o /dev/null -w '  /app       %{http_code} -> %{redirect_url}\n' -H 'Host: ${HOST_HEADER}' http://127.0.0.1:${APP_PORT}/app"

say "--- проверки снаружи (${PUBLIC_URL}) ---"
curl -s -o /dev/null -w "  /login     %{http_code}\n" "${PUBLIC_URL}/login"
curl -s -o /dev/null -w "  /warehouse %{http_code} -> %{redirect_url}\n" "${PUBLIC_URL}/warehouse"
curl -s -o /dev/null -w "  /app       %{http_code} -> %{redirect_url}\n" "${PUBLIC_URL}/app"

say "--- статус контейнеров ---"
ssh_ "cd '${TARGET_PATH}' && docker compose -f '${COMPOSE_FILE}' ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'"

say "--- db наружу не опубликована? ---"
ssh_ "ss -tlnp 2>/dev/null | grep -q ':5432' && echo '  !!! 5432 ОПУБЛИКОВАН' || echo '  ок: 5432 на хосте не слушается'"

say "=== ГОТОВО: ${ENV_NAME} обновлён до ${LOCAL_SHA:0:7} → ${PUBLIC_URL}/warehouse ==="
