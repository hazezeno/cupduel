# 🥤 CupDuel

> Telegram Mini App — дуэли на монеты с угадыванием стаканчиков

## Как играть

- 9 стаканчиков со скрытыми числами **1–9** (не повторяются)
- 2 игрока по очереди выбирают по **3 стаканчика**
- Кто набрал **больше сумму** — забирает **95% банка**
- При **ничье** — тайбрейк: каждый выбирает ещё по 1 стаканчику

---

## Структура проекта

```
cupduel/
├── server/
│   ├── index.js        # Express + WebSocket + Telegram Bot
│   ├── db.js           # SQLite база данных
│   └── package.json
├── mini-app/
│   └── public/
│       └── index.html  # Telegram Mini App (фронтенд)
├── Dockerfile          # Для Railway
├── railway.toml        # Railway конфиг
└── .env.example        # Пример переменных окружения
```

---

## Быстрый старт

### 1. Создай бота

1. Напиши [@BotFather](https://t.me/BotFather) → `/newbot`
2. Скопируй **BOT_TOKEN**
3. Создай Web App: `/newapp` → выбери бота → укажи URL после деплоя

### 2. Настрой переменные

```bash
cp .env.example .env
# Заполни .env своими значениями
```

### 3. Локальный запуск

```bash
cd server
npm install
node index.js
```

---

## Деплой на Railway

### Через GitHub

1. Запушь проект на GitHub
2. Зайди на [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Добавь переменные в Railway Dashboard → **Variables**:

| Переменная | Значение |
|------------|----------|
| `BOT_TOKEN` | Токен от BotFather |
| `ADMIN_ID` | Твой Telegram ID |
| `DATABASE_URL` | `/data/cupduel.db` |
| `TG_APP_URL` | URL твоего Mini App |
| `START_BALANCE` | `1000` (тест) или `0` |

4. Railway автоматически определит `Dockerfile`
5. После деплоя скопируй URL и обнови `TG_APP_URL`

### Volume для базы данных

В Railway → твой сервис → **Volumes** → Add Volume:
- Mount path: `/data`

---

## Команды бота

### Для всех
| Команда | Описание |
|---------|----------|
| `/start` | Приветствие + кнопка в игру |

### Только для админа (ADMIN_ID)
| Команда | Описание |
|---------|----------|
| `/players` | Топ 20 игроков по балансу |
| `/givetokens <ID> <сумма>` | Выдать монеты игроку |
| `/setbalance <ID> <сумма>` | Установить точный баланс |

**Пример:**
```
/givetokens 123456789 500
/setbalance 123456789 1000
```

> ID игрока — это его Telegram User ID

---

## Механика игры

```
Ставка: 100 монет
Банк: 200 монет
Комиссия: 5% (10 монет)
Приз победителю: 190 монет
```

### Тайбрейк
Если суммы равны → каждый выбирает ещё 1 стаканчик из оставшихся 3-х.
Если снова ничья — тайбрейк повторяется.

---

## Убрать стартовые монеты

В файле `server/db.js` найди блок:
```js
// ==== TESTING FEATURE: START BALANCE ====
const START_BALANCE = parseInt(process.env.START_BALANCE ?? '1000', 10);
// ==== END TESTING FEATURE ====
```

Чтобы отключить: установи `START_BALANCE=0` в переменных окружения.
Чтобы удалить совсем: замени значение на `0` прямо в коде и удели комментарии.

---

## WebSocket события

| Событие | Описание |
|---------|----------|
| `duel_created` | Новая дуэль появилась в лобби |
| `duel_started` | Соперник присоединился |
| `game_update` | Игрок выбрал стаканчик |
| `duel_finished` | Игра завершена |
| `duel_cancelled` | Дуэль отменена |

---

## Технологии

- **Node.js** — сервер
- **Express** — REST API
- **ws** — WebSocket
- **better-sqlite3** — база данных
- **node-telegram-bot-api** — Telegram Bot
- **Telegram WebApp JS** — Mini App SDK
