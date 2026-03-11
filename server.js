/**
 * CupDuel — Multiplayer WebSocket Server + PostgreSQL
 * Все данные (баланс, победы, игры, заработок) сохраняются в БД.
 *
 * Railway Variables:
 *   DATABASE_URL  — добавляется автоматически при подключении Postgres
 *   TG_TOKEN      — токен бота от @BotFather (необязательно)
 *   TG_APP_URL    — публичный URL сервиса, напр. https://xxx.up.railway.app (необязательно)
 */

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const { Pool }  = require('pg');

const PORT       = process.env.PORT || 3000;
const COMMISSION = 0.05;

// Токен и URL бота — необязательны, без них игра работает, просто без Telegram-бота
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_APP_URL = process.env.TG_APP_URL || '';

// ─────────────────────────────────────────────
// DATABASE (PostgreSQL)
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      tg_id    BIGINT PRIMARY KEY,
      username TEXT    NOT NULL DEFAULT 'Игрок',
      balance  INTEGER NOT NULL DEFAULT 1000,
      wins     INTEGER NOT NULL DEFAULT 0,
      games    INTEGER NOT NULL DEFAULT 0,
      earned   INTEGER NOT NULL DEFAULT 0
    )
  `);
  console.log('✅ DB ready');
}

async function dbUpsert(tg_id, username) {
  const { rows } = await pool.query(
    `INSERT INTO players (tg_id, username)
     VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [tg_id, username]
  );
  return rows[0];
}

async function dbGet(tg_id) {
  const { rows } = await pool.query('SELECT * FROM players WHERE tg_id=$1', [tg_id]);
  return rows[0] || null;
}

async function dbAddBalance(tg_id, delta) {
  const { rows } = await pool.query(
    'UPDATE players SET balance=balance+$1 WHERE tg_id=$2 RETURNING balance',
    [delta, tg_id]
  );
  return rows[0]?.balance ?? 0;
}

async function dbFinishGame(tg_id, isWinner, earnedDelta) {
  await pool.query(
    `UPDATE players
     SET games  = games  + 1,
         wins   = wins   + $1,
         earned = earned + $2
     WHERE tg_id = $3`,
    [isWinner ? 1 : 0, earnedDelta, tg_id]
  );
}

// ─────────────────────────────────────────────
// TELEGRAM BOT (опционально)
// ─────────────────────────────────────────────
async function tgSend(method, body) {
  if (!TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

async function tgSetWebhook() {
  if (!TG_TOKEN || !TG_APP_URL) return;
  await tgSend('setWebhook', { url: `${TG_APP_URL}/tg` });
  console.log('✅ Telegram webhook set');
}

async function tgWelcome(chat_id, name) {
  await tgSend('sendMessage', {
    chat_id,
    parse_mode: 'Markdown',
    text: `👋 Привет, ${name}!\n\n🥤 *CupDuel* — игра в стаканчики!\n\n⚔️ Выбирай 3 стаканчика из 9, у кого сумма больше — забирает *95%* банка!\n\nБаланс и статистика сохраняются навсегда 💾`,
    reply_markup: TG_APP_URL ? {
      inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: TG_APP_URL } }]]
    } : undefined,
  });
}

function handleTgUpdate(update) {
  const msg = update?.message;
  if (msg) tgWelcome(msg.chat.id, msg.from?.first_name || 'Игрок');
}

// ─────────────────────────────────────────────
// IN-MEMORY (только активные дуэли)
// ─────────────────────────────────────────────
const duels   = new Map();
const clients = new Map(); // tg_id → ws

function genId() {
  return '#' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function score(picks, nums) {
  return picks.reduce((s, i) => s + nums[i], 0);
}

function waitingDuels() {
  return [...duels.values()].filter(d => d.status === 'waiting');
}

// ─────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Telegram webhook
  if (req.method === 'POST' && req.url === '/tg') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { handleTgUpdate(JSON.parse(body)); } catch {}
      res.writeHead(200).end('ok');
    });
    return;
  }
  // Отдаём игру
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(data);
  });
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

const send        = (ws, m)   => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const sendTo      = (id, m)   => send(clients.get(id), m);
const broadcast   = (m)       => wss.clients.forEach(ws => send(ws, m));
const sendBoth    = (d, m)    => { sendTo(d.creator_id, m); sendTo(d.joiner_id, m); };

