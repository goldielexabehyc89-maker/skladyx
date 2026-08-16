#!/bin/sh
set -e

# R1/TENANT-001: на развёрнутом контуре (APP_URL=https://…) tenant-авторизация обязательна.
# Fail-fast ДО миграций/старта: не поднимаем приложение без изоляции организаций. Маркер https-APP_URL
# безопасен для CI/локали (там APP_URL=http://localhost).
case "$APP_URL" in
  https://*)
    if [ "$TENANT_AUTH" != "true" ]; then
      echo "FATAL: TENANT_AUTH=true обязателен на развёрнутом контуре (APP_URL=$APP_URL). Старт остановлен." >&2
      exit 1
    fi
    ;;
esac

echo "→ Применяю миграции БД (prisma migrate deploy)…"
npx prisma migrate deploy

if [ "${SEED_ON_START}" = "true" ]; then
  echo "→ SEED_ON_START=true — первичный seed (компания, админ, единицы измерения)…"
  npx tsx prisma/seed.ts || echo "seed пропущен/не удался (не критично)"
fi

echo "→ Запускаю Next.js…"
exec npm run start -- -p 3000 -H 0.0.0.0
