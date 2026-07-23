# SkladyX · Деплой (staging / prod)

Цель документа — **исключить случайный деплой не в тот контур**.

> **Самый безопасный способ — не выкатывать руками, а запускать готовые скрипты:**
> `scripts/prod/deploy-staging.sh` и `scripts/prod/deploy-prod.sh`.
> В них target (путь, compose-файл, порт, домен) **зашит жёстко** и не параметризуется,
> а перед выкаткой отрабатывают guard-проверки. Ручные команды ниже приведены
> для понимания и на случай разбора инцидента.

Все команды помечены: **[локально на Mac]** или **[на сервере]**.
rsync запускается **локально** (сам ходит по ssh), `docker compose` — **на сервере**.

> Перед выкаткой прочитай [OPERATIONS.md](OPERATIONS.md): репозиторий **не** является
> источником истины о продакшене, состояние контура проверяется на сервере.
> Фактический инвентарь (пути, порты, тома, кроны) — [SERVER_INVENTORY.md](SERVER_INVENTORY.md).

---

## 1. Deploy Targets

### Staging
| Параметр | Значение |
|---|---|
| URL | https://staging-rostagro.skladyx.ru/warehouse |
| path | `/opt/skladyx-staging` |
| compose file | `docker-compose.staging.yml` |
| compose project | `skladyx-staging` |
| app port | `127.0.0.1:3013` |
| volumes | `skladyx_staging_db_data`, `skladyx_staging_uploads` |

### Prod
| Параметр | Значение |
|---|---|
| URL | https://rostagro.skladyx.ru/warehouse |
| path | `/opt/skladyx` |
| compose file | `docker-compose.yml` |
| compose project | `skladyx` |
| app port | `127.0.0.1:3003` |
| volumes | `skladyx_skladyx_db_data`, `skladyx_skladyx_uploads` |

Сервер обоих контуров: **sklad-prod-01** (104.171.136.35).

### Как скрипт понимает, что каталог — «тот самый»
Проверяется **`APP_URL` в `.env` целевого каталога** (prod → `https://rostagro.skladyx.ru`,
staging → `https://staging-rostagro.skladyx.ru`). Если не совпало — деплой отменяется.

⚠️ **Наличие compose-файла контуры НЕ различает**: `docker-compose.yml` и
`docker-compose.staging.yml` лежат в git и потому попадают в **оба** каталога.
Ориентироваться на имя файла как на признак контура нельзя.

## 2. Главное правило

```
код → commit/push → deploy staging → проверка → только потом deploy prod
```

**Prod-деплой разрешён только после явной команды владельца: «выкатывай на prod».**
Скрипт `deploy-prod.sh` дополнительно требует двух переменных окружения
(`DEPLOY_ENV=prod`, `CONFIRM_PROD_DEPLOY=rostagro`) — случайно запустить нельзя.

## 3. Staging deploy

**[локально на Mac]** из корня репозитория:

```bash
./scripts/prod/deploy-staging.sh
```

Скрипт последовательно: проверяет guard'ы → `rsync --delete` в `/opt/skladyx-staging`
→ `docker compose -f docker-compose.staging.yml config --quiet` → `up -d --build`
→ curl-проверки локально и снаружи → `docker compose ps`.

<details>
<summary>Эквивалент вручную (если очень нужно)</summary>

**[локально на Mac]**
```bash
rsync -az --delete \
  -e "ssh -i ~/.ssh/sklad_prod_ed25519 -o IdentitiesOnly=yes" \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.env' \
  --exclude 'uploads' --exclude 'backups' --exclude 'logs' \
  --exclude '*.tsbuildinfo' --exclude '.DS_Store' \
  ./ root@104.171.136.35:/opt/skladyx-staging/
```

**[на сервере]**
```bash
cd /opt/skladyx-staging
docker compose -f docker-compose.staging.yml config --quiet
docker compose -f docker-compose.staging.yml up -d --build
curl -I http://127.0.0.1:3013/login
curl -I http://127.0.0.1:3013/warehouse
```
</details>

## 4. Prod deploy

Перед prod обязательно:
- рабочее дерево чистое (`git status`);
- ветка `main`, и `main == origin/main`;
- **staging уже выкачен и проверен**;
- свежий бэкап (скрипт снимает его сам и останавливается, если бэкап упал);
- получена явная команда владельца.

**[локально на Mac]** из корня репозитория:

```bash
DEPLOY_ENV=prod CONFIRM_PROD_DEPLOY=rostagro ./scripts/prod/deploy-prod.sh
```

Скрипт: проверяет подтверждение и guard'ы → **снимает бэкап**
`/opt/skladyx/scripts/prod/backup-all.sh` (упал → деплой остановлен) →
`rsync --delete` в `/opt/skladyx` → `docker compose config --quiet` →
`up -d --build` → curl-проверки → `docker compose ps`.