wss.on('connection', ws => {
  let myId = null;

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    // ── AUTH ──────────────────────────────────
    if (type === 'auth') {
      myId = Number(payload.tg_id);
      clients.set(myId, ws);
      const player = await dbUpsert(myId, payload.username || `Игрок_${myId}`);
      send(ws, { type: 'authed', payload: { player, duels: waitingDuels() } });
      return;
    }

    if (!myId) return;

    // ── CREATE DUEL ───────────────────────────
    if (type === 'create_duel') {
      const stake = Math.max(10, Math.min(10000, Number(payload.stake) || 100));
      const p = await dbGet(myId);
      if (!p || p.balance < stake) { send(ws, { type: 'error', payload: 'Недостаточно монет' }); return; }

      const newBal = await dbAddBalance(myId, -stake);
      const duel = {
        id: genId(), creator_id: myId, joiner_id: null, stake,
        status: 'waiting', nums: null, whose_turn: null,
        picks_a: [], picks_b: [], tb_a: null, tb_b: null,
        tiebreaker: false,
      };
      duels.set(duel.id, duel);
      send(ws, { type: 'duel_created', payload: { duel, balance: newBal } });
      broadcast({ type: 'lobby_add', payload: duel });
      return;
    }

    // ── CANCEL DUEL ───────────────────────────
    if (type === 'cancel_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel || duel.creator_id !== myId || duel.status !== 'waiting') return;
      duels.delete(duel.id);
      const newBal = await dbAddBalance(myId, duel.stake);
      send(ws, { type: 'duel_cancelled', payload: { duel_id: duel.id, balance: newBal } });
      broadcast({ type: 'lobby_remove', payload: { duel_id: duel.id } });
      return;
    }

    // ── JOIN DUEL ─────────────────────────────
    if (type === 'join_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel || duel.status !== 'waiting')  { send(ws, { type: 'error', payload: 'Дуэль недоступна' }); return; }
      if (duel.creator_id === myId)             { send(ws, { type: 'error', payload: 'Это ваша дуэль' }); return; }

      const joiner = await dbGet(myId);
      if (!joiner || joiner.balance < duel.stake) { send(ws, { type: 'error', payload: 'Недостаточно монет' }); return; }

      const joinerBal = await dbAddBalance(myId, -duel.stake);
      const creator   = await dbGet(duel.creator_id);

      duel.joiner_id  = myId;
      duel.status     = 'active';
      duel.nums       = shuffle([1,2,3,4,5,6,7,8,9]);
      duel.whose_turn = duel.creator_id;

      const info = {
        duel, nums: duel.nums,
        creator: { tg_id: creator.tg_id, username: creator.username },
        joiner:  { tg_id: joiner.tg_id,  username: joiner.username  },
      };
      sendTo(duel.creator_id, { type: 'game_start', payload: { ...info, your_role: 'creator' } });
      send(ws,                 { type: 'game_start', payload: { ...info, your_role: 'joiner', balance: joinerBal } });
      broadcast({ type: 'lobby_remove', payload: { duel_id: duel.id } });
      return;
    }

    // ── PICK CUP ──────────────────────────────
    if (type === 'pick_cup') {
      const duel = duels.get(payload.duel_id);
      if (!duel || duel.status !== 'active') { send(ws, { type: 'error', payload: 'Игра не активна' }); return; }
      if (duel.whose_turn !== myId)           { send(ws, { type: 'error', payload: 'Не ваш ход' }); return; }

      const idx = Number(payload.cup_index);
      const used = [...duel.picks_a, ...duel.picks_b,
        ...(duel.tb_a != null ? [duel.tb_a] : []),
        ...(duel.tb_b != null ? [duel.tb_b] : [])];
      if (idx < 0 || idx > 8 || used.includes(idx)) { send(ws, { type: 'error', payload: 'Неверный выбор' }); return; }

      const isCr    = myId === duel.creator_id;
      const nextId  = isCr ? duel.joiner_id : duel.creator_id;

      // тайбрейк
      if (duel.tiebreaker) {
        if (isCr) duel.tb_a = idx; else duel.tb_b = idx;
        if (duel.tb_a != null && duel.tb_b != null) {
          await finishGame(duel); return;
        }
        duel.whose_turn = nextId;
        sendBoth(duel, { type: 'cup_picked', payload: {
          duel_id: duel.id, cup_index: idx, picker_id: myId,
          picks_a: duel.picks_a, picks_b: duel.picks_b,
          tb_a: duel.tb_a, tb_b: duel.tb_b,
          whose_turn: nextId, tiebreaker: true,
        }});
        return;
      }

      // обычный ход
      if (isCr) duel.picks_a.push(idx); else duel.picks_b.push(idx);
      const total = duel.picks_a.length + duel.picks_b.length;

      sendBoth(duel, { type: 'cup_picked', payload: {
        duel_id: duel.id, cup_index: idx, picker_id: myId,
        picks_a: duel.picks_a, picks_b: duel.picks_b,
        tb_a: null, tb_b: null, whose_turn: nextId, tiebreaker: false,
      }});

      if (total < 6) { duel.whose_turn = nextId; return; }

      // все 6 выборов
      const sA = score(duel.picks_a, duel.nums);
      const sB = score(duel.picks_b, duel.nums);
      if (sA === sB) {
        duel.tiebreaker = true;
        duel.whose_turn = duel.creator_id;
        sendBoth(duel, { type: 'tiebreaker', payload: {
          duel_id: duel.id, picks_a: duel.picks_a, picks_b: duel.picks_b,
          score_a: sA, score_b: sB, whose_turn: duel.creator_id,
        }});
      } else {
        await finishGame(duel);
      }
      return;
    }

    // ── GET LOBBY ─────────────────────────────
    if (type === 'get_lobby') {
      send(ws, { type: 'lobby', payload: { duels: waitingDuels() } });
    }
  });

  ws.on('close', () => { if (myId) clients.delete(myId); });
});

