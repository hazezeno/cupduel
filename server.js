/**
 * CupDuel — WebSocket Server + Telegram Bot
 *
 * Переменные окружения в Railway:
 *   BOT_TOKEN = токен от @BotFather
 *   APP_URL   = https://ВАШ_ДОМЕН.up.railway.app
 */

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const PORT       = process.env.PORT || 3000;
const COMMISSION = 0.05;
const BOT_TOKEN  = process.env.BOT_TOKEN || '';
const APP_URL    = process.env.APP_URL   || '';

// ─────────────────────────────────────────────
// TELEGRAM BOT
// ─────────────────────────────────────────────
async function tgApi(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return res.json();
  } catch (e) {
    console.error('Telegram API error:', e.message);
    return null;
  }
}

async function sendWelcome(chat_id, first_name) {
  await tgApi('sendMessage', {
    chat_id,
    text: `👋 Привет, ${first_name}!\n\n🥤 Добро пожаловать в *CupDuel* — игру в стаканчики!\n\n⚔️ Правила просты:\n• 9 стаканчиков, под каждым цифра 1–9\n• Каждый игрок выбирает 3 стаканчика\n• У кого сумма больше — тот забирает *95%* банка!\n\n👇 Нажми кнопку и вступай в дуэль:`,
    parse_mode: 'Markdown',
    reply_markup: APP_URL ? {
      inline_keyboard: [[
        { text: '🎮 Играть в CupDuel', web_app: { url: APP_URL } }
      ]]
    } : undefined,
  });
}

async function setWebhook() {
  if (!BOT_TOKEN || !APP_URL) {
    console.log('⚠️  BOT_TOKEN или APP_URL не заданы — бот не активирован');
    return;
  }
  const result = await tgApi('setWebhook', { url: `${APP_URL}/tg-webhook` });
  console.log('✅ Telegram webhook:', result?.description || JSON.stringify(result));
}

function handleTgUpdate(update) {
  const msg = update?.message;
  if (!msg) return;
  const first_name = msg.from?.first_name || 'Игрок';
  sendWelcome(msg.chat.id, first_name);
}

// ─────────────────────────────────────────────
// IN-MEMORY STORE
// ─────────────────────────────────────────────
const players = new Map();
const duels   = new Map();
const clients = new Map();

function getOrCreatePlayer(tg_id, username, avatar) {
  if (!players.has(tg_id)) {
    players.set(tg_id, {
      tg_id,
      username: username || `Игрок_${tg_id}`,
      avatar:   avatar   || '🎮',
      balance:  1000,
      wins:     0,
      games:    0,
      earned:   0,
    });
  } else {
    const p = players.get(tg_id);
    if (username) p.username = username;
  }
  return players.get(tg_id);
}

