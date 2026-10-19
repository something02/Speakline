#!/bin/sh
# daily SQLite backup, keeps 14 days. cron: 30 3 * * * /srv/speakline/server/deploy/backup.sh
set -e
mkdir -p /var/backups/speakline
sqlite3 /var/lib/speakline/speakline.db ".backup '/var/backups/speakline/speakline-$(date +%F).db'"
find /var/backups/speakline -name 'speakline-*.db' -mtime +14 -delete
