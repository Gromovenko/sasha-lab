#!/bin/bash
# Итеративно выкачивает все внешние ассеты (tildacdn и пр.), на которые ссылается зеркало.
set -u
ROOT=/root/gromovenko/sasha-lab/mirror
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
cd "$ROOT" || exit 1
mkdir -p cdn
for round in 1 2 3 4 5; do
  # собрать все https-ссылки на разрешённые хосты из уже скачанных текстовых файлов
  grep -rhoE 'https://[a-zA-Z0-9.-]*tildacdn\.(com|net|pub)/[^"'"'"' )\\]*' \
    --include='*.html' --include='*.css' --include='*.js' . 2>/dev/null \
    | sed 's/[,;)]*$//' | sort -u > /tmp/urls.$round
  new=0
  while read -r u; do
    [ -z "$u" ] && continue
    path=$(echo "$u" | sed 's|https://||')
    out="cdn/$path"
    [ -f "$out" ] && continue
    mkdir -p "$(dirname "$out")"
    if curl -sfL --compressed --max-time 30 -A "$UA" "$u" -o "$out"; then new=$((new+1)); else rm -f "$out"; fi
  done < /tmp/urls.$round
  echo "round $round: urls=$(wc -l < /tmp/urls.$round) new=$new"
  [ "$new" -eq 0 ] && break
done
