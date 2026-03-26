require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const TG_APP_URL = process.env.TG_APP_URL || 'https://t.me/your_bot/app';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required');
  process.exit(1);
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../mini-app/public')));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Validate Telegram WebApp init data
function validateTelegramAuth(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    
    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    
    if (hash !== expectedHash) return null;
    
    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch {
    return null;
  }
}

// Auth middleware for REST endpoints
function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'Unauthorized' });
  
  const user = validateTelegramAuth(initData);
  if (!user || !user.id) return res.status(401).json({ error: 'Invalid auth' });
  
  req.telegramUser = user;
  req.player = db.getOrCreatePlayer(
    String(user.id),
    user.username,
    user.first_name
  );
  next();
}

// REST API
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ player: req.player });
});

app.get('/api/duels', authMiddleware, (req, res) => {
  const duels = db.getActiveDuels();
  res.json({ duels });
});

app.post('/api/duels', authMiddleware, (req, res) => {
  const { bet } = req.body;
  if (!bet || bet < 10) return res.status(400).json({ error: 'Минимальная ставка 10 монет' });
  if (req.player.balance < bet) return res.status(400).json({ error: 'Недостаточно монет' });
  
  const duel = db.createDuel(String(req.telegramUser.id), bet);
  broadcast({ type: 'duel_created', duel });
  res.json({ duel });
});

app.post('/api/duels/:id/join', authMiddleware, (req, res) => {
  const duel = db.joinDuel(parseInt(req.params.id), String(req.telegramUser.id));
  if (!duel) return res.status(400).json({ error: 'Не удалось присоединиться' });
  
  broadcast({ type: 'duel_updated', duel });
  notifyDuelPlayers(duel.id, { type: 'duel_started', duel });
  res.json({ duel });
});

app.post('/api/duels/:id/pick', authMiddleware, (req, res) => {
  const { cupIndex } = req.body;
  if (cupIndex === undefined) return res.status(400).json({ error: 'Нужен индекс стаканчика' });
  
  const result = db.makePick(parseInt(req.params.id), String(req.telegramUser.id), cupIndex);
  if (result.error) return res.status(400).json(result);
  
  notifyDuelPlayers(result.duel.id, { type: 'game_update', ...result });
  
  if (result.phase === 'finished') {
    broadcast({ type: 'duel_finished', duelId: result.duel.id });
  }
  
  res.json(result);
});

app.post('/api/duels/:id/cancel', authMiddleware, (req, res) => {
  const duel = db.cancelDuel(parseInt(req.params.id), String(req.telegramUser.id));
  if (!duel) return res.status(400).json({ error: 'Нельзя отменить' });
  
  broadcast({ type: 'duel_cancelled', duelId: duel.id });
  res.json({ duel });
});

app.get('/api/leaderboard', authMiddleware, (req, res) => {
  const players = db.getTopPlayers(20);
  res.json({ players });
});

app.get('/api/duels/:id', authMiddleware, (req, res) => {
  const duel = db.getDuel(parseInt(req.params.id));
  if (!duel) return res.status(404).json({ error: 'Не найдено' });
  res.json({ duel });
});

// ─── HTTP + WS SERVER ────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // telegramId -> Set<ws>
const duelRooms = new Map(); // duelId -> Set<telegramId>

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function notifyDuelPlayers(duelId, data) {
  const duel = db.getDuel(duelId);
  if (!duel) return;
  
  const msg = JSON.stringify(data);
  const participants = [duel.player1_id, duel.player2_id].filter(Boolean);
  
  participants.forEach(pid => {
    const playerWs = clients.get(pid);
    if (playerWs) {
      playerWs.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      });
    }
  });
}

wss.on('connection', (ws, req) => {
  let telegramId = null;
  
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      
      if (msg.type === 'auth') {
        const user = validateTelegramAuth(msg.initData);
        if (!user) { ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' })); return; }
        
        telegramId = String(user.id);
        db.getOrCreatePlayer(telegramId, user.username, user.first_name);
        
        if (!clients.has(telegramId)) clients.set(telegramId, new Set());
        clients.get(telegramId).add(ws);
        
        ws.send(JSON.stringify({ type: 'auth_ok', telegramId }));
      }
      
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {}
  });
  
  ws.on('close', () => {
    if (telegramId && clients.has(telegramId)) {
      clients.get(telegramId).delete(ws);
      if (clients.get(telegramId).size === 0) clients.delete(telegramId);
    }
  });
});

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'Игрок';
  
  db.getOrCreatePlayer(String(msg.from.id), msg.from.username, msg.from.first_name);
  
  bot.sendMessage(chatId,
    `🎲 *Добро пожаловать в CupDuel, ${name}!*\n\n` +
    `Выбирай стаканчики, угадывай числа и забирай банк!\n\n` +
    `🏆 Правила:\n` +
    `• 9 стаканчиков с числами 1–9\n` +
    `• 2 игрока выбирают по 3 стаканчика\n` +
    `• Больше сумма — забираешь 95% банка\n` +
    `• Ничья → тайбрейк: по 1 стаканчику\n\n` +
    `💰 Стартовый баланс: 1000 монет`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎮 Играть', web_app: { url: TG_APP_URL } }
        ]]
      }
    }
  );
});

// Admin commands
bot.onText(/\/players/, (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  
  const players = db.getTopPlayers(20);
  if (players.length === 0) return bot.sendMessage(msg.chat.id, 'Нет игроков');
  
  const text = players.map((p, i) => {
    const name = p.username ? `@${p.username}` : (p.first_name || p.telegram_id);
    return `${i + 1}. ${name} — 💰 ${p.balance} (W:${p.total_wins} L:${p.total_losses})`;
  }).join('\n');
  
  bot.sendMessage(msg.chat.id, `🏆 *Топ игроков:*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/givetokens (\S+) (\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  
  const targetId = match[1];
  const amount = parseInt(match[2]);
  
  const player = db.addTokens(targetId, amount);
  if (!player) return bot.sendMessage(msg.chat.id, `❌ Игрок ${targetId} не найден`);
  
  bot.sendMessage(msg.chat.id, `✅ Выдано ${amount} монет игроку ${targetId}. Баланс: ${player.balance}`);
});

bot.onText(/\/setbalance (\S+) (\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  
  const targetId = match[1];
  const amount = parseInt(match[2]);
  
  const player = db.setBalance(targetId, amount);
  if (!player) return bot.sendMessage(msg.chat.id, `❌ Игрок ${targetId} не найден`);
  
  bot.sendMessage(msg.chat.id, `✅ Баланс игрока ${targetId} установлен: ${player.balance} монет`);
});

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 CupDuel server running on port ${PORT}`);
  console.log(`🤖 Telegram bot polling...`);
});
