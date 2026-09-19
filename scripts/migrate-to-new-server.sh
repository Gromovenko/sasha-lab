#!/usr/bin/env bash
# Полный переезд sasha-lab со старого сервера (RU 80.249.150.234) на новый (77.105.168.153),
# со снятием проекта со старого сервера после проверки.
#
# Фазы (запускать по порядку, каждую отдельно — скрипт ничего не делает «за один присест»):
#   pack          — на RU: дамп БД + архив кода/данных/кронов/nginx → /root/sashalab-migrate/
#   pull          — забрать артефакт на EU (командный центр)
#   provision     — на новом: node/nginx/docker/certbot, пользователь sashaweb, каталоги
#   push          — залить артефакт на новый сервер и развернуть (код, БД, .env, крон, pm2)
#   nginx         — vhost sasha-lab.ru + www (HTTP), до выпуска сертификата
#   cert          — выпустить Let's Encrypt (ТОЛЬКО после того, как DNS sasha-lab.ru смотрит на новый IP)
#   verify        — полная выборка: главная + все ассеты + /baza/ + /admin/ (не «curl / == 200»)
#   decommission  — на RU: снять pm2, контейнер БД, крон, nginx-vhost, архивировать и удалить /opt/sasha-lab
#
# Требование: публичный ключ /root/.ssh/sashalab_new.pub добавлен в root@77.105.168.153.
set -euo pipefail

NEW_IP=${NEW_IP:-77.105.168.153}
NEW_SSH=${NEW_SSH:-"ssh -i /root/.ssh/sashalab_new -o StrictHostKeyChecking=accept-new root@$NEW_IP"}
RU_SSH=${RU_SSH:-"ssh -i /root/.ssh/ru_key root@10.10.0.2"}
DOMAIN=${DOMAIN:-sasha-lab.ru}
STAMP=$(date +%Y%m%d)
ART=sashalab-migrate-$STAMP.tar.gz
LOCAL_DIR=${LOCAL_DIR:-/root/sashalab-migrate}

log(){ echo "[$(TZ=Europe/Moscow date '+%F %T МСК')] $*"; }

phase_pack() {
  log "pack: собираю артефакт на RU"
  $RU_SSH 'bash -s' <<'RUS'
set -euo pipefail
W=/root/sashalab-migrate; rm -rf "$W"; mkdir -p "$W"
# 1. база
docker exec sashalab-pg pg_dump -U sashalab -d sashalab --no-owner --no-acl > "$W/sashalab.sql"
# 2. код и данные (без кэша сбора 5 ГБ, без node_modules и dist — пересоберутся)
tar czf "$W/opt-sasha-lab.tar.gz" -C /opt \
  --exclude='sasha-lab/.harvest-cache' \
  --exclude='sasha-lab/node_modules' \
  --exclude='sasha-lab/dist' \
  --exclude='sasha-lab/.git' \
  sasha-lab
# 3. секреты, крон, vhost, pm2-описание
cp /opt/sasha-lab/seo/.env "$W/seo.env"
crontab -u sashaweb -l > "$W/crontab.sashaweb" 2>/dev/null || true
sed -n '/sashalab/,/^}/p' /etc/nginx/sites-enabled/ru-restored > "$W/nginx.ru.snippet" || true
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 pm2 jlist > "$W/pm2.json" 2>/dev/null || true
docker inspect sashalab-pg > "$W/pg-container.json"
cd /root && tar czf /root/SASHALAB-ARTIFACT.tar.gz sashalab-migrate
ls -lh /root/SASHALAB-ARTIFACT.tar.gz
sha256sum /root/SASHALAB-ARTIFACT.tar.gz
RUS
}

phase_pull() {
  log "pull: забираю артефакт на EU"
  mkdir -p "$LOCAL_DIR"
  rsync -av -e "ssh -i /root/.ssh/ru_key" root@10.10.0.2:/root/SASHALAB-ARTIFACT.tar.gz "$LOCAL_DIR/$ART"
  sha256sum "$LOCAL_DIR/$ART"
}

phase_provision() {
  log "provision: готовлю новый сервер $NEW_IP"
  $NEW_SSH 'bash -s' <<'NEWS'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx rsync ufw >/dev/null
# node 22
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
# docker
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh >/dev/null; }
# certbot
command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
npm list -g pm2 >/dev/null 2>&1 || npm i -g pm2 >/dev/null
id sashaweb >/dev/null 2>&1 || useradd -m -d /var/lib/sashaweb -s /bin/bash sashaweb
mkdir -p /opt/sasha-lab && chown -R sashaweb:sashaweb /opt/sasha-lab
node -v; docker --version; nginx -v; certbot --version
NEWS
}

