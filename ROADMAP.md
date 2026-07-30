# SkladyX · Roadmap

## Этап 1. Независимая копия

Цель: отделить новый проект SkladyX от старого проекта «Стройка · Склад».

- Скопировать проект в независимую папку.
- Изолировать package/docker/env/session/db identifiers.
- Перевести рабочий складской модуль на /warehouse.
- Оставить legacy redirect /app -> /warehouse.
- Обновить verify-скрипты под /warehouse.
- Не менять бизнес-логику сотрудников на этом этапе.

## Этап 2. Первый prod-деплой — ✅ Выполнено (2026-07-15)

Цель: поднять первый рабочий контур РостАгро.

- [x] Деплой в /opt/skladyx.
- [x] Домен: rostagro.skladyx.ru.
- [x] Рабочий URL: https://rostagro.skladyx.ru/warehouse.
- [x] Nginx reverse proxy на app container (127.0.0.1:3003, заглушка отключена).
- [x] PostgreSQL внутри docker compose без внешнего порта.
- [x] Проверены login, warehouse, основные складские сценарии (login-smoke + внешние curl).

## Этап 3. Бэкапы и восстановление — ✅ Выполнено (2026-07-15)

Цель: сделать проект безопасным для эксплуатации.

- [x] Автобэкап PostgreSQL (`pg_dump -Fc`, cron 03:20 UTC → `/opt/backups/postgres`).
- [x] Бэкап uploads (`tar.gz` тома → `/opt/backups/uploads`).
- [x] Проверка restore на отдельной базе/контуре (temp-контейнер: 35 таблиц, Company, 14 миграций).
- [x] Документ восстановления — `docs/RESTORE.md`.
- [x] Retention policy — 14 дней.

Будущий hardening (не блокер этапа): off-site копия бэкапов (вынос в S3 / на другой хост)
и алерты при ошибке бэкапа.

## Этап 4. Multi-tenant security

Цель: подготовить проект к нескольким организациям.

- [x] 4A. Проект — docs/MULTITENANT_SECURITY_DESIGN.md: per-tenant User, независимые учётные
      записи организаций, UserRole, вход через поддомен, host→company, немедленный отзыв прав,
      приглашения и security-аудит. Выполнено 2026-07-30.
- [ ] 4B. Реализация малыми этапами S1–S6 (весь 4B ещё не завершён; авторизация до S2
      остаётся на User.role):
  - [x] S1. UserRole + backfill + dual-write ролей — выполнено 2026-07-30. Миграция
        `20260730130000_user_role_s1`, коммит `ce42b39`. Проверено локально, на staging и на prod.
        Авторизация пока по `User.role` (dual-read ролей — в S2).
  - [ ] S2. Dual-read ролей.
  - [ ] S3. Tenant-auth, host→company и tenant-scoped уникальность phone/email.
  - [ ] S4. Приглашения, восстановление и аудит.
  - [ ] S5. Tenant-security тесты.
  - [ ] S6. Cleanup User.role.

Внутри 4B решаются: enforce host org == session company; проверка scoped-запросов; отсутствие
хардкода rostagro; роли и складские доступы в каждой организации; защита последнего администратора.

## Staging-контур — ✅ Выполнено (2026-07-21)

- staging-rostagro.skladyx.ru/warehouse
- отдельный compose/project/path/port
- отдельные БД/volumes/секреты
- HTTPS/nginx proxy
- workflow код → staging → prod

## Проектная база Этапа 5 (аудит + миграция) — ✅ Выполнено (2026-07-30)

- docs/ROSTAGRO_WORKFLOW_AUDIT.md — карта кода vs целевая логика РостАгро
- docs/ROSTAGRO_MIGRATION_DESIGN.md — целевая модель, варианты, state machines, этапы
- Реализация ролей/смен заблокирована шлюзом Этапа 4 (multi-tenant security)

## Этап 5. Новая логика сотрудников

Цель: адаптировать складскую логику под новую организацию.

- Пересмотреть роли сотрудников.
- Пересмотреть выдачи/заявки/подтверждения.
- Согласовать новые сценарии до разработки.
- Вносить изменения только после отдельного ТЗ.

## Этап 6. Новые модули

Цель: расширять SkladyX за пределы склада.

Потенциальные модули:

- /crm
- /finance
- /projects
- /reports
- /settings

Каждый модуль должен учитывать URL-схему:

<org-slug>.skladyx.ru/<module>

## Правило для будущих задач

Перед каждой новой задачей агент должен читать PROJECT_CONTEXT.md и ROADMAP.md.

Если задача создаёт новое архитектурное решение, агент должен предложить изменение PROJECT_CONTEXT.md или ROADMAP.md отдельным пунктом, а не менять их молча.
