# SkladyX · Склад

SaaS-платформа складского учёта. Первый модуль большого продукта (дальше — `/crm`,
`/finance`, `/admin` и т.д.). Мультитенантность заложена с первого дня: `companyId`
на всех доменных таблицах + `scoped()` (`src/lib/tenant.ts`), тенант = организация
(`Company.slug`). Схема URL: `<org-slug>.skladyx.ru/<module>` — первый рабочий адрес
**https://rostagro.skladyx.ru/warehouse** (организация `rostagro`, модуль `warehouse`).

> Независимая копия проекта «Стройка · Склад»: отдельный репозиторий, своя БД, свои
> volume и секреты, свой compose-проект `skladyx`. Со старым проектом ничего не
> разделяется.

> **Обязательный контекст (читать перед любой задачей):**
> [docs/ROSTAGRO_PRODUCT_SPEC.md](docs/ROSTAGRO_PRODUCT_SPEC.md) — утверждённое продуктовое
> поведение и источник истины · [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — архитектура,
> URL-схема, tenant/security-модель, принципы, prod · [ROADMAP.md](ROADMAP.md) — этапы развития.
>
> **Работа с живыми контурами:** [docs/OPERATIONS.md](docs/OPERATIONS.md) — правило
> «repo ≠ production», чеклисты, проверка портов, статусы бэкапов, forward-only миграции ·
> [docs/SERVER_INVENTORY.md](docs/SERVER_INVENTORY.md) — инвентарь по факту сервера.

## Стек

Next.js 15 (App Router, RSC, server actions) · React 19 · TypeScript · Tailwind 3.4 ·
PostgreSQL 16 · Prisma 6 · jose (JWT в httpOnly cookie, без NextAuth) · bcryptjs · zod ·
PWA + web-push (VAPID) · `barcode-detector` (сканер QR камерой, iOS/Android) ·
`qrcode` (генерация этикеток на сервере).

## Что умеет модуль «Склад» (/warehouse)

- **Мультироли и смены**: приёмщик, погрузчик, сборщик, контролёр, наблюдатель и администратор.
- **Общая очередь задач**: автоматическое назначение по активным сменам, приоритеты,
  зависимости, передача незавершённой работы.
- **Один физический склад РостАгро**: семь системных зон, уровни STORAGE и физические ячейки
  с QR/Code 128.
- **EAN-номенклатура**: заводские EAN-8/EAN-13; API-товары read-only; внешняя система не удаляет
  отсутствующие товары.
- **Приёмка групп/паллет**: EAN, количество, температура, маршрут по X, автоматическое назначение
  и резерв ячейки, подтверждение размещения сканом.
- **Охлаждение**: снимок X/R, расчёт срока, повторный замер и обязательный вывоз готовой группы.
- **Внешние заказы**: идемпотентный импорт, FIFO-резерв, перестановка с верхних уровней,
  сборка, полный контроль, исправление, зона выдачи и выдача.
- **Остатки, история и лента**: новая модель групп, зон, EAN, резервов заказов и бизнес-событий.
- **Integration API**: нейтральные endpoints товаров и заказов, tenant по host и токену организации.

Legacy-процессы старого проекта могут оставаться в схеме для обратимого отката, но при
`LEGACY_WAREHOUSE_UI_ENABLED=false` не входят в продукт РостАгро и закрыты на сервере.

## Архитектура (ключевые файлы)

- `prisma/schema.prisma` — вся доменная модель. Остатки: append-only `StockMovement` +
  материализованный `StockBalance` (партионные); у поштучных место/статус на `ItemUnit`.
- `src/lib/stock.ts` — **единственная точка изменения остатков** (`applyLotMovement`, `moveUnit`).
- `src/lib/tenant.ts` — `scoped(session)`: весь доступ к доменным данным по `companyId`.
- `src/lib/tenant-host.ts` — резолвинг org-slug; tenant-auth требует соответствия host и
  `session.companyId`, неизвестный host закрывается fail-closed.
- `src/lib/qr.ts` — внутренние QR приложения; в новом процессе товар определяется заводским EAN,
  ячейки — QR/Code 128, заказ — QR.
- `src/app/actions/*` — server actions: `requireAdmin()` → `scoped()` → zod → транзакция →
  `logEvent` → `revalidatePath`. Эталон проведения — `postReceiptAction`.
- `src/middleware.ts` — гейт `/warehouse/*` по сессии + legacy-редирект `/app/*` → `/warehouse/*`.

## Локальная разработка

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres на 127.0.0.1:5435
cp .env.example .env                              # заполнить AUTH_SECRET и т.д.
npm install
npx prisma migrate deploy                         # или prisma migrate dev
npm run db:seed                                   # организация rostagro + админ + единицы
npm run dev                                       # http://localhost:3000/warehouse
```

Проверка с телефона (камере нужен HTTPS): `npm run dev:https`, открыть
`https://<ip-мака>:3000` в той же Wi-Fi.

Интеграционные проверки (нужен запущенный dev-сервер и база):

```bash
VERIFY_PASSWORD=<пароль админа> node scripts/verify-http.mjs          # сквозной HTTP-прогон
npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-stock.ts  # ядро остатков
```

## Прод

Развёрнут и работает: **https://rostagro.skladyx.ru/warehouse**.

Сервер **sklad-prod-01** (104.171.136.35), путь `/opt/skladyx`, свой `docker-compose.yml`
(db без внешнего порта, app на `127.0.0.1:3003`).

- **DNS `rostagro.skladyx.ru` делегирован**, **HTTPS выпущен** (Let's Encrypt).
- **nginx-заглушка отключена**; nginx работает как **reverse proxy** → `127.0.0.1:3003`
  (с настройками под SSE `/api/realtime`: `proxy_buffering off`, длинные таймауты).
- `.env` на сервере — свои `DB_PASSWORD`, `AUTH_SECRET`, VAPID-ключи (не из других проектов).

**Выкатка — только через скрипт** (target зашит, есть guard-проверки и обязательный бэкап):
`DEPLOY_ENV=prod CONFIRM_PROD_DEPLOY=rostagro ./scripts/prod/deploy-prod.sh`.
Полная инструкция и запреты — [docs/DEPLOY.md](docs/DEPLOY.md). Миграции применяет entrypoint.

**Бэкапы** настроены отдельно (см. [docs/RESTORE.md](docs/RESTORE.md)): ежедневный cron
**03:20 UTC** (`/etc/cron.d/skladyx-backup`) снимает `pg_dump -Fc` в **`/opt/backups/postgres`**
и `tar.gz` тома uploads в **`/opt/backups/uploads`**, retention 14 дней.

## Staging

Тестовый контур первой организации РостАгро, полностью независим от prod (свой compose,
БД, volumes, порт, домен, секреты). **Правило: любое изменение сначала на staging → проверка
→ потом prod.** Данные staging — только seed (prod DB не копируется).

Работает: **https://staging-rostagro.skladyx.ru/warehouse** (HTTPS, Let's Encrypt).

| Параметр | Значение |
|---|---|
| путь | `/opt/skladyx-staging` |
| compose file | `docker-compose.staging.yml` (project `skladyx-staging`) |
| app port | `127.0.0.1:3013` (db без внешнего порта) |
| volumes | `skladyx_staging_db_data`, `skladyx_staging_uploads` |
| nginx | `/etc/nginx/sites-available/staging-rostagro.skladyx.ru` → proxy `127.0.0.1:3013` (SSE-friendly) |

**Выкатка staging — только через скрипт:** `./scripts/prod/deploy-staging.sh`
(см. [docs/DEPLOY.md](docs/DEPLOY.md)). Свой `/opt/skladyx-staging/.env`
(свои `DB_PASSWORD`/`AUTH_SECRET`/VAPID, не из prod). После первого seed — `SEED_ON_START=false`.

## Изоляция от старого проекта

| Ресурс | Значение |
|---|---|
| compose-проект (прод) | `skladyx` |
| compose-проект (dev) | `skladyx-dev` |
| БД / пользователь / контейнер | `skladyx` / `skladyx-dev-db` |
| volumes | `skladyx_db_data`, `skladyx_uploads`, `skladyx_dev_db` |
| порт приложения | `127.0.0.1:3003` |
| dev-порт Postgres | `127.0.0.1:5435` |
| cookie сессии | `skx_session` |

Секреты (`AUTH_SECRET`, VAPID, `DB_PASSWORD`) генерируются заново — старые не используются.
