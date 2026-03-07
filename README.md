# CupDuel 🥤⚔️

Мультиплеерная игра в стаканчики — Telegram Mini App.

## Структура

```
cupduel/
├── server.js       ← WebSocket + HTTP сервер (всё в памяти)
├── package.json
└── public/
    └── index.html  ← Клиент
```

---

## Деплой на Railway (5 минут)

1. Залей папку на GitHub
2. Зайди на [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Выбери репозиторий — Railway сам запустит `npm start`
4. В настройках проекта: **Settings → Networking → Generate Domain** — получишь публичный URL вида `cupduel.up.railway.app`

> ⚠️ **Важно:** Скопируй этот URL и вставь его в Telegram BotFather при создании Mini App (`/newapp`).

---

## Деплой на Render

1. Зайди на [render.com](https://render.com) → **New → Web Service**
2. Подключи GitHub репозиторий
3. Build Command: *(оставь пустым)*
4. Start Command: `npm start`
5. Бесплатный план подходит для теста

---

## Локальный тест

```bash
npm install
node server.js
```

Открой `http://localhost:3000` в **двух разных вкладках** — каждый получит случайный ID и сможет играть против другого.

---

## Подключение к Telegram

```
1. @BotFather → /newbot → получи токен
2. @BotFather → /newapp → укажи URL твоего сервера
3. Готово — открывай Mini App в Telegram
```

---

## Примечание

Данные хранятся **только в памяти** — при перезапуске сервера балансы и история сбрасываются. Для продакшена с сохранением данных добавь базу данных (например, Railway PostgreSQL или SQLite).
