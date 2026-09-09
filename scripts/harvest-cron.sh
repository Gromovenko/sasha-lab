#!/bin/bash
# Еженедельный сбор базы знаний. Ставится в cron на RU (сервер живёт в UTC):
#   0 0 * * 0 /opt/sasha-lab/scripts/harvest-cron.sh   # вс 03:00 МСК
#
# Публикацию скрипт НЕ делает намеренно: сборка статики и рестарт — действие
# человека. Автомат, который сам выкатывает страницы по свежесобранным фактам,
# рано или поздно опубликует страницу по машине, о которой знает одну строчку,
# и сделает это ночью, когда никто не смотрит.
set -u
cd /opt/sasha-lab || exit 1
LOG=/var/log/sashalab-harvest.log
exec >> "$LOG" 2>&1
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') сбор базы знаний"

# Каждый источник отдельной командой: упавший не должен уносить остальные.
for what in works parts community; do
  timeout 3600 node harvest/run.js crawl "$what" --limit 60 || echo "  ! этап $what не доехал"
done
timeout 1800 node harvest/run.js facts || echo '  ! разбор фактов упал'
node harvest/run.js stats

# Спрос: Wordstat + Вебмастер + GSC → семантика → сео-память. Без ключей команда
# честно скажет об этом в лог и не свалит остальное.
timeout 1800 node seo/cli.js demand || echo '  ! цикл спроса не доехал'
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') готово"
