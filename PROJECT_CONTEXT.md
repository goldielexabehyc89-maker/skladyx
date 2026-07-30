# SkladyX · Project Context

SkladyX — SaaS-платформа для разных организаций.

## URL-архитектура

Основная схема:

<org-slug>.skladyx.ru/<module>

Примеры:

rostagro.skladyx.ru/warehouse
rostagro.skladyx.ru/crm
demo.skladyx.ru/warehouse

## Первая организация

slug: rostagro  
display name: РостАгро

## Первый модуль

warehouse — складской модуль, перенесён из проекта «Стройка · Склад».

## Принципы

- Старый проект building.roseone.ru не трогать.
- Новый проект должен быть независимым.
- Все данные должны быть привязаны к companyId.
- Host/subdomain пока используется как подготовка к multi-tenant логике.
- Security boundary сейчас: session.companyId + scoped-запросы.
- Утверждённая модель идентичности (Этап 4, проект — docs/MULTITENANT_SECURITY_DESIGN.md):
  per-tenant identity на существующем User. Один User принадлежит одной организации; одинаковый
  телефон/email в разных организациях означает независимые учётные записи. Мультироли хранятся
  в UserRole, доступ к складам — через allWarehouses + UserWarehouse. Вход выполняется через
  поддомен организации; host должен соответствовать session.companyId; активность и права
  проверяются по БД на каждом защищённом запросе для немедленного отзыва доступа.
- Multi-tenant security S1–S3 включена на staging и prod: host→company, tenant-scoped
  phone/email, роли UserRole и свежая авторизация из БД. Флаги `TENANT_AUTH=true` и
  `ROLES_DUAL_READ=true`. S4 и S6 отложены и не блокируют реализацию складской логики РостАгро.
- Не хардкодить РостАгро как единственную организацию.
- Не хардкодить warehouse как единственный будущий раздел.
- Новые разделы должны жить как модули: /warehouse, /crm, /finance и т.д.
- Бренд продукта: SkladyX.
- Название организации показывать из Company, а не из кода.

## Prod

Server: sklad-prod-01  
IP: 104.171.136.35  
Path: /opt/skladyx  
Первый домен: rostagro.skladyx.ru

Бэкапы: cron 03:20 UTC, /opt/backups/{postgres,uploads}, retention 14 дней, восстановление описано в docs/RESTORE.md.

Контуры: prod (rostagro.skladyx.ru, /opt/skladyx, 127.0.0.1:3003) и staging (staging-rostagro.skladyx.ru, /opt/skladyx-staging, 127.0.0.1:3013), отдельные БД/volumes/.env/секреты.
Правило: изменения идут код → staging → prod.
Staging-домен staging-<org>.skladyx.ru используется как технический контур и не меняет SaaS-схему <org-slug>.skladyx.ru/<module>.
Деплой — только через скрипты scripts/prod/deploy-staging.sh и deploy-prod.sh, инструкция и запреты в docs/DEPLOY.md.
Эксплуатационные правила и сверка repo↔сервер: docs/OPERATIONS.md; инвентарь контуров: docs/SERVER_INVENTORY.md.
Проект перехода к логике РостАгро: docs/ROSTAGRO_WORKFLOW_AUDIT.md и docs/ROSTAGRO_MIGRATION_DESIGN.md (только проект, реализация — по этапам после отдельных решений).

## Проверка каждого изменения

Перед принятием изменений проверять:

1. Не сломана ли multi-tenant модель.
2. Нет ли хардкода конкретной организации.
3. Все запросы к данным scoped по companyId.
4. Старый проект/прод не затронут.
5. /warehouse работает как модуль, а не как единственная app.
6. Есть путь масштабирования на другие модули и организации.

## Как обновлять этот файл

Обновлять PROJECT_CONTEXT.md только при архитектурных решениях:

- новая организация;
- новый модуль;
- изменение URL-схемы;
- изменение tenant/security модели;
- изменение сервера, домена или prod-пути;
- важное решение по ролям, правам, данным, бэкапам или интеграциям.

Не добавлять сюда обычные UI-задачи, багфиксы и мелкие изменения.
