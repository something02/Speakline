# Speakline server

Аккаунты по коду из письма, подписки Paddle, напоминания о конце пробной недели, аналитика воронки.
Один процесс Node.js и файл SQLite. Может сам отдавать веб-приложение, тогда сайт и API живут на одном домене.

## Что делает

| Адрес | Зачем |
|---|---|
| `POST /api/auth/start` | отправить 6-значный код на почту |
| `POST /api/auth/verify` | проверить код, выдать токен входа |
| `GET /api/me` | почта, тариф, статус, дополнения (пакет, Pro) |
| `POST /api/portal` | ссылка на страницу Paddle: отмена, смена карты |
| `DELETE /api/account` | отменить подписку и удалить аккаунт |
| `POST /api/events` | события воронки (без личных данных) |
| `GET /api/stats?key=…` | воронка за 30 дней и подписки по статусам |
| `POST /webhooks/paddle` | уведомления Paddle, подпись проверяется |

Раз в час сервер отправляет письмо тем, у кого пробная неделя заканчивается в ближайшие ~2 дня.

## Проверка локально

```bash
cd server
npm install
npm test                       # 9 проверок: вход, подписи, пробная неделя, возврат, отмена, удаление, защита файлов
DEV_ECHO_CODES=1 PADDLE_WEBHOOK_SECRET=x npm start
```

Без `SMTP_URL` письма не отправляются, а печатаются в лог.

## Запуск на сервере в Казахстане

Закон РК требует хранить персональные данные граждан на территории РК, поэтому сервер — в казахстанском ЦОД (например, VPS у ps.kz или hoster.kz). Хватит 1 vCPU / 1 ГБ RAM / Ubuntu 24.04.

1. **Домен.** Купи домен и направь A-запись на IP сервера.
2. **Установка.**
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx sqlite3 git
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
   sudo useradd -r -s /usr/sbin/nologin speakline
   sudo mkdir -p /srv/speakline /var/lib/speakline && sudo chown speakline /var/lib/speakline
   sudo git clone https://github.com/something02/Speakline.git /srv/speakline
   cd /srv/speakline/server && sudo npm ci --omit=dev
   ```
3. **Настройки.** `sudo cp .env.example .env && sudo nano .env`, затем `sudo chmod 600 .env`.
   `STATIC_DIR=/srv/speakline` — сервер отдаёт приложение и документы.
4. **Служба.**
   ```bash
   sudo cp deploy/speakline.service /etc/systemd/system/
   sudo systemctl enable --now speakline
   curl localhost:8787/api/health
   ```
5. **HTTPS.** Скопируй `deploy/nginx.conf` в `/etc/nginx/sites-available/speakline`, замени домен, включи сайт и выполни `sudo certbot --nginx -d твой-домен`.
6. **Резервные копии.** `sudo crontab -e` → `30 3 * * * /srv/speakline/server/deploy/backup.sh`.

## Paddle

1. Developer tools → **Notifications** → новый адрес: `https://твой-домен/webhooks/paddle`.
   События: `transaction.completed`, `transaction.updated`, `subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `adjustment.created`, `adjustment.updated`.
   Секрет этого адреса → `PADDLE_WEBHOOK_SECRET`.
2. Developer tools → **Authentication** → API key с правами на customers, customer portal sessions и subscriptions → `PADDLE_API_KEY`.
3. ID цен → `PRICE_*` в `.env` и в `PAY.prices` в `index.html`.
4. В `index.html`: `PAY.api = 'https://твой-домен'`, `PAY.token = 'test_…'`.

Секретные ключи живут только в `.env` на сервере. В `index.html` — только публичные значения.

## Переход на реальные деньги

- Юрист проверил оферту, политику и возврат; реквизиты ИП вписаны.
- Боевой аккаунт Paddle прошёл проверку сайта и бизнеса.
- В `.env`: `PADDLE_ENV=production`, боевые ключи и цены. В `index.html`: `PAY.env = 'production'`, токен `live_…`, боевые цены.
- `DEV_ECHO_CODES=0`, настоящий `SMTP_URL` с почтой на своём домене (SPF, DKIM), иначе коды попадут в спам.
- Тестовая покупка своей картой и возврат через Paddle.
