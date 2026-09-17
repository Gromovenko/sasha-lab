#!/bin/bash
# Свежий спрос → новые страницы. Несколько раз в день (сервер живёт в UTC):
#   0 6,12,18 * * * /opt/sasha-lab/scripts/seo-autopages.sh   # 09:00, 15:00, 21:00 МСК
#
# Цикл спроса здесь ДЕШЁВЫЙ (--cheap): Вебмастер и Search Console бесплатны и
# отдают то, что люди спрашивают прямо сейчас. Wordstat (20 ₽ за вызов) остаётся
# в еженедельном harvest-cron.sh — его цифры всё равно обновляются раз в месяц.
#
# Публикуется страница сама ТОЛЬКО при сильном обосновании (два независимых
# факта). Слабая уходит черновиком в панель /seo — ровно чтобы автомат не начал
# ночью выкладывать страницы по машинам, о которых знает одну строчку.
set -u
cd /opt/sasha-lab || exit 1
LOG=/var/log/sashalab-seo.log
exec >> "$LOG" 2>&1
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') автостраницы"

timeout 900 node seo/cli.js demand --cheap || echo '  ! цикл спроса не доехал'
timeout 1800 node seo/cli.js autopages --limit "${AUTOPAGES_LIMIT:-2}" || echo '  ! автостраницы не доехали'
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') готово"