function genId() {
  return '#' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function calcScore(picks, nums) {
  return picks.reduce((s, i) => s + nums[i], 0);
}

function getWaitingDuels() {
  return [...duels.values()].filter(d => d.status === 'waiting');
}

// ─────────────────────────────────────────────
// HTTP — index.html + Telegram webhook
// ─────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // Telegram webhook endpoint
  if (req.method === 'POST' && req.url === '/tg-webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { handleTgUpdate(JSON.parse(body)); } catch {}
      res.writeHead(200).end('ok');
    });
    return;
  }

  // Отдаём index.html
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function send(ws, msg)   { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function sendTo(id, msg) { send(clients.get(id), msg); }
function broadcast(msg)  { wss.clients.forEach(ws => send(ws, msg)); }
function broadcastGame(duel, msg) {
  sendTo(duel.creator_id, msg);
  if (duel.joiner_id) sendTo(duel.joiner_id, msg);
}

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    if (type === 'auth') {
      myId = Number(payload.tg_id);
      clients.set(myId, ws);
      const player = getOrCreatePlayer(myId, payload.username, payload.avatar);
      send(ws, { type: 'authed', payload: { player, duels: getWaitingDuels() } });
      return;
    }

    if (!myId) return;
    const player = players.get(myId);
    if (!player) return;

    if (type === 'create_duel') {
      const stake = Math.max(10, Math.min(10000, Number(payload.stake) || 100));
      if (player.balance < stake) { send(ws, { type: 'error', payload: 'Недостаточно монет' }); return; }
      player.balance -= stake;
      const id   = genId();
      const duel = { id, creator_id: myId, joiner_id: null, stake,
                     status: 'waiting', nums: null, whose_turn: null,
                     picks_a: [], picks_b: [], tb_a: null, tb_b: null,
                     tiebreaker: false, winner_id: null };
      duels.set(id, duel);
      send(ws, { type: 'duel_created', payload: { duel, balance: player.balance } });
      broadcast({ type: 'lobby_new_duel', payload: duel });
      return;
    }

    if (type === 'cancel_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel || duel.creator_id !== myId || duel.status !== 'waiting') return;
      duels.delete(duel.id);
      player.balance += duel.stake;
      send(ws, { type: 'duel_cancelled', payload: { duel_id: duel.id, balance: player.balance } });
      broadcast({ type: 'lobby_remove_duel', payload: { duel_id: duel.id } });
      return;
    }

    if (type === 'join_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel)                       { send(ws, { type: 'error', payload: 'Дуэль не найдена' }); return; }
      if (duel.status !== 'waiting')   { send(ws, { type: 'error', payload: 'Дуэль уже началась' }); return; }
      if (duel.creator_id === myId)    { send(ws, { type: 'error', payload: 'Нельзя войти в свою дуэль' }); return; }
      if (player.balance < duel.stake) { send(ws, { type: 'error', payload: 'Недостаточно монет' }); return; }
      player.balance  -= duel.stake;
      duel.joiner_id   = myId;
      duel.status      = 'active';
      duel.nums        = shuffleArr([1,2,3,4,5,6,7,8,9]);
      duel.whose_turn  = duel.creator_id;
      const creator = players.get(duel.creator_id);
      const joiner  = player;
      const gamePayload = {
        duel, nums: duel.nums,
        creator: { tg_id: creator.tg_id, username: creator.username, avatar: creator.avatar },
        joiner:  { tg_id: joiner.tg_id,  username: joiner.username,  avatar: joiner.avatar  },
      };
      sendTo(duel.creator_id, { type: 'game_start', payload: { ...gamePayload, your_role: 'creator' } });
      send(ws,                 { type: 'game_start', payload: { ...gamePayload, your_role: 'joiner', balance: joiner.balance } });
      broadcast({ type: 'lobby_remove_duel', payload: { duel_id: duel.id } });
      return;
    }

    if (type === 'pick_cup') {
      const duel = duels.get(payload.duel_id);
      if (!duel || duel.status !== 'active') { send(ws, { type: 'error', payload: 'Игра не активна' }); return; }
      if (duel.whose_turn !== myId)           { send(ws, { type: 'error', payload: 'Не ваш ход' }); return; }

      const idx       = Number(payload.cup_index);
      const allPicked = [...duel.picks_a, ...duel.picks_b,
                         ...(duel.tb_a != null ? [duel.tb_a] : []),
                         ...(duel.tb_b != null ? [duel.tb_b] : [])];
      if (idx < 0 || idx > 8 || allPicked.includes(idx)) {
        send(ws, { type: 'error', payload: 'Неверный выбор' }); return;
      }

      const isCreator = myId === duel.creator_id;
      const nextTurn  = isCreator ? duel.joiner_id : duel.creator_id;

      if (duel.tiebreaker) {
        if (isCreator) duel.tb_a = idx; else duel.tb_b = idx;
        if (duel.tb_a != null && duel.tb_b != null) {
          resolveGame(duel);
        } else {
          duel.whose_turn = nextTurn;
          broadcastGame(duel, { type: 'cup_picked', payload: {
            duel_id: duel.id, cup_index: idx, picker_id: myId,
            picks_a: duel.picks_a, picks_b: duel.picks_b,
            tb_a: duel.tb_a, tb_b: duel.tb_b,
            whose_turn: nextTurn, tiebreaker: true,
          }});
        }
        return;
      }

      if (isCreator) duel.picks_a.push(idx); else duel.picks_b.push(idx);
      const total = duel.picks_a.length + duel.picks_b.length;

      broadcastGame(duel, { type: 'cup_picked', payload: {
        duel_id: duel.id, cup_index: idx, picker_id: myId,
        picks_a: duel.picks_a, picks_b: duel.picks_b,
        tb_a: null, tb_b: null, whose_turn: nextTurn, tiebreaker: false,
      }});

      if (total < 6) {
        duel.whose_turn = nextTurn;
        return;
      }

      const sA = calcScore(duel.picks_a, duel.nums);
      const sB = calcScore(duel.picks_b, duel.nums);

      if (sA === sB) {
        duel.tiebreaker = true;
        duel.whose_turn = duel.creator_id;
        broadcastGame(duel, { type: 'tiebreaker', payload: {
          duel_id: duel.id, picks_a: duel.picks_a, picks_b: duel.picks_b,
          score_a: sA, score_b: sB, whose_turn: duel.creator_id,
        }});
      } else {
        resolveGame(duel);
      }
      return;
    }

    if (type === 'get_lobby') {
      send(ws, { type: 'lobby', payload: { duels: getWaitingDuels() } });
    }
  });

  ws.on('close', () => { if (myId) clients.delete(myId); });
});

// ─────────────────────────────────────────────
// GAME RESOLUTION
// ─────────────────────────────────────────────
function resolveGame(duel) {
  const { nums, picks_a, picks_b, tb_a, tb_b, stake, creator_id, joiner_id } = duel;
  const scoreA     = calcScore(picks_a, nums) + (tb_a != null ? nums[tb_a] : 0);
  const scoreB     = calcScore(picks_b, nums) + (tb_b != null ? nums[tb_b] : 0);
  const totalPot   = stake * 2;
  const commission = Math.floor(totalPot * COMMISSION);
  const prize      = totalPot - commission;
  const creator    = players.get(creator_id);
  const joiner     = players.get(joiner_id);

  let winnerId = null;
  if      (scoreA > scoreB) { winnerId = creator_id; creator.balance += prize; }
  else if (scoreB > scoreA) { winnerId = joiner_id;  joiner.balance  += prize; }
  else                      { creator.balance += stake; joiner.balance += stake; }

  const upd = (p, isWin) => { p.games++; if (isWin) { p.wins++; p.earned += prize - stake; } };
  upd(creator, winnerId === creator_id);
  upd(joiner,  winnerId === joiner_id);

  duel.status    = 'finished';
  duel.winner_id = winnerId;

  broadcastGame(duel, {
    type: 'game_over',
    payload: {
      duel_id: duel.id, winner_id: winnerId,
      score_a: scoreA,  score_b: scoreB,
      picks_a, picks_b, tb_a, tb_b, nums,
      prize, commission, total_pot: totalPot,
      balances: { [creator_id]: creator.balance, [joiner_id]: joiner.balance },
    },
  });

  setTimeout(() => duels.delete(duel.id), 30_000);
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`✅ CupDuel running on http://localhost:${PORT}`);
  await setWebhook();
});
