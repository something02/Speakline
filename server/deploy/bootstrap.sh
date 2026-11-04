#!/bin/bash
# One-shot install on a fresh Ubuntu/Debian VM (e.g. Google Cloud e2-micro).
# Usage: curl -fsSL https://raw.githubusercontent.com/something02/Speakline/main/server/deploy/bootstrap.sh | sudo bash
# Domain defaults to <external-ip>.sslip.io (free, no DNS needed). Override: sudo DOMAIN=api.example.com bash bootstrap.sh
# Secrets are NOT set here: after install, put your keys into /srv/speakline/server/.env and run: sudo systemctl restart speakline
set -euo pipefail

IP=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || curl -fsS https://api.ipify.org)
DOMAIN=${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
echo ">> IP $IP, domain $DOMAIN"

# 1 GB swap: e2-micro has 1 GB RAM
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq nginx certbot python3-certbot-nginx sqlite3 git curl ca-certificates
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

id speakline >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin speakline
mkdir -p /var/lib/speakline && chown speakline /var/lib/speakline
if [ -d /srv/speakline/.git ]; then git -C /srv/speakline pull -q; else git clone -q https://github.com/something02/Speakline.git /srv/speakline; fi
cd /srv/speakline/server && npm ci --omit=dev --silent

if [ ! -f .env ]; then
  sed -e "s#^DB_PATH=.*#DB_PATH=/var/lib/speakline/speakline.db#" \
      -e "s#^APP_ORIGIN=.*#APP_ORIGIN=https://something02.github.io#" \
      -e "s#^APP_URL=.*#APP_URL=https://something02.github.io/Speakline/#" \
      -e "s#^STATIC_DIR=.*#STATIC_DIR=#" \
      -e "s#^SMTP_URL=.*#SMTP_URL=#" \
      -e "s#^ADMIN_KEY=.*#ADMIN_KEY=$(openssl rand -hex 16)#" \
      .env.example > .env
fi
chown root:speakline .env && chmod 640 .env

cp deploy/speakline.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now speakline && systemctl restart speakline

sed "s/speakline\.kz/$DOMAIN/g; /www\.$DOMAIN/s/ www\.$DOMAIN//" deploy/nginx.conf > /etc/nginx/sites-available/speakline
# start with plain HTTP so certbot can prove the domain, then let certbot add 443
cat > /etc/nginx/sites-available/speakline-http <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { proxy_pass http://127.0.0.1:8787; }
}
EOF
rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/speakline
ln -sf /etc/nginx/sites-available/speakline-http /etc/nginx/sites-enabled/speakline-http
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
rm -f /etc/nginx/sites-enabled/speakline-http
ln -sf /etc/nginx/sites-available/speakline /etc/nginx/sites-enabled/speakline
nginx -t && systemctl reload nginx

( crontab -l 2>/dev/null | grep -v backup.sh; echo "30 3 * * * /srv/speakline/server/deploy/backup.sh" ) | crontab -
chmod +x deploy/backup.sh

sleep 2
echo ">> health:"; curl -fsS "https://$DOMAIN/api/health" && echo
echo ">> DONE. API: https://$DOMAIN"
echo ">> Next: sudo nano /srv/speakline/server/.env  (ANTHROPIC_API_KEY, SONIOX_API_KEY, Paddle keys), then sudo systemctl restart speakline"
