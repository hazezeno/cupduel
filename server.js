/**
 * CupDuel — WebSocket Server
 * Работает с PostgreSQL (если DATABASE_URL задан) или без него (данные в памяти)
 */

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const PORT       = process.env.PORT || 3000;
const COMMISSION = 0.05;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_APP_URL = process.env.TG_APP_URL || '';
const ADMIN_ID   = Number(process.env.ADMIN_ID) || 0; // твой Telegram ID

// ─────────────────────────────────────────────
// DATABASE — PostgreSQL или память
// ─────────────────────────────────────────────
let pool = null;
const memPlayers = new Map(); // fallback если нет БД

async function dbInit() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️  Нет DATABASE_URL — используем память');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        tg_id       BIGINT PRIMARY KEY,
        username    TEXT    NOT NULL DEFAULT 'Игрок',
        tg_username TEXT,
        balance     INTEGER NOT NULL DEFAULT 1000,
        wins        INTEGER NOT NULL DEFAULT 0,
        games       INTEGER NOT NULL DEFAULT 0,
        earned      INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Добавить колонку если её нет (для существующих БД)
    await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS tg_username TEXT').catch(()=>{});
    console.log('✅ PostgreSQL подключён');
  } catch (e) {
    console.error('❌ PostgreSQL ошибка:', e.message);
    pool = null;
  }
}

