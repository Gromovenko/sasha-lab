#!/bin/bash
# Очередь сбора базы знаний с ограничением ресурсов.
#
# Зачем: 18.09.2026 ручной запуск 15 параллельных `node harvest/run.js crawl <host>`
# (7 + ещё 8 поверх) выел все 8 ГБ RU без свопа — sshd перестал отвечать, прод
# lifeprotocol лёг. Параллельный харвест на боевом сервере запрещён: сбор идёт
# ТОЛЬКО через эту очередь.
#
#   scripts/harvest-queue.sh host1 host2 ...       # полный сбор перечисленных хостов
#   HARVEST_LIMIT=60 scripts/harvest-queue.sh ...  # ограничить страницы за заход
#   HARVEST_PAR=2 ...                              # параллельность (по умолчанию 1, потолок 2)
#
# Правила: не больше HARVEST_PAR процессов; перед КАЖДЫМ запуском ждём, пока
# свободной памяти станет >= MIN_FREE_MB; каждый процесс под nice/ionice и с
# потолком кучи V8, чтобы упал он, а не сервер.
set -u
cd /opt/sasha-lab 2>/dev/null || cd "$(dirname "$0")/.." || exit 1

PAR="${HARVEST_PAR:-1}"; [ "$PAR" -gt 2 ] && PAR=2
MIN_FREE_MB="${HARVEST_MIN_FREE_MB:-1500}"   # ниже этого новый сбор не стартует
HEAP_MB="${HARVEST_HEAP_MB:-512}"            # потолок кучи одного сборщика
LIMIT="${HARVEST_LIMIT:-}"
LOGDIR="${HARVEST_LOGDIR:-/var/log/sashalab-harvest}"
mkdir -p "$LOGDIR"

[ $# -gt 0 ] || { echo "укажите хосты: $0 host1 [host2 ...]"; exit 2; }

free_mb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }

wait_mem() {
  local waited=0
  while [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; do
    [ "$waited" -eq 0 ] && echo "  … жду память: свободно $(free_mb) МБ < $MIN_FREE_MB МБ"
    sleep 30; waited=$((waited+30))
    if [ "$waited" -ge 1800 ]; then echo "  ! памяти нет 30 минут — очередь остановлена"; exit 3; fi
  done
}

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
    echo "  <- $host завершён код=$? $(TZ=Europe/Moscow date '+%H:%M МСК')"
  ) &
  sleep 5
done
wait
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') очередь пройдена"
