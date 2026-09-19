#!/bin/bash
# Очередь сбора базы знаний с ограничением ресурсов.
#
# Зачем: 18.09.2026 ручной запуск 15 параллельных `node harvest/run.js crawl <host>`
# (7 + ещё 8 поверх) выел все 8 ГБ RU без свопа — sshd перестал отвечать, прод
# lifeprotocol лёг. Параллельный харвест на боевом сервере запрещён: сбор идёт
# ТОЛЬКО через эту очередь.
#
#   scripts/harvest-queue.sh host1 host2 ...       # полный сбор перечисленных хостов
#   scripts/harvest-queue.sh --plan                # порядок из замера скорости (см. ниже)
#   HARVEST_LIMIT=60 scripts/harvest-queue.sh ...  # ограничить страницы за заход
#   HARVEST_PAR=2 ...                              # параллельность (по умолчанию 1, потолок 2)
#
# `--plan` берёт хосты из seo/data/harvest-speed.json — файла, который пишет
# `node harvest/run.js probe`: там для каждого источника измеренная безопасная
# пауза и оценка, сколько часов займёт его заход. Порядок в плане — по
# возрастанию времени: сначала быстрые и почти добранные источники, самые
# долгие в конце. Смысл ровно один: заход идёт сутками, и польза должна
# появляться в первые часы, а не в последние. План старше недели не берём —
# скорость чужого сайта меняется, пере-замерить дешевле, чем давить вслепую.
#
# Правила: не больше HARVEST_PAR процессов; перед КАЖДЫМ запуском ждём, пока
# свободной памяти станет >= MIN_FREE_MB; каждый процесс под nice/ionice и с
# потолком кучи V8, чтобы упал он, а не сервер.
set -u
cd /opt/sasha-lab 2>/dev/null || cd "$(dirname "$0")/.." || exit 1

# ЗАМОК. Сбор всегда идёт в ОДНОМ экземпляре на сервер: и очередь полного
# захода, и еженедельный крон берут один и тот же flock. Без него воскресный
# крон садится поверх идущего сутками полного захода — двойная нагрузка на нас
# и, что хуже, двойная частота запросов к каждому чужому сайту, то есть ровно
# тот случай, ради которого всё остальное здесь и меряется.
LOCK=/tmp/sashalab-harvest.lock
if [ -z "${HARVEST_LOCKED:-}" ]; then
  export HARVEST_LOCKED=1
  # -E 99: «замок занят» должно отличаться от обычной единицы, которую вернёт
  # сам сбор при своей ошибке, иначе повод выхода из лога не восстановить.
  flock -E 99 -n "$LOCK" "$0" "$@"; rc=$?
  [ "$rc" = 99 ] && echo "  сбор уже идёт (замок $LOCK) — этот запуск пропущен"
  exit "$rc"
fi

PAR="${HARVEST_PAR:-1}"; [ "$PAR" -gt 2 ] && PAR=2
MIN_FREE_MB="${HARVEST_MIN_FREE_MB:-1500}"   # ниже этого новый сбор не стартует
# 512 МБ не хватало на источники с большой картой сайта (legal-xenon, steklafar,
# mtflight-shop, statlight, nts-auto падали по heap ещё 18.09) — потолок поднят
# до 1024. При PAR=1 это безопасно даже на 3,8 ГБ нового сервера.
HEAP_MB="${HARVEST_HEAP_MB:-1024}"           # потолок кучи одного сборщика
LIMIT="${HARVEST_LIMIT:-}"
LOGDIR="${HARVEST_LOGDIR:-/var/log/sashalab-harvest}"
mkdir -p "$LOGDIR"

if [ "${1:-}" = "--plan" ]; then
  PLAN="${HARVEST_PLAN:-seo/data/harvest-speed.json}"
  [ -f "$PLAN" ] || { echo "нет плана $PLAN — сначала: node harvest/run.js probe"; exit 2; }
  AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$PLAN") ) / 86400 ))
  [ "$AGE_DAYS" -le 7 ] || echo "  ⚠ план снят $AGE_DAYS дней назад — стоит пере-замерить (run.js probe)"
  # shellcheck disable=SC2046
  set -- $(node -e 'const p=require("./"+process.argv[1]);process.stdout.write(p.plan.filter(x=>x.left>0).map(x=>x.host).join(" "))' "$PLAN")
  [ $# -gt 0 ] || { echo "в плане нет источников с недобранными страницами — сбор не нужен"; exit 0; }
  echo "  план из $PLAN: $*"
fi

[ $# -gt 0 ] || { echo "укажите хосты: $0 host1 [host2 ...] | $0 --plan"; exit 2; }

free_mb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }

wait_mem() {
  local waited=0
  while [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; do
    [ "$waited" -eq 0 ] && echo "  … жду память: свободно $(free_mb) МБ < $MIN_FREE_MB МБ"
    sleep 30; waited=$((waited+30))
    if [ "$waited" -ge 1800 ]; then echo "  ! памяти нет 30 минут — очередь остановлена"; exit 3; fi
  done
}

FAILED=/tmp/sashalab-harvest-failed.$$
: > "$FAILED"

echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') очередь сбора: $* (par=$PAR, heap=${HEAP_MB}М, порог ${MIN_FREE_MB}М)"
for host in "$@"; do
  while [ "$(jobs -rp | wc -l)" -ge "$PAR" ]; do sleep 10; done
  wait_mem
  echo "  -> $host  (свободно $(free_mb) МБ)"
  (
    # Сам себя назначаем первой жертвой OOM-killer: запущенный по ssh процесс
    # наследует oom_score_adj от sshd (-1000 после ops/ru-safety-net.sh) и стал бы
    # для ядра неприкосновенным — умирал бы прод, а не сбор.
    echo 900 > /proc/self/oom_score_adj 2>/dev/null || true
    nice -n 15 ionice -c3 \
      node --max-old-space-size="$HEAP_MB" harvest/run.js crawl "$host" ${LIMIT:+--limit "$LIMIT"} \
      >> "$LOGDIR/$host.log" 2>&1
    code=$?
    echo "  <- $host завершён код=$code $(TZ=Europe/Moscow date '+%H:%M МСК')"
    # 134 = V8 «heap limit», 137 = убит OOM-killer. Такой источник не «собран»,
    # он оборвался — и без пометки это видно только чтением лога построчно.
    [ "$code" -ne 0 ] && echo "$host" >> "$FAILED"
  ) &
  sleep 5
done
wait

# Один повтор по упавшим. Сбор инкрементальный (страница сохраняется сразу,
# уже собранные адреса пропускаются), поэтому повтор продолжает с того места,
# где источник оборвался, а не начинает заново.
if [ -s "$FAILED" ]; then
  RETRY=$(tr '\n' ' ' < "$FAILED")
  echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') повтор по упавшим: $RETRY"
  for host in $RETRY; do
    wait_mem
    echo "  -> $host (повтор)"
    (
      echo 900 > /proc/self/oom_score_adj 2>/dev/null || true
      nice -n 15 ionice -c3 \
        node --max-old-space-size="$HEAP_MB" harvest/run.js crawl "$host" ${LIMIT:+--limit "$LIMIT"} \
        >> "$LOGDIR/$host.log" 2>&1
      echo "  <- $host повтор завершён код=$? $(TZ=Europe/Moscow date '+%H:%M МСК')"
    )
  done
fi
rm -f "$FAILED"
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') очередь пройдена"
