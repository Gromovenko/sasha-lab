#!/bin/bash
# Отчёт о процессах sasha-lab в Telegram.
#   scripts/daily-report.sh          # полный суточный отчёт
#   scripts/daily-report.sh alert    # молчит, если всё в порядке; шлёт только новую беду
#   scripts/daily-report.sh test     # короткое проверочное сообщение
# Крон (сервер в UTC, отчёт в 09:00 МСК): 0 6 * * *  и  */10 * * * * ... alert
# Секреты — только в seo/.env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
# chat_id, если не задан, берётся из первого сообщения боту (getUpdates) и дописывается в .env.
set -u
MODE="${1:-full}"
cd /opt/sasha-lab || exit 1
ENV=seo/.env
set -a; . "$ENV"; set +a
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || { echo "нет TELEGRAM_BOT_TOKEN в $ENV" >&2; exit 2; }
# С этого хоста api.telegram.org напрямую недоступен: ходим через SSH-туннель
# sashalab-tgtunnel (systemd, 127.0.0.1:8443 -> EU -> api.telegram.org:443).
# TLS сквозной: имя хоста то же, --resolve лишь подменяет адрес.
TG_PORT="${TG_PORT:-8443}"
API="https://api.telegram.org:${TG_PORT}/bot${TELEGRAM_BOT_TOKEN}"
tg() { # метод, аргументы curl; токен в URL идёт через stdin, не в ps
  local m="$1"; shift
  printf 'url = "%s/%s"\n' "$API" "$m" | curl -sS -m 20 --resolve "api.telegram.org:${TG_PORT}:127.0.0.1" -K - "$@"
}

if [ -z "${TELEGRAM_CHAT_ID:-}" ] && [ -z "${DRY:-}" ]; then
  CID=$(tg getUpdates | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result||[];const m=r.map(u=>u.message||u.my_chat_member||{}).filter(m=>m.chat).pop();if(m)console.log(m.chat.id)}catch(e){}})')
  [ -n "$CID" ] || { echo "chat_id неизвестен: напишите боту любое сообщение" >&2; exit 3; }
  echo "TELEGRAM_CHAT_ID=$CID" >> "$ENV"; TELEGRAM_CHAT_ID="$CID"
