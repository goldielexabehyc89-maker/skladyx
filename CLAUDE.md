# SkladyX · Склад — контекст для агента

> **Обязательный контекст для всех агентов — читать ПЕРВЫМ, перед любой задачей:**
> [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) (архитектура, tenant/security-модель, принципы,
> prod) и [ROADMAP.md](ROADMAP.md) (этапы). Если задача принимает новое архитектурное
> решение — предложить правку PROJECT_CONTEXT.md / ROADMAP.md отдельным пунктом, не менять их молча.

SaaS-платформа складского учёта. `warehouse` — первый модуль (дальше `/crm`, `/finance`,
`/admin`). Схема URL `<org-slug>.skladyx.ru/<module>`; первый адрес
`https://rostagro.skladyx.ru/warehouse` (организация `rostagro`). Независимая копия старого
проекта «Стройка · Склад» — со старым проектом ничего не разделяется. Архитектура и что где
лежит — в README.md.

## Ключевые инварианты кода (не нарушать)
- **Мультитенантность с первого дня**: `companyId` на всех доменных таблицах, весь доступ —
  через `scoped(session)` из `src/lib/tenant.ts`. Тенант = `session.companyId`.
- **`src/lib/tenant-host.ts` — НЕ security boundary** на этом этапе. Резолвинг org-slug из
  host — только точка расширения. Безопасность/изоляция держатся на `session.companyId`.
  Следующий этап: enforce `host org-slug == session company`.
- **Остатки меняются только через `src/lib/stock.ts`** (`applyLotMovement` / `moveUnit`) внутри
  транзакции документа. Никаких прямых правок `StockBalance`/`ItemUnit.status` в actions.
- Паттерн server action: `requireAdmin()`/`requireUser()` → `scoped()` → zod → транзакция →
  `logEvent` → `revalidatePath`. Эталон проведения документа — `postReceiptAction`.
- Рабочий модуль живёт под `/warehouse/*` (каталог `src/app/warehouse`). Старый `/app/*`
  редиректится на `/warehouse/*` в `src/middleware.ts` (совместимость QR/закладок).
- Роли: ADMIN (все складские операции) и EMPLOYEE (свои ТМЦ, подтверждения). Enum расширяемый.
- `public/sw.js` — НЕ добавлять fetch-хендлер (тормозит iOS PWA).
- UI на русском, мобайл-первый. Никаких заглушек и демо-данных.

## Правила работы с владельцем
- **Общение на русском.** Отвечай по делу, объясняй решения.
- Коммиты в git — только по команде владельца.
- Правки на сервере — только после подтверждения владельцем; каждое изменение additive
  и обратимое: бэкап → правка → configtest → рестарт.
- Бизнес-логику сотрудников и складские процессы на этапе выделения проекта НЕ менять.

## Git: commit & push после принятой задачи
Репозиторий приватный: `origin` → `github.com/goldielexabehyc89-maker/skladyx`, ветка `main`.

После того как владелец **принял** задачу:
- сделать `git commit` с понятным сообщением (что сделано и зачем);
- выполнить `git push` в `origin/main`;
- в отчёте прислать **commit hash** и подтверждение **push**.

**Никогда не коммитить и не пушить**: `.env` и любые секреты/токены, дампы БД (`*.dump`),
логи, содержимое `uploads/`, backup-архивы, `node_modules/`, `.next/`. За это отвечает
`.gitignore`, но всё равно проверяй `git status` перед коммитом.

Если задача **не принята** или есть сомнения — **не коммитить и не пушить** без отдельного
подтверждения владельца.

## Окружение этого мака
- Песочница агента без сети: `npm install`, `curl`, `docker`, `ssh`, `git push` — только с
  `dangerouslyDisableSandbox: true`. Билды/tsc работают и в песочнице.
- Локальный Postgres 5432, dev-база старого проекта — 5434, **dev-база этого проекта — 5435**
  (`docker compose -f docker-compose.dev.yml up -d`; docker требует `name:` — путь кириллический).
- Временные файлы — только в scratchpad агента.

## Проверка изменений
- `npm run typecheck && npm run build` — обязательный минимум.
- Сквозной HTTP-прогон (нужен dev-сервер + база): `VERIFY_PASSWORD=<пароль> node scripts/verify-http.mjs`.
- Ядро остатков: `npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-stock.ts`.
- Сканер/камера проверяются только по HTTPS (`npm run dev:https` + телефон в той же Wi-Fi,
  либо на проде). Push на iOS — только на установленной PWA на проде.

## Прод (планируется, ещё не развёрнут)
- Сервер **sklad-prod-01** (104.171.136.35), путь `/opt/skladyx`, свой compose `name: skladyx`,
  app на `127.0.0.1:3003`, db без внешнего порта. Reverse-proxy + SSL + DNS — **отдельным этапом**
  (сейчас не выпускаем сертификаты и не меняем DNS).
- `.env` на сервере — свои `DB_PASSWORD`, `AUTH_SECRET`, VAPID-ключи (не из других проектов).
- Деплой: rsync исходников (без `node_modules`/`.next`/`.env`) → `docker compose up -d --build app`;
  миграции применяет entrypoint. volumes `skladyx_db_data` / `skladyx_uploads`.

## Изоляция от старого проекта
compose `skladyx` · БД/пользователь `skladyx` · контейнеры `skladyx-dev-db` · volumes
`skladyx_db_data`/`skladyx_uploads`/`skladyx_dev_db` · порт app `127.0.0.1:3003` · dev-порт
Postgres `5435` · cookie сессии `skx_session` · секреты сгенерированы заново.
