#!/bin/bash
cd /opt/sasha-lab; set -a; . seo/.env; set +a
while :; do
  out=$(nice -n 10 node harvest/run.js facts --limit 5000 2>&1); echo "$(date +%H:%M) $out" | tail -1
  echo "$out" | grep -q "документов 0:" && break
done
node harvest/run.js links 2>&1 | tail -2
node harvest/run.js stats 2>&1 | tail -3
