# Переезд sasha-lab на собственный сервер 77.105.168.153

Решение владельца 19.09.2026: **полный переезд** проекта sasha-lab с RU (80.249.150.234)
на новый сервер **77.105.168.153**, со снятием проекта со старого сервера после проверки.
Домен **sasha-lab.ru** будет направлен на новый сервер (сейчас A-запись → 176.57.66.123,
NS у Beget). Letov уводится отдельно и этим раннбуком не затрагивается.

Весь переезд делает один скрипт: `scripts/migrate-to-new-server.sh <фаза>`.

## Шаг 0 — доступ (на владельце)

Ключ уже сгенерирован на EU: приватный `/root/.ssh/sashalab_new`, публичный
`/root/.ssh/sashalab_new.pub`:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIILSGwXIg/WsOmRcWbJ64hE+4x3tEOBBRVMQzMnWAW8+ sashalab-migration-20260919
```

Добавить его в `~root/.ssh/authorized_keys` на 77.105.168.153 (порт 22 уже слушает,
ping ~61 мс). Проверка: `ssh -i /root/.ssh/sashalab_new root@77.105.168.153 hostname`.

## Что переносится

| Что | Откуда на RU | Куда |
|---|---|---|
| код + зеркало + packs + seo/data | `/opt/sasha-lab` | `/opt/sasha-lab` |
| секреты (Avito, Yandex, neuraldeep, SMS.RU, БД) | `seo/.env` | `seo/.env` (0600, sashaweb) |
| база (48 МБ) | docker `sashalab-pg` :5446 | такой же контейнер postgres:15 |
| служба | pm2 `sasha-lab`, 127.0.0.1:3060 | то же, pm2 startup от sashaweb |
| крон | `crontab -u sashaweb` (harvest-cron вс 00:00, seo-autopages 6/12/18, engine-cron каждые 15 мин) | то же |
| публикация | nginx-vhost + LE на sslip.io | nginx-vhost `sasha-lab.ru` + `www` + LE |

**Не переносится:** `.harvest-cache` (5.2 ГБ кэша сбора — пересоздаётся), `node_modules`,
`dist` (пересобираются), `.git` (репо-исток живёт на EU `/root/gromovenko/sasha-lab`).

## Порядок фаз

```bash
./scripts/migrate-to-new-server.sh pack          # ✅ сделано 19.09 12:22 МСК (40 МБ, sha256 aa820308…)
./scripts/migrate-to-new-server.sh pull          # ✅ артефакт на EU: /root/sashalab-migrate/
./scripts/migrate-to-new-server.sh provision     # node22 + docker + nginx + certbot + pm2 + sashaweb
./scripts/migrate-to-new-server.sh push          # код, БД, .env, миграции, сборка, pm2, крон
./scripts/migrate-to-new-server.sh nginx         # vhost sasha-lab.ru по HTTP (для acme-challenge)
#   ↓ здесь владелец меняет A-записи sasha-lab.ru и www → 77.105.168.153 (Beget), ждём TTL
./scripts/migrate-to-new-server.sh cert          # LE + редирект на HTTPS (сам проверяет, что DNS доехал)
./scripts/migrate-to-new-server.sh verify        # главная + ВСЕ ассеты + /baza/ /admin/ /crm /zayavka
./scripts/migrate-to-new-server.sh decommission  # только после зелёного verify
```

`pack` можно повторить прямо перед `push`, чтобы забрать свежие заявки и вопросы,
накопившиеся на RU за время подготовки — база на старом сервере продолжает жить до
`decommission`.

## Проверка выката

Не «curl / == 200». `verify` вытягивает свежий HTML главной, собирает **все** локальные
ссылки (`/cdn/…`, `/_next`-аналогов тут нет, зеркало Tilda — 180+ ассетов) и требует 200 от
каждой; затем дёргает разделы `/baza/`, `/admin/`, `/crm`, `/zayavka`. Ненулевое число
битых ссылок = фаза падает, `decommission` запускать нельзя.

## Снятие со старого сервера (`decommission`)

Делает, в порядке: `pm2 delete sasha-lab` + `pm2 save`, `crontab -u sashaweb -r`,
финальный холодный дамп в `/root/sashalab-final-<дата>.sql` (страховка отката),
удаление контейнера `sashalab-pg` и его тома, вырезание `server`-блоков `sashalab.*`
из `/etc/nginx/sites-enabled/ru-restored` (с бэкапом рядом) + `nginx -t && reload`,
`rm -rf /opt/sasha-lab`. Артефакт `/root/SASHALAB-ARTIFACT.tar.gz` на RU остаётся.

После этого обновить `gromdash/system.manifest.yaml` (сервис sasha-lab переезжает с RU на
новый сервер, порт 3060, публичный адрес — `https://sasha-lab.ru`) и карточку в дашборде
(`SITE_URL` в `gromdash/ui/index.html` — сейчас там sslip.io-адрес).

## После переезда домена — отдельным заходом

1. Снять `noindex` (шаг 0 из `SEO-PLAN.md` — он ждал именно переезда домена).
2. Оригинальный Tilda-сайт остаётся у Beget без домена — решение владельца, куда его деть.
3. `SEO_DOMAIN` в `seo/.env` → `sasha-lab.ru`, перезапуск pm2 с `--update-env`.
4. Проверить, что автодиалог Авито и уведомления админа пошли с нового IP (ключи те же).