async function dbUpsert(tg_id, username, tg_username) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO players (tg_id, username, tg_username) VALUES ($1, $2, $3)
       ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username, tg_username = COALESCE(EXCLUDED.tg_username, players.tg_username)
       RETURNING *`,
      [tg_id, username, tg_username || null]
    );
    return rows[0];
  }
  // память
  if (!memPlayers.has(tg_id)) {
    memPlayers.set(tg_id, { tg_id, username, balance: 1000, wins: 0, games: 0, earned: 0 });
  } else {
    memPlayers.get(tg_id).username = username;
  }
  return memPlayers.get(tg_id);
}

async function dbGet(tg_id) {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM players WHERE tg_id=$1', [tg_id]);
    return rows[0] || null;
  }
  return memPlayers.get(tg_id) || null;
}

async function dbAddBalance(tg_id, delta) {
  if (pool) {
    const { rows } = await pool.query(
      'UPDATE players SET balance=balance+$1 WHERE tg_id=$2 RETURNING balance',
      [delta, tg_id]
    );
    return rows[0]?.balance ?? 0;
  }
  const p = memPlayers.get(tg_id);
  if (p) p.balance += delta;
  return p?.balance ?? 0;
}

async function dbFinishGame(tg_id, isWinner, earned) {
  if (pool) {
    await pool.query(
      `UPDATE players SET games=games+1, wins=wins+$1, earned=earned+$2 WHERE tg_id=$3`,
      [isWinner ? 1 : 0, earned, tg_id]
    );
    return;
  }
  const p = memPlayers.get(tg_id);
  if (p) { p.games++; if (isWinner) { p.wins++; p.earned += earned; } }
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

async function handleTgUpdate(update) {
  const msg = update?.message;
  if (!msg) return;

  const text     = msg.text || '';
  const fromId   = Number(msg.from?.id);
  const chatId   = msg.chat.id;

  console.log(`TG update from ${fromId}, ADMIN_ID=${ADMIN_ID}, match=${fromId === ADMIN_ID}`);

  // ── /givetokens @username сумма ──────────────────
  if (text.startsWith('/givetokens')) {
    if (fromId !== ADMIN_ID) {
      await tgSend('sendMessage', { chat_id: chatId, text: '❌ У вас нет прав для этой команды.' });
      return;
    }
    // Парсим: /givetokens @ник 500  или  /givetokens ник 500
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
      await tgSend('sendMessage', { chat_id: chatId, text: '❌ Формат: /givetokens @username 500' });
      return;
    }
    const rawTarget = parts[1].replace('@', '');
    const amount    = parseInt(parts[2]);
    if (!amount || amount <= 0) {
      await tgSend('sendMessage', { chat_id: chatId, text: '❌ Укажи правильную сумму.' });
      return;
    }
    if (!pool) {
      await tgSend('sendMessage', { chat_id: chatId, text: '❌ База данных недоступна.' });
      return;
    }
    // Ищем по ID (если число) или по tg_username / display name
    const isId = /^\d+$/.test(rawTarget);
    let queryRows;
    if (isId) {
      const r = await pool.query('SELECT * FROM players WHERE tg_id = $1', [Number(rawTarget)]);
      queryRows = r.rows;
    } else {
      // Сначала ищем по Telegram username, потом по display name
      const r1 = await pool.query('SELECT * FROM players WHERE LOWER(tg_username) = $1', [rawTarget.toLowerCase()]);
      if (r1.rows.length) {
        queryRows = r1.rows;
      } else {
        const r2 = await pool.query('SELECT * FROM players WHERE LOWER(username) = $1', [rawTarget.toLowerCase()]);
        queryRows = r2.rows;
      }
    }
    const rows = queryRows;
    if (!rows.length) {
      await tgSend('sendMessage', {
        chat_id: chatId,
        parse_mode: 'Markdown',
        text: `❌ Игрок *${rawTarget}* не найден.\nОн должен хотя бы раз зайти в игру.`,
      });
      return;
    }
    const player = rows[0];
    const newBal = await dbAddBalance(player.tg_id, amount);
    // Уведомляем админа
    await tgSend('sendMessage', {
      chat_id: chatId,
      parse_mode: 'Markdown',
      text: `✅ Выдано *${amount}* монет игроку *${player.username}*\nНовый баланс: *${newBal}* монет`,
    });
    // Уведомляем игрока если он онлайн в WS
    const playerWs = clients.get(player.tg_id);
    if (playerWs) {
      playerWs.send(JSON.stringify({
        type: 'balance_update',
        payload: { balance: newBal, reason: `🎁 Администратор выдал вам ${amount} монет!` }
      }));
    }
    return;
  }

  // ── /addme — принудительно добавить себя в БД ──
  if (text.startsWith('/addme')) {
    if (!pool) { await tgSend('sendMessage', { chat_id: chatId, text: '❌ БД недоступна.' }); return; }
    const name = msg.from?.first_name || msg.from?.username || 'Игрок';
    const { rows } = await pool.query(
      `INSERT INTO players (tg_id, username) VALUES ($1, $2)
       ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [fromId, name]
    );
    const p = rows[0];
    await tgSend('sendMessage', {
      chat_id: chatId,
      parse_mode: 'Markdown',
      text: `✅ Ты добавлен в базу!

*ID:* \`${p.tg_id}\`
*Имя:* ${p.username}
*Баланс:* ${p.balance} монет`,
    });
    return;
  }

  // ── /players — список игроков (только для админа) ──
  if (text.startsWith('/players')) {
    if (fromId !== ADMIN_ID) return;
    if (!pool) { await tgSend('sendMessage', { chat_id: chatId, text: '❌ БД недоступна.' }); return; }
    const { rows } = await pool.query('SELECT username, balance, wins, games FROM players ORDER BY balance DESC LIMIT 20');
    if (!rows.length) { await tgSend('sendMessage', { chat_id: chatId, text: 'Нет игроков.' }); return; }
    const list = rows.map((p,i) => `${i+1}. *${p.username}* — ${p.balance} монет (побед: ${p.wins}/${p.games})`).join('\n');
    await tgSend('sendMessage', { chat_id: chatId, parse_mode: 'Markdown', text: `👥 *Топ игроков:*\n\n${list}` });
    return;
  }

  // ── Обычное приветствие + авторегистрация ───────────────────────────
  // Регистрируем игрока в БД при любом сообщении боту
  if (pool && fromId) {
    const name = msg.from?.first_name || msg.from?.username || 'Игрок';
    try {
      await pool.query(
        `INSERT INTO players (tg_id, username) VALUES ($1, $2)
         ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username`,
        [fromId, name]
      );
      console.log('Auto-registered: ' + fromId + ' (' + name + ')');
    } catch(e) {
      console.error('Auto-register error: ' + e.message);
    }
  }
  tgSend('sendMessage', {
    chat_id: chatId,
    parse_mode: 'Markdown',
    text: `👋 Привет, ${msg.from?.first_name || 'Игрок'}!\n\n🥤 *CupDuel* — игра в стаканчики!\n\nВыбирай 3 стаканчика из 9, у кого сумма больше — забирает *95%* банка!`,
    reply_markup: TG_APP_URL ? {
      inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: TG_APP_URL } }]]
    } : undefined,
  });
}

// ─────────────────────────────────────────────
// IN-MEMORY (активные дуэли)
// ─────────────────────────────────────────────
const duels   = new Map();
const clients = new Map();

