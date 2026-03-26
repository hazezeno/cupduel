const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, 'cupduel.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_losses INTEGER DEFAULT 0,
    total_draws INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS duels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player1_id TEXT NOT NULL,
    player2_id TEXT,
    bet INTEGER NOT NULL,
    status TEXT DEFAULT 'waiting',
    cups TEXT NOT NULL,
    player1_picks TEXT DEFAULT '[]',
    player2_picks TEXT DEFAULT '[]',
    tiebreak_picks TEXT DEFAULT '{}',
    winner_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    finished_at INTEGER,
    FOREIGN KEY (player1_id) REFERENCES players(telegram_id),
    FOREIGN KEY (player2_id) REFERENCES players(telegram_id)
  );

  CREATE INDEX IF NOT EXISTS idx_players_balance ON players(balance DESC);
  CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
`);

// ─── PLAYER OPERATIONS ───────────────────────────────────────────────────────

// ==== TESTING FEATURE: START BALANCE ====
// To disable the 1000 starting coins, set START_BALANCE to 0 or remove this env var
const START_BALANCE = parseInt(process.env.START_BALANCE ?? '1000', 10);
// ==== END TESTING FEATURE ====

function getOrCreatePlayer(telegramId, username, firstName) {
  const existing = db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
  if (existing) {
    // Update username/name if changed
    db.prepare('UPDATE players SET username = ?, first_name = ? WHERE telegram_id = ?')
      .run(username || existing.username, firstName || existing.first_name, telegramId);
    return db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
  }
  db.prepare('INSERT INTO players (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?)')
    .run(telegramId, username || null, firstName || null, START_BALANCE);
  return db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
}

function getPlayer(telegramId) {
  return db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
}

function getTopPlayers(limit = 20) {
  return db.prepare('SELECT * FROM players ORDER BY balance DESC LIMIT ?').all(limit);
}

function addTokens(telegramId, amount) {
  const player = getPlayer(telegramId);
  if (!player) return null;
  db.prepare('UPDATE players SET balance = balance + ? WHERE telegram_id = ?').run(amount, telegramId);
  return getPlayer(telegramId);
}

function setBalance(telegramId, amount) {
  const player = getPlayer(telegramId);
  if (!player) return null;
  db.prepare('UPDATE players SET balance = ? WHERE telegram_id = ?').run(amount, telegramId);
  return getPlayer(telegramId);
}

// ─── DUEL OPERATIONS ─────────────────────────────────────────────────────────

function generateCups() {
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

function createDuel(player1Id, bet) {
  const cups = generateCups();
  const result = db.prepare(
    'INSERT INTO duels (player1_id, bet, cups) VALUES (?, ?, ?)'
  ).run(player1Id, bet, JSON.stringify(cups));
  
  // Deduct bet from player1
  db.prepare('UPDATE players SET balance = balance - ? WHERE telegram_id = ?').run(bet, player1Id);
  
  return getDuel(result.lastInsertRowid);
}

function joinDuel(duelId, player2Id) {
  const duel = getDuel(duelId);
  if (!duel || duel.status !== 'waiting' || duel.player1_id === player2Id) return null;
  
  const player2 = getPlayer(player2Id);
  if (!player2 || player2.balance < duel.bet) return null;
  
  db.prepare('UPDATE players SET balance = balance - ? WHERE telegram_id = ?').run(duel.bet, player2Id);
  db.prepare('UPDATE duels SET player2_id = ?, status = ? WHERE id = ?')
    .run(player2Id, 'active', duelId);
  
  return getDuel(duelId);
}

function getDuel(duelId) {
  return db.prepare('SELECT * FROM duels WHERE id = ?').get(duelId);
}

function getActiveDuels() {
  return db.prepare("SELECT * FROM duels WHERE status = 'waiting' ORDER BY created_at DESC").all();
}

function makePick(duelId, playerId, cupIndex) {
  const duel = getDuel(duelId);
  if (!duel) return { error: 'Дуэль не найдена' };
  
  const cups = JSON.parse(duel.cups);
  const p1picks = JSON.parse(duel.player1_picks);
  const p2picks = JSON.parse(duel.player2_picks);
  const tiebreakPicks = JSON.parse(duel.tiebreak_picks);
  
  const isTiebreak = duel.status === 'tiebreak';
  
  if (duel.status === 'active') {
    const isP1 = playerId === duel.player1_id;
    const isP2 = playerId === duel.player2_id;
    if (!isP1 && !isP2) return { error: 'Не участник дуэли' };
    
    const myPicks = isP1 ? p1picks : p2picks;
    const otherPicks = isP1 ? p2picks : p1picks;
    
    if (myPicks.length >= 3) return { error: 'Уже выбрал 3 стаканчика' };
    if (myPicks.includes(cupIndex) || otherPicks.includes(cupIndex)) return { error: 'Стаканчик уже взят' };
    
    myPicks.push(cupIndex);
    
    if (isP1) {
      db.prepare('UPDATE duels SET player1_picks = ? WHERE id = ?').run(JSON.stringify(myPicks), duelId);
    } else {
      db.prepare('UPDATE duels SET player2_picks = ? WHERE id = ?').run(JSON.stringify(myPicks), duelId);
    }
    
    // Check if both have 3 picks
    const updatedDuel = getDuel(duelId);
    const up1 = JSON.parse(updatedDuel.player1_picks);
    const up2 = JSON.parse(updatedDuel.player2_picks);
    
    if (up1.length === 3 && up2.length === 3) {
      return resolveGame(duelId, updatedDuel);
    }
    
    return { duel: getDuel(duelId), phase: 'picking' };
  }
  
  if (isTiebreak) {
    const isP1 = playerId === duel.player1_id;
    const isP2 = playerId === duel.player2_id;
    if (!isP1 && !isP2) return { error: 'Не участник дуэли' };
    
    const role = isP1 ? 'p1' : 'p2';
    if (tiebreakPicks[role] !== undefined) return { error: 'Уже выбрал стаканчик в тайбрейке' };
    
    const allTaken = [...JSON.parse(duel.player1_picks), ...JSON.parse(duel.player2_picks)];
    if (allTaken.includes(cupIndex)) return { error: 'Стаканчик уже взят' };
    if (tiebreakPicks['p1'] === cupIndex || tiebreakPicks['p2'] === cupIndex) return { error: 'Стаканчик уже взят' };
    
    tiebreakPicks[role] = cupIndex;
    db.prepare('UPDATE duels SET tiebreak_picks = ? WHERE id = ?').run(JSON.stringify(tiebreakPicks), duelId);
    
    if (tiebreakPicks.p1 !== undefined && tiebreakPicks.p2 !== undefined) {
      return resolveTiebreak(duelId);
    }
    
    return { duel: getDuel(duelId), phase: 'tiebreak' };
  }
  
  return { error: 'Некорректный статус дуэли' };
}

function resolveGame(duelId, duel) {
  const cups = JSON.parse(duel.cups);
  const p1picks = JSON.parse(duel.player1_picks);
  const p2picks = JSON.parse(duel.player2_picks);
  
  const p1sum = p1picks.reduce((s, i) => s + cups[i], 0);
  const p2sum = p2picks.reduce((s, i) => s + cups[i], 0);
  
  if (p1sum !== p2sum) {
    const winnerId = p1sum > p2sum ? duel.player1_id : duel.player2_id;
    return finishDuel(duelId, duel, winnerId);
  }
  
  // Tiebreak
  db.prepare("UPDATE duels SET status = 'tiebreak' WHERE id = ?").run(duelId);
  return { duel: getDuel(duelId), phase: 'tiebreak', p1sum, p2sum };
}

function resolveTiebreak(duelId) {
  const duel = getDuel(duelId);
  const cups = JSON.parse(duel.cups);
  const tiebreakPicks = JSON.parse(duel.tiebreak_picks);
  
  const p1val = cups[tiebreakPicks.p1];
  const p2val = cups[tiebreakPicks.p2];
  
  if (p1val === p2val) {
    // Another tiebreak (edge case, reset tiebreak)
    db.prepare("UPDATE duels SET tiebreak_picks = '{}' WHERE id = ?").run(duelId);
    return { duel: getDuel(duelId), phase: 'tiebreak', message: 'Снова ничья! Ещё раунд тайбрейка.' };
  }
  
  const winnerId = p1val > p2val ? duel.player1_id : duel.player2_id;
  return finishDuel(duelId, duel, winnerId);
}

function finishDuel(duelId, duel, winnerId) {
  const pot = duel.bet * 2;
  const commission = Math.floor(pot * 0.05); // 5% commission
  const prize = pot - commission;
  
  const loserId = winnerId === duel.player1_id ? duel.player2_id : duel.player1_id;
  
  db.prepare('UPDATE players SET balance = balance + ?, total_wins = total_wins + 1 WHERE telegram_id = ?')
    .run(prize, winnerId);
  db.prepare('UPDATE players SET total_losses = total_losses + 1 WHERE telegram_id = ?')
    .run(loserId);
  db.prepare("UPDATE duels SET status = 'finished', winner_id = ?, finished_at = unixepoch() WHERE id = ?")
    .run(winnerId, duelId);
  
  return { duel: getDuel(duelId), phase: 'finished', winnerId, prize, commission };
}

function cancelDuel(duelId, playerId) {
  const duel = getDuel(duelId);
  if (!duel || duel.status !== 'waiting' || duel.player1_id !== playerId) return null;
  
  db.prepare('UPDATE players SET balance = balance + ? WHERE telegram_id = ?').run(duel.bet, playerId);
  db.prepare("UPDATE duels SET status = 'cancelled' WHERE id = ?").run(duelId);
  
  return getDuel(duelId);
}

module.exports = {
  getOrCreatePlayer,
  getPlayer,
  getTopPlayers,
  addTokens,
  setBalance,
  createDuel,
  joinDuel,
  getDuel,
  getActiveDuels,
  makePick,
  cancelDuel,
};
