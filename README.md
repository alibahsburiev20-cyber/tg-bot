# TG Channel Bot — автопостинг в Telegram-канал

Cloudflare Worker: генерирует посты через Workers AI и публикует их в Telegram-канал по расписанию (cron), плюс постит объявления в чаты-биржи из твоего списка.

## Что нужно настроить в GitHub (один раз)

### 1. Секреты репозитория
Repo → Settings → Secrets and variables → Actions → New repository secret:

- `CLOUDFLARE_API_TOKEN` — токен из Cloudflare Dashboard → My Profile → API Tokens → Create Token (шаблон "Edit Cloudflare Workers")
- `CLOUDFLARE_ACCOUNT_ID` — из Cloudflare Dashboard → правая панель на главной странице аккаунта

### 2. Секреты самого Worker'а (не в GitHub, а в Cloudflare)
После первого деплоя зайди в Cloudflare Dashboard → Workers & Pages → tg-channel-bot → Settings → Variables, добавь как **Secret** (encrypted):

- `TELEGRAM_BOT_TOKEN` — токен от @BotFather
- `CHANNEL_USERNAME` — `@hakeronme`

### 3. Деплой
Просто сделай commit/push в ветку `main` — GitHub Actions задеплоит автоматически. Либо зайди в Actions → Deploy Worker → Run workflow для ручного запуска.

## Проверка

После деплоя открой в браузере:
- `https://tg-channel-bot.<твой-субдомен>.workers.dev/run-content` — сгенерирует и опубликует пост прямо сейчас
- `https://tg-channel-bot.<твой-субдомен>.workers.dev/run-ads` — опубликует объявления в чаты (если добавлены в таблицу ad_chats)

Cron уже настроен на каждые 4 часа автоматически (см. wrangler.toml).

## Важно перед первым запуском

Бот должен быть добавлен **администратором** в канал @hakeronme с правом публикации сообщений.