function genId() { return '#' + Math.random().toString(36).substr(2,6).toUpperCase(); }
function shuffle(arr) {
  const a = [...arr];
  for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function score(picks, nums) { return picks.reduce((s,i)=>s+nums[i],0); }
function waitingDuels() { return [...duels.values()].filter(d=>d.status==='waiting'); }

// ─────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method==='POST' && req.url==='/tg') {
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{ try{handleTgUpdate(JSON.parse(body));}catch{} res.writeHead(200).end('ok'); });
    return;
  }
  fs.readFile(path.join(__dirname,'public','index.html'), (err,data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(data);
  });
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const send     = (ws,m)  => ws?.readyState===1 && ws.send(JSON.stringify(m));
const sendTo   = (id,m)  => send(clients.get(id),m);
const broadcast= (m)     => wss.clients.forEach(ws=>send(ws,m));
const sendBoth = (d,m)   => { sendTo(d.creator_id,m); sendTo(d.joiner_id,m); };

wss.on('connection', ws => {
  let myId = null;

  ws.on('message', async raw => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    const {type,payload} = msg;

    if (type==='auth') {
      myId = Number(payload.tg_id);
      clients.set(myId, ws);
      console.log('WS auth: tg_id=' + myId + ', username=' + payload.username + ', pool=' + !!pool);
      try {
        const player = await dbUpsert(myId, payload.username || ('Игрок_' + myId), payload.tg_username || null);
        console.log('WS auth saved: tg_id=' + player.tg_id + ', balance=' + player.balance);
        send(ws, {type:'authed', payload:{player, duels:waitingDuels()}});
      } catch(e) {
        console.error('WS auth DB error: ' + e.message);
        send(ws, {type:'authed', payload:{player:{tg_id:myId,username:payload.username,balance:1000,wins:0,games:0,earned:0}, duels:waitingDuels()}});
      }
      return;
    }
    if (!myId) return;

    if (type==='create_duel') {
      const stake = Math.max(10, Math.min(10000, Number(payload.stake)||100));
      const p = await dbGet(myId);
      if (!p||p.balance<stake) { send(ws,{type:'error',payload:'Недостаточно монет'}); return; }
      const newBal = await dbAddBalance(myId,-stake);
      const duel = {id:genId(),creator_id:myId,joiner_id:null,stake,
        status:'waiting',nums:null,whose_turn:null,
        picks_a:[],picks_b:[],tb_a:null,tb_b:null,tiebreaker:false};
      duels.set(duel.id,duel);
      send(ws,{type:'duel_created',payload:{duel,balance:newBal}});
      broadcast({type:'lobby_add',payload:duel});
      return;
    }

    if (type==='cancel_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel||duel.creator_id!==myId||duel.status!=='waiting') return;
      duels.delete(duel.id);
      const newBal = await dbAddBalance(myId,duel.stake);
      send(ws,{type:'duel_cancelled',payload:{duel_id:duel.id,balance:newBal}});
      broadcast({type:'lobby_remove',payload:{duel_id:duel.id}});
      return;
    }

    if (type==='join_duel') {
      const duel = duels.get(payload.duel_id);
      if (!duel||duel.status!=='waiting') { send(ws,{type:'error',payload:'Дуэль недоступна'}); return; }
      if (duel.creator_id===myId) { send(ws,{type:'error',payload:'Это ваша дуэль'}); return; }
      const joiner = await dbGet(myId);
      if (!joiner||joiner.balance<duel.stake) { send(ws,{type:'error',payload:'Недостаточно монет'}); return; }
      const joinerBal = await dbAddBalance(myId,-duel.stake);
      const creator   = await dbGet(duel.creator_id);
      duel.joiner_id=myId; duel.status='active';
      duel.nums=shuffle([1,2,3,4,5,6,7,8,9]);
      duel.whose_turn=duel.creator_id;
      const info = {duel,nums:duel.nums,
        creator:{tg_id:creator.tg_id,username:creator.username},
        joiner: {tg_id:joiner.tg_id, username:joiner.username}};
      sendTo(duel.creator_id,{type:'game_start',payload:{...info,your_role:'creator'}});
      send(ws,{type:'game_start',payload:{...info,your_role:'joiner',balance:joinerBal}});
      broadcast({type:'lobby_remove',payload:{duel_id:duel.id}});
      return;
    }

    if (type==='pick_cup') {
      const duel = duels.get(payload.duel_id);
      if (!duel||duel.status!=='active') { send(ws,{type:'error',payload:'Игра не активна'}); return; }
      if (duel.whose_turn!==myId) { send(ws,{type:'error',payload:'Не ваш ход'}); return; }
      const idx = Number(payload.cup_index);
      const used = [...duel.picks_a,...duel.picks_b,
        ...(duel.tb_a!=null?[duel.tb_a]:[]),...(duel.tb_b!=null?[duel.tb_b]:[])];
      if (idx<0||idx>8||used.includes(idx)) { send(ws,{type:'error',payload:'Неверный выбор'}); return; }
      const isCr=myId===duel.creator_id, nextId=isCr?duel.joiner_id:duel.creator_id;

      if (duel.tiebreaker) {
        if (isCr) duel.tb_a=idx; else duel.tb_b=idx;
        if (duel.tb_a!=null&&duel.tb_b!=null) { await finishGame(duel); return; }
        duel.whose_turn=nextId;
        sendBoth(duel,{type:'cup_picked',payload:{duel_id:duel.id,cup_index:idx,picker_id:myId,
          picks_a:duel.picks_a,picks_b:duel.picks_b,tb_a:duel.tb_a,tb_b:duel.tb_b,
          whose_turn:nextId,tiebreaker:true}});
        return;
      }

      if (isCr) duel.picks_a.push(idx); else duel.picks_b.push(idx);
      const total=duel.picks_a.length+duel.picks_b.length;
      sendBoth(duel,{type:'cup_picked',payload:{duel_id:duel.id,cup_index:idx,picker_id:myId,
        picks_a:duel.picks_a,picks_b:duel.picks_b,tb_a:null,tb_b:null,
        whose_turn:nextId,tiebreaker:false}});
      if (total<6) { duel.whose_turn=nextId; return; }
      const sA=score(duel.picks_a,duel.nums), sB=score(duel.picks_b,duel.nums);
      if (sA===sB) {
        duel.tiebreaker=true; duel.whose_turn=duel.creator_id;
        sendBoth(duel,{type:'tiebreaker',payload:{duel_id:duel.id,
          picks_a:duel.picks_a,picks_b:duel.picks_b,
          score_a:sA,score_b:sB,whose_turn:duel.creator_id}});
      } else { await finishGame(duel); }
      return;
    }

    if (type==='get_lobby') {
      send(ws,{type:'lobby',payload:{duels:waitingDuels()}});
    }
  });

  ws.on('close',()=>{ if(myId) clients.delete(myId); });
});

