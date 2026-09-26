#!/bin/bash
# Освобождение места на проде sasha-lab (диск был занят на 92,8%).
#
#   scripts/prod-cleanup.sh          — только СПИСОК того, что будет удалено
#   scripts/prod-cleanup.sh --yes    — удалить показанное
#
# Трогаем только логи и дампы старше 7 дней и /tmp. Никогда — /opt/sasha-lab/uploads,
# базу и кэш сбора (.harvest-cache сжимается отдельно: scripts/compress-harvest-cache.js).
set -u
DAYS="${CLEAN_DAYS:-7}"
YES=0; [ "${1:-}" = "--yes" ] && YES=1
DIRS=(/var/log/sashalab-harvest /var/log/sashalab-fullharvest /var/log/sashalab /opt/sasha-lab/logs /root/backups/sashalab /var/backups/sashalab)
LIST=$(mktemp)
for d in "${DIRS[@]}"; do
  [ -d "$d" ] && find "$d" -type f -mtime +"$DAYS" \( -name '*.log' -o -name '*.log.*' -o -name '*.gz' -o -name '*.sql' -o -name '*.dump' \) -print0 2>/dev/null | xargs -0 -r ls -l --time-style=+%F >> "$LIST"
done
find /tmp -maxdepth 1 -user "$(id -un)" -mtime +"$DAYS" -type f -print0 2>/dev/null | xargs -0 -r ls -l --time-style=+%F >> "$LIST"
echo "df до:"; df -h / | tail -1
echo "кандидатов: $(wc -l < "$LIST"), объём: $(awk '{s+=$5} END{printf "%.0f МБ", s/1048576}' "$LIST")"
cat "$LIST"
if [ "$YES" = 1 ]; then
  awk '{print $NF}' "$LIST" | grep -v '/uploads/' | xargs -r rm -f
  echo "удалено. df после:"; df -h / | tail -1
else
  echo "(сухой прогон — для удаления добавьте --yes)"
fi
rm -f "$LIST"
