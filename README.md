# CupDuel 🥤⚔️

## Переменные окружения в Railway

После деплоя зайди в **Variables** и добавь:

| Переменная | Значение | Описание |
|---|---|---|
| `BOT_TOKEN` | `123456:ABC...` | Токен от @BotFather |
| `APP_URL` | `https://cupduel.up.railway.app` | Твой домен на Railway |

> `PORT` Railway выставляет сам — не трогай.

## Как получить BOT_TOKEN

1. Напиши @BotFather в Telegram
2. `/newbot` → придумай имя → получи токен
3. Вставь токен в Variables на Railway

## Как получить APP_URL

В Railway: **Settings → Networking → Generate Domain** → скопируй ссылку.

## Как подключить Mini App

1. @BotFather → `/newapp`
2. Выбери своего бота
3. Вставь `APP_URL` как ссылку на приложение

## Локальный тест

```bash
npm install
node server.js
# Открой http://localhost:3000 в двух вкладках
```