// ─────────────────────────────────────────────
// FINISH GAME — сохраняем всё в БД
// ─────────────────────────────────────────────
async function finishGame(duel) {
  const { nums, picks_a, picks_b, tb_a, tb_b, stake, creator_id, joiner_id } = duel;

  const sA = score(picks_a, nums) + (tb_a != null ? nums[tb_a] : 0);
  const sB = score(picks_b, nums) + (tb_b != null ? nums[tb_b] : 0);

  const pot        = stake * 2;
  const commission = Math.floor(pot * COMMISSION);
  const prize      = pot - commission;

  let winnerId = null;
  let balA, balB;

  if (sA > sB)      { winnerId = creator_id; }
  else if (sB > sA) { winnerId = joiner_id;  }

  // Обновляем балансы в БД
  if (winnerId === creator_id) {
    balA = await dbAddBalance(creator_id, prize);
    balB = (await dbGet(joiner_id))?.balance ?? 0;
  } else if (winnerId === joiner_id) {
    balB = await dbAddBalance(joiner_id, prize);
    balA = (await dbGet(creator_id))?.balance ?? 0;
  } else {
    // ничья — возврат
    balA = await dbAddBalance(creator_id, stake);
    balB = await dbAddBalance(joiner_id,  stake);
  }

  // Сохраняем статистику
  await dbFinishGame(creator_id, winnerId === creator_id, winnerId === creator_id ? prize - stake : 0);
  await dbFinishGame(joiner_id,  winnerId === joiner_id,  winnerId === joiner_id  ? prize - stake : 0);

  duel.status = 'finished';

  sendBoth(duel, {
    type: 'game_over',
    payload: {
      duel_id: duel.id, winner_id: winnerId,
      score_a: sA, score_b: sB,
      picks_a, picks_b, tb_a, tb_b, nums,
      prize, commission, total_pot: pot,
      balances: { [creator_id]: balA, [joiner_id]: balB },
    },
  });

  setTimeout(() => duels.delete(duel.id), 30_000);
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function main() {
  if (process.env.DATABASE_URL) {
    await dbInit();
  } else {
    console.warn('⚠️  DATABASE_URL не задан — данные не сохраняются между перезапусками');
  }

  server.listen(PORT, async () => {
    console.log(`✅ CupDuel on http://localhost:${PORT}`);
    await tgSetWebhook();
  });
}

main().catch(err => { console.error(err); process.exit(1); });
