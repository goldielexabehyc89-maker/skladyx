# SkladyX · Инвентарь сервера

> ⚠️ **Это снимок, а не источник истины.** Источник истины — сам сервер.
> Документ может устареть в любой момент. Перед тем как на него опираться —
> перепроверь командами из раздела «Как перепроверить».
>
> **Снимок снят:** 2026-07-23 · **сверено с коммитом:** `9cdeacb` ·
> **метод:** read-only команды на sklad-prod-01 (см. ниже).

Правила эксплуатации — [OPERATIONS.md](OPERATIONS.md) · деплой — [DEPLOY.md](DEPLOY.md) ·
восстановление — [RESTORE.md](RESTORE.md).

---

## Проект

| Поле | Значение |
|---|---|
| project | **SkladyX** (SaaS-платформа складского учёта, модуль `warehouse`) |
| repo | `github.com/goldielexabehyc89-maker/skladyx` (private), ветка `main` |
| сервер | **sklad-prod-01**, 104.171.136.35, Ubuntu 24.04 |
| domains | `rostagro.skladyx.ru` (prod), `staging-rostagro.skladyx.ru` (staging) |
| DNS | wildcard `*.skladyx.ru` → 104.171.136.35 |

## Контуры

| Параметр | **prod** | **staging** |
|---|---|---|
| URL | https://rostagro.skladyx.ru/warehouse | https://staging-rostagro.skladyx.ru/warehouse |
| path | `/opt/skladyx` | `/opt/skladyx-staging` |
| compose file | `docker-compose.yml` | `docker-compose.staging.yml` |
| compose project | `skladyx` | `skladyx-staging` |
| app port | `127.0.0.1:3003` → container `3000` | `127.0.0.1:3013` → container `3000` |
| db port | не публикуется (только внутри сети) | не публикуется (только внутри сети) |
| контейнеры | `skladyx-app-1`, `skladyx-db-1` | `skladyx-staging-app-1`, `skladyx-staging-db-1` |
| docker network | `skladyx_default` | `skladyx-staging_default` |
| volumes | `skladyx_skladyx_db_data`, `skladyx_skladyx_uploads` | `skladyx_staging_db_data`, `skladyx_staging_uploads` |
| nginx site | `rostagro.skladyx.ru` | `staging-rostagro.skladyx.ru` |
| TLS (Let's Encrypt) | до 2026-10-13 | до 2026-10-19 |
| `.env` | `/opt/skladyx/.env` (root, `600`) | `/opt/skladyx-staging/.env` (root, `600`) |
| данные | боевые | только seed (prod DB не копируется) |
| `SEED_ON_START` | `false` | `false` |

Секреты (`DB_PASSWORD`, `AUTH_SECRET`, VAPID) у контуров **разные**, в git не хранятся.

## Бэкапы

| Поле | Значение |
|---|---|
| PostgreSQL | `/opt/backups/postgres/skladyx-postgres-YYYYmmdd-HHMMSS.dump` (`pg_dump -Fc`) |
| uploads | `/opt/backups/uploads/skladyx-uploads-YYYYmmdd-HHMMSS.tar.gz` |
| лог | `/opt/backups/backup.log` |
| скрипты | `/opt/skladyx/scripts/prod/backup-{postgres,uploads,all}.sh` (из git) |
| расписание | `/etc/cron.d/skladyx-backup` — ежедневно **03:20 UTC** |
| retention | 14 дней |
| охват | **только prod.** У staging автобэкапа нет (данные — seed) |
| offsite | **нет** — копии только на этом сервере |

Состояние на 2026-07-23: 9 дампов (по 80K), свежий `2026-07-23 03:20`, лог `DONE OK`.
Архивы uploads по 87 байт — том uploads пока пуст (файлов в проде ещё не загружали).

Расшифровка статусов бэкапа — [OPERATIONS.md](OPERATIONS.md), раздел 7.

## Cron / systemd, относящиеся к SkladyX

| Задача | Где | Что делает |
|---|---|---|
| `skladyx-backup` | `/etc/cron.d/skladyx-backup` | 03:20 UTC → `backup-all.sh`, лог в `/opt/backups/backup.log` |

**Больше ничего** в cron/systemd к SkladyX не относится. `crontab -l` у root пуст.

## Известный источник кода на проде

**Коммит, задеплоенный на контур, не отслеживается:** на сервере нет `.git`, и deploy-скрипты
не пишут маркер версии. Определить «версию прода» по метке нельзя — только сравнением файлов.

Состояние на момент снимка (сверка с `9cdeacb`):

| Контур | Результат сверки |
|---|---|
| staging | 184/184 файла совпадают → идентичен `9cdeacb` |
| prod | 5 файлов отсутствуют, 4 отличаются (**только документация и ops-тулинг**) |

Отсутствовали на prod: `docker-compose.staging.yml`, `docs/DEPLOY.md`, `docs/RESTORE.md`,
`scripts/prod/deploy-prod.sh`, `scripts/prod/deploy-staging.sh`.
Отличались: `CLAUDE.md`, `PROJECT_CONTEXT.md`, `README.md`, `ROADMAP.md`.

**Код приложения** (`src/`, `prisma/`, `package.json`, `Dockerfile`) на prod **совпадал** с
`9cdeacb` — расхождения рантайма нет. Причина: после последней prod-выкатки выкатывался
только staging.

Команда сверки — [OPERATIONS.md](OPERATIONS.md), раздел 1.

> Примечание: сами файлы `OPERATIONS.md` и `SERVER_INVENTORY.md` добавлены **после** снимка,
> поэтому до следующей выкатки они будут числиться «отсутствующими» на обоих контурах.
> Это ожидаемо: документация попадает на сервер только с очередным деплоем.

---

## Что НЕ относится к SkladyX

Присутствует на сервере, но **проектом не управляется**. Не описывать как «наше»,
не чинить и не удалять без выяснения владельца.

| Сущность | Что это |
|---|---|
| `zabbix_agentd` на `0.0.0.0:10050` | агент мониторинга (инфраструктура хостера) |
| `sshd` на `:22` | доступ по SSH |
| `systemd-resolve` на `127.0.0.53:53`, `127.0.0.54:53` | DNS-резолвер ОС |
| `containerd` на `127.0.0.1:39471` | внутренний сокет Docker |
| `nginx` на `:80`/`:443` | общий веб-вход сервера (обслуживает наши сайты, но сам — системный) |
| `certbot.timer`, `/etc/cron.d/certbot` | автопродление сертификатов (системное, не наш скрипт) |
| `/etc/cron.d/{sysstat,e2scrub_all}` | штатные задачи ОС |
| таймеры `apt-daily*`, `logrotate`, `man-db`, `motd-news`, `dpkg-db-backup`, `update-notifier*`, `systemd-tmpfiles-clean` | штатные таймеры Ubuntu |
| `/opt/sklad` | **пустой** каталог, происхождение неизвестно; нашим деплоем не используется |
| `/etc/nginx/sites-available/default` | дефолтный сайт nginx — **не включён** (нет симлинка) |
| `/etc/nginx/sites-available/rostagro.skladyx.ru.bak.*` | бэкап конфига от переключения на reverse proxy — **не включён**, лежит для отката |

## Не проверено / вне охвата снимка

- содержимое `.env` (намеренно — секреты);
- состояние БД внутри контейнеров (кроме факта `healthy`);
- политики firewall/провайдера вне `ss -tulpn`;
- принадлежность и назначение `/opt/sklad`;
- наличие/настройки внешнего мониторинга на стороне Zabbix-сервера.

---

## Как перепроверить (read-only)

**[на сервере]** — ничего не меняют:

```bash
docker compose ls -a                      # compose-проекты и их файлы
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker volume ls
docker network ls
ss -tulpn                                 # все порты (см. OPERATIONS.md §3)
ls -la /etc/nginx/sites-enabled/          # какие сайты реально включены
grep -E 'server_name|proxy_pass' /etc/nginx/sites-available/rostagro.skladyx.ru
certbot certificates                      # сроки TLS
ls -la /etc/cron.d/; crontab -l           # кроны
systemctl list-timers --all               # таймеры
ls -lht /opt/backups/postgres | head -3   # свежесть бэкапа
tail -20 /opt/backups/backup.log
```

**[локально на Mac]** — сверка файлов контура с текущим HEAD: см.
[OPERATIONS.md](OPERATIONS.md), раздел 1.

Если факты разошлись с этим документом — **прав сервер**. Обнови снимок и поставь новую дату.
