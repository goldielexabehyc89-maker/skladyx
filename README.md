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
> [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — архитектура, URL-схема, tenant/security-модель,
> принципы, prod · [ROADMAP.md](ROADMAP.md) — этапы развития.

## Стек

Next.js 15 (App Router, RSC, server actions) · React 19 · TypeScript · Tailwind 3.4 ·
PostgreSQL 16 · Prisma 6 · jose (JWT в httpOnly cookie, без NextAuth) · bcryptjs · zod ·
PWA + web-push (VAPID) · `barcode-detector` (сканер QR камерой, iOS/Android) ·
`qrcode` (генерация этикеток на сервере).

## Что умеет модуль «Склад» (/warehouse)

- **Склады и ячейки** (адресное хранение): bulk-создание ячеек, QR на каждую ячейку.
- **Номенклатура**: партионный учёт (QR на партию) и поштучный (QR на каждую единицу),
  единицы измерения с дробными количествами.
- **Заказы поставщикам** (таблица): справочник поставщиков, «Принять на склад» создаёт
  проведённую приёмку, id позиций становятся QR-кодами партий/единиц.
- **Приёмки**: позиции с закупочной ценой, файлы (сертификаты/накладные), проведение
  создаёт партии/единицы + QR + движения; печать этикеток (термо 58×40 или А4-сетка).
- **Сканирование** телефоном (PWA): карточка по QR, «скан товара → скан ячейки»; QR
  ведёт на `/q/<код>` — работает и системной камерой.
- **Остатки**: склад → ячейка → партия/единица, «за сотрудником», стоимость по закупке.
- **Перемещения**, **списания**, **выдачи сотрудникам** (прямая и по заявкам на сбор),
  **инвентаризация**, **лента** операций, push-уведомления, PWA-установка.

## Архитектура (ключевые файлы)

- `prisma/schema.prisma` — вся доменная модель. Остатки: append-only `StockMovement` +
  материализованный `StockBalance` (партионные); у поштучных место/статус на `ItemUnit`.
- `src/lib/stock.ts` — **единственная точка изменения остатков** (`applyLotMovement`, `moveUnit`).
- `src/lib/tenant.ts` — `scoped(session)`: весь доступ к доменным данным по `companyId`.
- `src/lib/tenant-host.ts` — резолвинг org-slug из host (**точка расширения; на этом
  этапе НЕ security boundary** — изоляция держится на `session.companyId`).
- `src/lib/qr.ts` — таблица `QrCode` (LOT/UNIT/CELL/EMPLOYEE/PICKLIST), URL `/q/<код>`.
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

Сервер **sklad-prod-01** (104.171.136.35), путь `/opt/skladyx`, свой `docker-compose.yml`
(db без внешнего порта, app на `127.0.0.1:3003`). Целевой URL: `https://rostagro.skladyx.ru/warehouse`.

Инфраструктура домена уже готова:
- **DNS `rostagro.skladyx.ru` делегирован** и указывает на сервёр.
- **HTTPS-сертификат уже выпущен** (Let's Encrypt).
- Сейчас на домене стоит **nginx-заглушка** — приложение ещё не подключено к reverse-proxy.

Осталось для запуска: развернуть compose-стек в `/opt/skladyx`, переключить nginx с заглушки
на `proxy_pass` → `127.0.0.1:3003`, проверить login/warehouse. `.env` на сервере — свои
`DB_PASSWORD`, `AUTH_SECRET`, VAPID-ключи (не из других проектов).

Выкатка: rsync исходников (без `node_modules`/`.next`/`.env`) → `docker compose up -d --build app`;
миграции применяет entrypoint. Первичный seed — однократно `SEED_ON_START=true` с
`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. Бэкапы: `pg_dump` из контейнера db + tar volume
`skladyx_uploads`.

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
