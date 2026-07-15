# SkladyX · Восстановление из бэкапа (prod)

> ⚠️ **Restore на prod перезаписывает данные.** Выполнять только осознанно и
> **после отдельного подтверждения владельца**. Сначала всегда снять свежий бэкап
> текущего состояния (вдруг откат понадобится).

Сервер: **sklad-prod-01** (104.171.136.35) · путь проекта `/opt/skladyx` ·
compose-проект `skladyx` (сервисы `app`, `db`).

---

## 1. Где лежат бэкапы

Архивы (вне git и вне rsync деплоя — не перетираются выкаткой):

| Что | Путь |
|---|---|
| PostgreSQL (custom `-Fc`) | `/opt/backups/postgres/skladyx-postgres-YYYYmmdd-HHMMSS.dump` |
| uploads (`tar.gz`)        | `/opt/backups/uploads/skladyx-uploads-YYYYmmdd-HHMMSS.tar.gz` |
| Лог бэкапов               | `/opt/backups/backup.log` |

Скрипты бэкапа (в git, деплоятся вместе с проектом):
`/opt/skladyx/scripts/prod/backup-{postgres,uploads,all}.sh`.
Автозапуск: `/etc/cron.d/skladyx-backup` (ежедневно 03:20 по времени сервера).
Retention: 14 дней.

## 2. Посмотреть список бэкапов

```bash
ls -lh /opt/backups/postgres
ls -lh /opt/backups/uploads
tail -100 /opt/backups/backup.log
```

Выбрать нужный файл (обычно самый свежий по timestamp в имени).

## 3. Восстановление PostgreSQL

Дампы в формате **custom (`-Fc`)** — восстанавливаются `pg_restore`.

### 3.1 Проверить дамп перед restore (безопасно, ничего не меняет)

```bash
DUMP=/opt/backups/postgres/skladyx-postgres-YYYYmmdd-HHMMSS.dump
cd /opt/skladyx
docker compose exec -T db pg_restore --list < "$DUMP" | head -40
```

Если выводится оглавление (TOC) без ошибок — дамп валиден.

### 3.2 Restore поверх prod БД (ПЕРЕЗАПИСЬ! только после подтверждения)

```bash
DUMP=/opt/backups/postgres/skladyx-postgres-YYYYmmdd-HHMMSS.dump
cd /opt/skladyx

# 0) СНАЧАЛА свежий бэкап текущего состояния — на случай отката:
./scripts/prod/backup-postgres.sh

# 1) (рекомендуется) остановить app, чтобы никто не писал в БД во время restore:
docker compose stop app

# 2) restore с очисткой существующих объектов (--clean --if-exists):
docker compose exec -T db pg_restore -U skladyx -d skladyx --clean --if-exists --no-owner < "$DUMP"

# 3) поднять app обратно:
docker compose up -d app
```

Примечания:
- `--clean --if-exists` удаляет и пересоздаёт объекты из дампа; данные, которых нет
  в дампе, будут потеряны — это полное восстановление на момент бэкапа.
- Схему создаёт сам дамп; отдельный `prisma migrate deploy` не нужен (но при желании
  можно свериться: `docker compose exec -T app npx prisma migrate status`).

### 3.3 Полная переинициализация БД (если том БД повреждён)

```bash
cd /opt/skladyx
docker compose down                 # НЕ добавлять -v! это удалит тома с данными
docker volume rm skladyx_skladyx_db_data   # только если том действительно нужно пересоздать
docker compose up -d db
# дождаться healthy, затем restore как в 3.2 (шаг 2)
```

## 4. Восстановление uploads

Архив `tar.gz` содержит содержимое тома `skladyx_skladyx_uploads` (монтируется в app как `/data/uploads`).

```bash
ARCH=/opt/backups/uploads/skladyx-uploads-YYYYmmdd-HHMMSS.tar.gz

# распаковать архив обратно в том (перезапись текущего содержимого):
docker run --rm \
  -v skladyx_skladyx_uploads:/data \
  -v /opt/backups/uploads:/backup:ro \
  postgres:16-alpine \
  sh -c 'cd /data && tar xzf /backup/'"$(basename "$ARCH")"

# перезапускать app не обязательно — файлы читаются с тома напрямую.
```

Если нужно предварительно очистить том:
`docker run --rm -v skladyx_skladyx_uploads:/data postgres:16-alpine sh -c 'rm -rf /data/*'`
(осторожно — удаляет текущие файлы).

## 5. Проверка после восстановления

```bash
cd /opt/skladyx
docker compose ps                      # app/db up, db healthy

# данные в БД читаются:
docker compose exec -T db psql -U skladyx -d skladyx -tA -c \
  'select count(*) from "Company"; select count(*) from "User"; select count(*) from "Item";'

# приложение отвечает:
curl -I http://127.0.0.1:3003/warehouse         # 307 -> /login
curl -I https://rostagro.skladyx.ru/login       # 200
```

Дополнительно: войти в UI под админом и открыть `/warehouse` — разделы должны грузиться.

## 6. Проверка валидности дампа без риска (temp-контейнер)

Так проверяют бэкап, не трогая prod. Поднимается отдельный временный postgres,
дамп восстанавливается туда, затем контейнер удаляется:

```bash
DUMP=/opt/backups/postgres/skladyx-postgres-YYYYmmdd-HHMMSS.dump
docker run -d --name skladyx-restore-test \
  -e POSTGRES_USER=skladyx -e POSTGRES_DB=skladyx -e POSTGRES_PASSWORD=temp \
  postgres:16-alpine
sleep 6
docker exec -i skladyx-restore-test pg_restore -U skladyx -d skladyx --no-owner < "$DUMP"
docker exec -i skladyx-restore-test psql -U skladyx -d skladyx -tA -c \
  'select count(*) from "Company";'
docker rm -f skladyx-restore-test        # удалить временный контейнер (том анонимный, уйдёт с ним)
```