<details>
<summary>Эквивалент вручную (если очень нужно)</summary>

**[на сервере]** — сначала бэкап:
```bash
/opt/skladyx/scripts/prod/backup-all.sh >> /opt/backups/backup.log 2>&1
```

**[локально на Mac]**
```bash
rsync -az --delete \
  -e "ssh -i ~/.ssh/sklad_prod_ed25519 -o IdentitiesOnly=yes" \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.env' \
  --exclude 'uploads' --exclude 'backups' --exclude 'logs' \
  --exclude '*.tsbuildinfo' --exclude '.DS_Store' \
  ./ root@104.171.136.35:/opt/skladyx/
```

**[на сервере]**
```bash
cd /opt/skladyx
docker compose config --quiet
docker compose up -d --build
```
</details>

### Про `rsync --delete` — читать обязательно

Выкатка идёт с `--delete`: **всё, чего нет в исходном дереве, на сервере удаляется.**

- `/opt/backups` лежит **вне** target'ов, поэтому `rsync --delete` его **не трогает**.
- Всё, что должно пережить деплой, **нельзя** класть внутрь `/opt/skladyx` или
  `/opt/skladyx-staging`, если это не в git и не в exclude-списке.
- `.env` каждого контура сохраняется только потому, что он в **exclude**.
- Серверные скрипты бэкапа выживают потому, что они **в git** (`scripts/prod/`).

Exclude-список (одинаковый для обоих контуров):
`.git`, `node_modules`, `.next`, `.env`, `uploads`, `backups`, `logs`, `*.tsbuildinfo`, `.DS_Store`

### Про `docker compose config`
Использовать только **`docker compose config --quiet`**. Без `--quiet` команда печатает
развёрнутый конфиг, включая `DATABASE_URL` с паролем БД в открытом виде — он попадёт
в терминал и логи.

## 5. Проверки после деплоя

Для обоих контуров (скрипты делают это автоматически):

| Проверка | Ожидание |
|---|---|
| `/login` | `200` |
| `/warehouse` | `307` → `/login?next=/warehouse` |
| `/app` | `307` → `/warehouse` (legacy) |
| `docker compose ps` | app `Up`, db `Up (healthy)` |
| db наружу | порта `5432` на хосте нет |

**[на сервере]** порты: наружу опубликованы только `127.0.0.1:3003` (prod) и
`127.0.0.1:3013` (staging).

## 6. Rollback

**На сервере нет `.git`** — код доставляется rsync'ом, поэтому «откатиться git'ом на
сервере» невозможно.

**Откат кода** — **[локально на Mac]**:
```bash
git checkout <предыдущий-коммит>      # или git revert <плохой-коммит> && git push
./scripts/prod/deploy-staging.sh      # сначала проверить на staging
DEPLOY_ENV=prod CONFIRM_PROD_DEPLOY=rostagro ./scripts/prod/deploy-prod.sh
```
(скрипты требуют чистого дерева и `main == origin/main` — при откате через
`git revert` это выполняется само)

**Откат схемы БД — отдельная история.** `prisma migrate deploy` **forward-only**:
откат кода **НЕ откатывает миграции**. Если релиз содержал миграции и нужно вернуть
схему — только **restore из бэкапа** по [docs/RESTORE.md](RESTORE.md), с отдельным
подтверждением владельца.

Прочее при откате:
- **volumes не удалять** (в них данные);
- nginx не трогать без отдельной причины;
- `docker compose down -v` не выполнять никогда.

## 7. Запреты

- ❌ **не копировать `.env` между prod и staging** (у контуров свои секреты);
- ❌ **не менять prod `.env` при staging-деплое** (deploy вообще не трогает `.env` —
  он в exclude);
- ❌ **не включать `SEED_ON_START`** — сейчас на обоих контурах `SEED_ON_START=false`;
  деплой его не меняет, случайное `true` перезапустит первичный seed;
- ❌ **не использовать prod DB для staging** (staging живёт на seed-данных);
- ❌ **не запускать compose-файл из «чужого» каталога.** Оба compose-файла лежат в
  обоих каталогах. Например `docker compose -f docker-compose.staging.yml up -d`
  **внутри `/opt/skladyx`** поднимет стек с staging-volume'ами на prod-овом `.env` —
  так делать нельзя. Запускать только через deploy-скрипты;
- ❌ **не выполнять `docker compose down -v`** (удалит тома с данными);
- ❌ **не удалять `/opt/backups`**;
- ❌ **не коммитить** секреты, `.env`, дампы, логи, backup-архивы.
