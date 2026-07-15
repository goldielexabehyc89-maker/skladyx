#!/bin/sh
set -e

echo "→ Применяю миграции БД (prisma migrate deploy)…"
npx prisma migrate deploy

if [ "${SEED_ON_START}" = "true" ]; then
  echo "→ SEED_ON_START=true — первичный seed (компания, админ, единицы измерения)…"
  npx tsx prisma/seed.ts || echo "seed пропущен/не удался (не критично)"
fi

echo "→ Запускаю Next.js…"
exec npm run start -- -p 3000 -H 0.0.0.0