// ─────────────────────────────────────────────
// FINISH GAME
// ─────────────────────────────────────────────
async function finishGame(duel) {
  const {nums,picks_a,picks_b,tb_a,tb_b,stake,creator_id,joiner_id} = duel;
  const sA = score(picks_a,nums)+(tb_a!=null?nums[tb_a]:0);
  const sB = score(picks_b,nums)+(tb_b!=null?nums[tb_b]:0);
  const pot=stake*2, commission=Math.floor(pot*COMMISSION), prize=pot-commission;
  let winnerId=null, balA, balB;
  if      (sA>sB) { winnerId=creator_id; balA=await dbAddBalance(creator_id,prize); balB=(await dbGet(joiner_id))?.balance??0; }
  else if (sB>sA) { winnerId=joiner_id;  balB=await dbAddBalance(joiner_id,prize);  balA=(await dbGet(creator_id))?.balance??0; }
  else            { balA=await dbAddBalance(creator_id,stake); balB=await dbAddBalance(joiner_id,stake); }
  await dbFinishGame(creator_id, winnerId===creator_id, winnerId===creator_id?prize-stake:0);
  await dbFinishGame(joiner_id,  winnerId===joiner_id,  winnerId===joiner_id ?prize-stake:0);
  duel.status='finished';
  sendBoth(duel,{type:'game_over',payload:{
    duel_id:duel.id,winner_id:winnerId,score_a:sA,score_b:sB,
    picks_a,picks_b,tb_a,tb_b,nums,prize,commission,total_pot:pot,
    balances:{[creator_id]:balA,[joiner_id]:balB}}});
  setTimeout(()=>duels.delete(duel.id),30_000);
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function main() {
  try { await dbInit(); } catch(e) { console.error('DB init error:', e.message); }
  server.listen(PORT, async () => {
    console.log(`✅ CupDuel running on port ${PORT}`);
    try { await tgSetWebhook(); } catch {}
  });
}

main();