fi
send() { [ -n "${DRY:-}" ] && { echo "$1"; return; };  tg sendMessage --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=${1:0:4000}" -o /dev/null -w '%{http_code}\n'; }

q() { psql "$SASHALAB_PG_URL" -Atc "$1" 2>/dev/null; }
NOW=$(TZ=Europe/Moscow date '+%d.%m %H:%M МСК')

# --- измерения ---
MEM_MB=$(awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo)
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc 0-9)
LOAD=$(cut -d' ' -f1 /proc/loadavg)
SITE=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://sashalab.77-105-168-153.sslip.io/ )
QPROC=$(pgrep -fc 'harvest-queue|harvest/run.js' )
CUR=$(pgrep -af 'harvest/run.js crawl' | head -1 | sed -E 's/.*crawl +([^ ]+).*/\1/')
# facts-backlog.log — разовая ручная дозаливка (разбор в факты), не сама очередь
# сбора. Она заканчивается и молчит по завершении — это норма, а не зависание,
# так что в проверку "жив ли сбор" её включать нельзя (инцидент 22.09: ложная
# тревога через 143 мин после штатного завершения дозаливки).
LASTLOG=$(ls -t /var/log/sashalab-harvest/*.log 2>/dev/null | grep -v '/facts-backlog\.log$' | head -1)
LOGAGE=$(( $(date +%s) - $(stat -c %Y "${LASTLOG:-/dev/null}" 2>/dev/null || echo 0) ))
# Очередь, дошедшая до конца, пишет в свой лог «очередь пройдена» и замолкает —
# это норма, а не зависание (инцидент 22.09 20:20: тревога через 68 мин после
# штатного финала queue-20260922-maxspeed.log). Маркер засчитываем, только если
# лог очереди не старше самого свежего лога сбора, иначе оборванный ручной заход
# по одному хосту прикрылся бы финалом прошлой очереди.
QLOG=$(ls -t /var/log/sashalab-harvest/queue-*.log 2>/dev/null | head -1)
QDONE=0
if [ -n "$QLOG" ] && tail -5 "$QLOG" | grep -q 'очередь пройдена'; then
  QT=$(stat -c %Y "$QLOG"); LT=$(stat -c %Y "${LASTLOG:-/dev/null}" 2>/dev/null || echo 0)
  [ "$QT" -ge $(( LT - 300 )) ] && QDONE=1
fi

if [ "$MODE" = test ]; then
  send "Sasha Lab Bot на связи. $NOW. Отчёты будут приходить в этот чат."; exit 0
fi

if [ "$MODE" = alert ]; then
  PROB=""; KIND=""   # KIND — стабильный отпечаток беды для дедупа, без «плавающих» минут:
                      # иначе меняющееся число минут в тексте каждый раз даёт новый хэш
                      # и алерт шлётся заново каждые 10 мин, пока беда не снята (было так
                      # 22.09 — 10 сообщений подряд про один и тот же зависший vdf-light).
  [ "$MEM_MB" -lt 1000 ] && { PROB+="память: доступно ${MEM_MB} МБ (<1 ГБ)"$'\n'; KIND+="mem;"; }
  [ "$DISK_PCT" -ge 90 ] && { PROB+="диск заполнен на ${DISK_PCT}%"$'\n'; KIND+="disk;"; }
  [ "$SITE" != 200 ] && { PROB+="сайт отвечает ${SITE}"$'\n'; KIND+="site:$SITE;"; }
  [ "$QPROC" -eq 0 ] && [ "$QDONE" -eq 0 ] && [ "$LOGAGE" -lt 86400 ] && [ "$LOGAGE" -gt 3600 ] && { PROB+="сбор остановлен: процессов нет, лог не менялся $((LOGAGE/60)) мин (${LASTLOG##*/})"$'\n'; KIND+="queue:${LASTLOG##*/};"; }
  STATE=/var/tmp/sashalab-alert.state
  H=ok; [ -n "$KIND" ] && H=$(printf '%s' "$KIND" | md5sum | cut -c1-32)
  PREV=$(cat $STATE 2>/dev/null || echo ok)
  [ "$H" = "$PREV" ] && exit 0   # та же беда уже отправлена (или всё в порядке и было в порядке)
  echo "$H" > $STATE
  if [ -n "$PROB" ]; then send "ТРЕВОГА sasha-lab, $NOW"$'\n'"$PROB"; else send "sasha-lab: проблемы сняты, $NOW"; fi
  exit 0
fi

# --- полный отчёт ---
TOTAL=$(q "select count(*) from documents")
D24=$(q "select count(*) from documents where fetched_at > now()-interval '24 hours'")
FIT=$(q "select count(*) from fitment")
VEH=$(q "select count(distinct vehicle_id) from fitment")
LINKED=$(q "select count(distinct vehicle_id) from vehicle_links")
ROWS=$(q "select s.host, count(d.id), s.max_pages, count(d.id) filter (where d.fetched_at > now()-interval '24 hours'), count(d.id) filter (where d.http_status>=400) from sources s left join documents d on d.source_id=s.id where s.enabled group by s.host,s.max_pages order by 2 desc" | awk -F'|' '{p=($3>0)?int($2*100/$3):0; printf "%-22s %5d/%-5d %3d%%  +%d за сутки%s\n",$1,$2,$3,p,$4,($5>0?"  ош:"$5:"")}')
if [ "$QPROC" -gt 0 ]; then QS="идёт${CUR:+, сейчас: $CUR}"
elif [ "$QDONE" -eq 1 ]; then QS="очередь пройдена (${QLOG##*/})"
else QS="НЕ идёт (последний лог: ${LASTLOG##*/}, ${LOGAGE}с назад)"; fi

send "Sasha Lab — отчёт $NOW

СБОР: $QS
Документов в базе: $TOTAL (+$D24 за сутки)
$ROWS

ФАКТЫ: посадок $FIT, машин с фактами $VEH, машин со ссылками $LINKED

СЕРВЕР: память доступно ${MEM_MB} МБ, диск ${DISK_PCT}%, нагрузка $LOAD
САЙТ: код ответа $SITE"