phase_push() {
  log "push: разворачиваю проект на новом сервере"
  scp -i /root/.ssh/sashalab_new "$LOCAL_DIR/$ART" root@"$NEW_IP":/root/
  $NEW_SSH "ART=$ART bash -s" <<'NEWS'
set -euo pipefail
cd /root && rm -rf sashalab-migrate && tar xzf "/root/$ART"
W=/root/sashalab-migrate
# код
rm -rf /opt/sasha-lab.old; [ -d /opt/sasha-lab ] && mv /opt/sasha-lab /opt/sasha-lab.old || true
tar xzf "$W/opt-sasha-lab.tar.gz" -C /opt
install -o sashaweb -g sashaweb -m 600 "$W/seo.env" /opt/sasha-lab/seo/.env
chown -R sashaweb:sashaweb /opt/sasha-lab
# база: тот же контейнер, что на RU (postgres:15, bind 127.0.0.1:5446)
PGPASS=$(grep -oP 'postgres://sashalab:\K[^@]+' "$W/seo.env")
docker rm -f sashalab-pg 2>/dev/null || true
docker volume create sashalab-pgdata >/dev/null
docker run -d --name sashalab-pg --restart unless-stopped \
  -e POSTGRES_USER=sashalab -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=sashalab \
  -p 127.0.0.1:5446:5432 -v sashalab-pgdata:/var/lib/postgresql/data postgres:15 >/dev/null
for i in $(seq 1 60); do docker exec sashalab-pg pg_isready -U sashalab -q && break; sleep 2; done
docker exec -i sashalab-pg psql -U sashalab -d sashalab -v ON_ERROR_STOP=1 < "$W/sashalab.sql" >/dev/null
# сборка и запуск
cd /opt/sasha-lab
sudo -u sashaweb npm install --omit=dev --no-audit --no-fund
sudo -u sashaweb node db/migrate.js
sudo -u sashaweb node content/build.js
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 pm2 delete sasha-lab 2>/dev/null || true
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 PORT=3060 pm2 start server.js --name sasha-lab --update-env
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u sashaweb --hp /var/lib/sashaweb | tail -1 | bash || true
# крон сбора/автостраниц/движка
crontab -u sashaweb "$W/crontab.sashaweb" 2>/dev/null || true
sleep 3; curl -sS -o /dev/null -w 'local 3060: %{http_code}\n' http://127.0.0.1:3060/
NEWS
}

phase_nginx() {
  log "nginx: vhost $DOMAIN на новом сервере (HTTP)"
  $NEW_SSH "DOMAIN=$DOMAIN bash -s" <<'NEWS'
set -euo pipefail
cat > /etc/nginx/sites-available/sasha-lab <<CONF
server {
  listen 80; listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 30m;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / {
    proxy_pass http://127.0.0.1:3060;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
CONF
mkdir -p /var/www/html
ln -sf /etc/nginx/sites-available/sasha-lab /etc/nginx/sites-enabled/sasha-lab
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
NEWS
}

phase_cert() {
  log "cert: Let's Encrypt для $DOMAIN (DNS уже должен смотреть на $NEW_IP)"
  dig +short "$DOMAIN" | grep -q "$NEW_IP" || { echo "СТОП: A-запись $DOMAIN ещё не на $NEW_IP"; exit 1; }
  $NEW_SSH "certbot --nginx -d $DOMAIN -d www.$DOMAIN --agree-tos -m gromprivate@gmail.com --redirect -n && systemctl reload nginx"
}

phase_verify() {
  log "verify: полная выборка по $DOMAIN"
  BASE=${BASE:-https://$DOMAIN}
  tmp=$(mktemp -d)
  curl -sSL --compressed "$BASE/" -o "$tmp/index.html" -w 'главная: %{http_code}\n'
  grep -oE '(src|href)="(/[^"]+)"' "$tmp/index.html" | sed -E 's/.*"(\/[^"]+)"/\1/' | sort -u > "$tmp/links"
  bad=0; total=0
  while read -r p; do
    total=$((total+1))
    code=$(curl -s -o /dev/null -w '%{http_code}' --compressed "$BASE$p")
    [ "$code" = 200 ] || { echo "  ✗ $code $p"; bad=$((bad+1)); }
  done < "$tmp/links"
  echo "ассетов проверено: $total, битых: $bad"
  for p in /baza/ /admin/ /crm /zayavka; do
    echo "  $p -> $(curl -s -o /dev/null -w '%{http_code}' -L "$BASE$p")"
  done
  [ "$bad" = 0 ]
}

phase_decommission() {
  log "decommission: снимаю sasha-lab со старого сервера RU"
  $RU_SSH 'bash -s' <<'RUS'
set -euo pipefail
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 pm2 delete sasha-lab 2>/dev/null || true
sudo -u sashaweb PM2_HOME=/var/lib/sashaweb/.pm2 pm2 save 2>/dev/null || true
crontab -u sashaweb -r 2>/dev/null || true
# последний холодный дамп на случай отката (артефакт остаётся в /root)
docker exec sashalab-pg pg_dump -U sashalab -d sashalab --no-owner --no-acl > /root/sashalab-final-$(date +%Y%m%d).sql || true
docker rm -f sashalab-pg || true
docker volume rm $(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' sashalab-pg 2>/dev/null) 2>/dev/null || true
# nginx: убрать блоки sashalab.* из ru-restored
cp /etc/nginx/sites-enabled/ru-restored /root/ru-restored.bak.$(date +%Y%m%d)
python3 - <<'PY'
import re
p='/etc/nginx/sites-enabled/ru-restored'
s=open(p).read()
blocks=re.findall(r'server\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', s, re.S)
for b in blocks:
    if 'sashalab.' in b:
        s=s.replace(b,'')
open(p,'w').write(s)
PY
nginx -t && systemctl reload nginx
rm -rf /opt/sasha-lab
echo "RU очищен: pm2/крон/контейнер/каталог сняты, vhost убран"
RUS
}

case "${1:-}" in
  pack|pull|provision|push|nginx|cert|verify|decommission) "phase_$1" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
