'use strict';
// Coin betting on match results. Every Telegram user gets a wallet per chat: BET_START_COINS to begin
// with and BET_DAILY_COINS more for every calendar day since (credited lazily, whenever the wallet is
// touched). When a round is paired the tracker posts a "betting board" with every match of the round
// and one button per player; a tap stakes BET_STAKE coins on that player (tap again to add more),
// /bet <amount> <name> stakes any amount. A won bet pays 1:1 (stake back plus the same again); draws,
// double losses and matches without a result are refunded. Bets close the moment the tracker sees
// the match completed.
//
// State, all inside store data:
//   guild.wallets[tgId] = { name, username, balance, lastDaily, bets, wagered, won, lost }
//   guild.betting       = false when an admin turned betting off for the chat
//   watch.bets[matchId] = { matchId, roundId, roundLabel, table, players: [{ id, name, legend }],
//                           open, result: null | { winnerSide: 0|1|null }, wagers: { [tgId]: { side, amount } } }
//   watch.betMsgs[msgId] = [matchId, ...]   // betting boards posted, so their buttons can be refreshed
const { InlineKeyboard } = require('grammy');
const { name, legendShort, record, outcomeFor, norm, matchRoster } = require('./model');
const fmt = require('./format');

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; }
const START = num(process.env.BET_START_COINS, 100);
const DAILY = num(process.env.BET_DAILY_COINS, 10);
const STAKE = num(process.env.BET_STAKE, 10);
const MAX_ALL = num(process.env.BET_MAX_MATCHES, 40); // above this many matches only roster matches are offered
const PER_MESSAGE = 20; // matches per board message (two buttons each)
const COIN = '🪙';

function today() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD in the server's timezone
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function coins(n) { return `${n}${COIN}`; }

// ---- wallets -------------------------------------------------------------------------------------

function wallets(guild) {
  if (!guild.wallets) guild.wallets = {};
  return guild.wallets;
}

// The wallet of a Telegram user in a chat, created on first use and credited with the daily income.
// `from` is a Telegram user object or just { id }.
function wallet(guild, from) {
  const ws = wallets(guild);
  const key = String(from.id);
  if (!ws[key]) {
    ws[key] = { name: null, username: null, balance: START, lastDaily: today(), createdAt: new Date().toISOString(), bets: 0, wagered: 0, won: 0, lost: 0 };
  }
  const w = ws[key];
  if (from.first_name) w.name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  if (from.username) w.username = from.username;
  const d = daysBetween(w.lastDaily, today());
  if (d > 0) {
    w.balance += d * DAILY;
    w.lastDaily = today();
  }
  return w;
}

function walletName(w, key) {
  return w.name || (w.username ? `@${w.username}` : `user ${key}`);
}

function enabled(guild) { return guild.betting !== false; }

// ---- bet entries ---------------------------------------------------------------------------------

function bets(watch) {
  if (!watch.bets) watch.bets = {};
  if (!watch.betMsgs) watch.betMsgs = {};
  return watch.bets;
}

function bettable(matches) {
  return matches.filter((m) => !m.ghost && !m.isBye && m.status !== 'COMPLETE'
    && m.players.length === 2 && m.players.every((p) => p.id != null));
}

// The matches of a live round that go on the board, in table order: all of them at a local, only the
// ones with roster players at a big event. Creates the bet entries that do not exist yet.
function openRound({ ev, watch, round, matches, roster }) {
  const all = bets(watch);
  let list = bettable(matches);
  const limited = list.length > MAX_ALL;
  if (limited) list = list.filter((m) => m.players.some((p) => matchRoster(roster, p)));
  list.sort((a, c) => (a.table ?? 1e9) - (c.table ?? 1e9));
  for (const m of list) {
    if (all[m.id]) continue;
    all[m.id] = {
      matchId: m.id,
      roundId: round.id,
      roundLabel: ev.label(round),
      table: m.table,
      players: m.players.map((p) => ({ id: p.id, name: name(p), legend: legendShort(p.legend) })),
      open: true,
      result: null,
      wagers: {},
    };
  }
  return { matches: list, limited };
}

function sideTotal(entry, side) {
  return Object.values(entry.wagers).filter((w) => w.side === side).reduce((s, w) => s + w.amount, 0);
}

function short(s, max = 18) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buttonLabel(entry, side) {
  const total = sideTotal(entry, side);
  let mark = '';
  if (!entry.open) {
    const ws = entry.result?.winnerSide;
    mark = ws == null ? '🤝 ' : ws === side ? '✅ ' : '❌ ';
  }
  return `${mark}${short(entry.players[side].name)}${total ? ` · ${total}${COIN}` : ''}`;
}

// Inline keyboard for the given matches: one row per match, one button per player.
function keyboard(watch, matchIds) {
  const rows = [];
  for (const id of matchIds) {
    const e = bets(watch)[id];
    if (!e) continue;
    rows.push([
      InlineKeyboard.text(buttonLabel(e, 0), `b:${watch.eventId}:${id}:0`),
      InlineKeyboard.text(buttonLabel(e, 1), `b:${watch.eventId}:${id}:1`),
    ]);
  }
  return InlineKeyboard.from(rows);
}

// The board messages for a round: [{ html, matchIds }], at most PER_MESSAGE matches each.
function boardMessages({ ev, round, matches, st, limited = false }) {
  const out = [];
  for (let i = 0; i < matches.length; i += PER_MESSAGE) {
    const slice = matches.slice(i, i + PER_MESSAGE);
    const part = matches.length > PER_MESSAGE ? ` (${i / PER_MESSAGE + 1}/${Math.ceil(matches.length / PER_MESSAGE)})` : '';
    const head = `🎲 ${fmt.b(`${ev.label(round)} · Place your bets`)}${fmt.esc(part)}`;
    const rows = slice.map((m) => {
      const t = m.table != null && m.table >= 0 ? `${fmt.code(`T${m.table}`)} ` : '';
      const side = (p) => {
        const row = st?.byId.get(p.id);
        return `${fmt.b(name(p))} ${fmt.i(`(${legendShort(p.legend)} · ${record(row || p)})`)}`;
      };
      return `${t}${side(m.players[0])} vs ${side(m.players[1])}`;
    });
    const notes = [`tap a name to bet ${coins(STAKE)}, tap again for more`, '/bet <amount> <name> for any stake', 'wins pay 1:1'];
    if (limited && i === 0) notes.unshift('big event: only matches with roster players');
    out.push({
      html: [head, fmt.quote(rows), fmt.footer(ev, ...notes)].join('\n'),
      matchIds: slice.map((m) => m.id),
    });
  }
  return out;
}

// ---- placing bets --------------------------------------------------------------------------------

// Stake `amount` coins on side 0/1 of a match. Returns { ok, text } with a short message for the user.
function placeBet({ guild, watch, matchId, side, from, amount = STAKE }) {
  const entry = bets(watch)[matchId];
  if (!entry) return { ok: false, text: 'This match is not open for bets.' };
  if (!entry.open) return { ok: false, text: `Betting on this match is closed (${entry.roundLabel}).` };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, text: 'The stake must be a whole number of coins.' };
  const w = wallet(guild, from);
  const key = String(from.id);
  const mine = entry.wagers[key];
  if (mine && mine.side !== side) {
    return { ok: false, text: `You already have ${coins(mine.amount)} on ${entry.players[mine.side].name}. Pick one side!` };
  }
  if (w.balance < amount) return { ok: false, text: `Not enough coins: you have ${coins(w.balance)}.` };
  w.balance -= amount;
  w.wagered += amount;
  if (!mine) w.bets++;
  entry.wagers[key] = { side, amount: (mine?.amount || 0) + amount, at: new Date().toISOString() };
  const p = entry.players[side].name;
  const total = entry.wagers[key].amount;
  return { ok: true, text: `✅ ${coins(amount)} on ${p}${total !== amount ? ` (${coins(total)} in total)` : ''} · balance ${coins(w.balance)}`, entry };
}

// Open bet entries of a watch, optionally only those of one round.
function openEntries(watch, roundId = null) {
  return Object.values(bets(watch)).filter((e) => e.open && (roundId == null || e.roundId === roundId));
}

// Find an open match by one of its player names: { entry, side } or { error }.
function findOpenPlayer(watch, query) {
  const q = norm(query);
  if (!q) return { error: 'Give a player name.' };
  const hits = [];
  for (const e of openEntries(watch)) {
    e.players.forEach((p, side) => { if (norm(p.name) === q) hits.push({ entry: e, side }); });
  }
  if (!hits.length) {
    for (const e of openEntries(watch)) {
      e.players.forEach((p, side) => { if (norm(p.name).includes(q)) hits.push({ entry: e, side }); });
    }
  }
  if (!hits.length) return { error: `No open match with a player called ${query}.` };
  if (hits.length > 1) return { error: `${query} matches several players: ${hits.map((h) => h.entry.players[h.side].name).join(', ')}. Be more specific.` };
  return hits[0];
}

// ---- settling ------------------------------------------------------------------------------------

// Pay out a completed match (or refund it when `m` is null / has no winner). Returns a summary line
// for the settlement post, or null when nobody had bet on it.
function settle(guild, entry, m) {
  if (!entry.open) return null;
  let winnerSide = null;
  if (m) {
    const o = outcomeFor(m, entry.players[0].id);
    if (o.result === 'WIN') winnerSide = 0;
    else if (o.result === 'LOSS') winnerSide = 1;
  }
  entry.open = false;
  entry.result = { winnerSide, settledAt: new Date().toISOString() };
  const deltas = [];
  for (const [key, wg] of Object.entries(entry.wagers)) {
    const w = wallet(guild, { id: key });
    let delta;
    if (winnerSide == null) { w.balance += wg.amount; delta = 0; }
    else if (wg.side === winnerSide) { w.balance += 2 * wg.amount; w.won += wg.amount; delta = wg.amount; }
    else { w.lost += wg.amount; delta = -wg.amount; }
    wg.delta = delta;
    deltas.push({ key, w, delta });
  }
  if (!deltas.length) return null;
  deltas.sort((a, c) => c.delta - a.delta);
  const [a, c] = entry.players;
  const score = m && winnerSide != null ? fmt.code(outcomeFor(m, entry.players[winnerSide].id).score) : '';
  const head = winnerSide == null
    ? `🤝 ${fmt.b(a.name)} vs ${fmt.b(c.name)} · ${m ? 'no winner' : 'no result'}, stakes refunded`
    : `✅ ${fmt.b(entry.players[winnerSide].name)} beat ${fmt.b(entry.players[1 - winnerSide].name)} ${score}`;
  const people = deltas.map(({ key, w, delta }) => {
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
    return `${fmt.esc(walletName(w, key))} ${fmt.b(sign)} ${fmt.i(`(${w.balance})`)}`;
  });
  return `${head}\n${fmt.i('→')} ${people.join(', ')}`;
}

function settledMessage({ ev, roundLabel, lines }) {
  return [`🎲 ${fmt.b(`${roundLabel} · Bets settled`)}`, fmt.quote(lines.join('\n\n')), fmt.footer(ev, `balances in ${COIN} · /coins`)].join('\n');
}

// Refund every open entry (of one round, or all of them). Returns the refunded entries, each with the
// summary line (null when nobody had bet on it).
function refundOpen(guild, watch, roundId = null) {
  return openEntries(watch, roundId).map((entry) => ({ entry, line: settle(guild, entry, null) }));
}

// Every board message id that shows one of these matches.
function boardsShowing(watch, matchIds) {
  const want = new Set(matchIds.map(String));
  bets(watch);
  return Object.entries(watch.betMsgs)
    .filter(([, ids]) => ids.some((id) => want.has(String(id))))
    .map(([msgId, ids]) => ({ msgId: Number(msgId), matchIds: ids }));
}

// ---- event winner pool ---------------------------------------------------------------------------
// One pick per user on who wins the whole event. Everyone's stakes form a pool; when the event ends the
// pool is split among those who picked the champion in proportion to their stakes (never less than 1:1).
// Nobody right, or no final standings: everyone is refunded. Picks close at the first reported result.
//   watch.champ = { open, closedAt, picks: { [tgId]: { playerId, name, amount, at } }, result: null | { playerId, name } }

function champ(watch) {
  if (!watch.champ) watch.champ = { open: true, closedAt: null, picks: {}, result: null };
  return watch.champ;
}

function closeChamp(watch) {
  const c = champ(watch);
  if (!c.open) return false;
  c.open = false;
  c.closedAt = new Date().toISOString();
  return true;
}

function champPool(c) {
  return Object.values(c.picks).reduce((s, p) => s + p.amount, 0);
}

// Stake `amount` on `player` (a model player object) winning the event.
function placeChampBet({ guild, watch, from, player, amount }) {
  const c = champ(watch);
  if (!c.open) return { ok: false, text: 'Winner bets are closed: the first results are already in.' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, text: 'The stake must be a whole number of coins.' };
  if (player.status === 'DROPPED') return { ok: false, text: `${name(player)} has dropped from the event.` };
  const w = wallet(guild, from);
  const key = String(from.id);
  const mine = c.picks[key];
  if (mine && mine.playerId !== player.id) return { ok: false, text: `You already have ${coins(mine.amount)} on ${mine.name}. One pick per person!` };
  if (w.balance < amount) return { ok: false, text: `Not enough coins: you have ${coins(w.balance)}.` };
  w.balance -= amount;
  w.wagered += amount;
  if (!mine) w.bets++;
  c.picks[key] = { playerId: player.id, name: name(player), amount: (mine?.amount || 0) + amount, at: new Date().toISOString() };
  const total = c.picks[key].amount;
  return { ok: true, text: `🏆 ${coins(amount)} on ${name(player)} to win the event${total !== amount ? ` (${coins(total)} in total)` : ''} · balance ${coins(w.balance)} · pool ${coins(champPool(c))}` };
}

// Pay out the winner pool. `winner` is the champion (a standings row) or null to refund everyone.
// Returns the summary line for the post, or null when nobody had a pick.
function settleChamp(guild, watch, winner) {
  const c = champ(watch);
  if (c.result) return null;
  c.open = false;
  c.result = { playerId: winner?.id ?? null, name: winner ? name(winner) : null, settledAt: new Date().toISOString() };
  const picks = Object.entries(c.picks);
  if (!picks.length) return null;
  const pool = champPool(c);
  const right = picks.filter(([, p]) => winner && p.playerId === winner.id);
  const rightTotal = right.reduce((s, [, p]) => s + p.amount, 0);
  const refund = !winner || !right.length;
  const deltas = [];
  for (const [key, p] of picks) {
    const w = wallet(guild, { id: key });
    let delta;
    if (refund) { w.balance += p.amount; delta = 0; }
    else if (p.playerId === winner.id) {
      const payout = Math.max(2 * p.amount, Math.floor((pool * p.amount) / rightTotal));
      w.balance += payout; w.won += payout - p.amount; delta = payout - p.amount;
    } else { w.lost += p.amount; delta = -p.amount; }
    p.delta = delta;
    deltas.push({ key, w, delta });
  }
  deltas.sort((a, c2) => c2.delta - a.delta);
  const head = !winner ? '🤝 No final standings · winner picks refunded'
    : refund ? `🏆 ${fmt.b(name(winner))} won the event · nobody picked them, stakes refunded`
      : `🏆 ${fmt.b(name(winner))} won the event · pool ${coins(pool)}`;
  const people = deltas.map(({ key, w, delta }) => {
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
    return `${fmt.esc(walletName(w, key))} ${fmt.b(sign)} ${fmt.i(`(${w.balance})`)}`;
  });
  return `${head}\n${fmt.i('→')} ${people.join(', ')}`;
}

// The winner pool as shown by /winner: state, every pick with its backers, and the caller's own pick.
function champMessage({ ev, watch, guild, from }) {
  const c = champ(watch);
  const byPlayer = new Map();
  for (const [key, p] of Object.entries(c.picks)) {
    if (!byPlayer.has(p.playerId)) byPlayer.set(p.playerId, { name: p.name, total: 0, backers: [] });
    const g = byPlayer.get(p.playerId);
    g.total += p.amount;
    g.backers.push(walletName(wallet(guild, { id: key }), key));
  }
  const pool = champPool(c);
  const state = c.result ? `settled · ${c.result.name ? `${c.result.name} won` : 'refunded'}` : c.open ? 'open until the first result' : 'closed';
  const out = [`🏆 ${fmt.b('Event winner bets')} · ${fmt.i(state)}`];
  const rows = [...byPlayer.values()].sort((a, b) => b.total - a.total)
    .map((g) => `${fmt.b(g.name)} · ${coins(g.total)} ${fmt.i(`(${g.backers.join(', ')})`)}`);
  out.push(rows.length ? fmt.quote([`Pool · ${fmt.b(coins(pool))}`, ...rows]) : fmt.i('No picks yet.'));
  const mine = from && c.picks[String(from.id)];
  if (mine) out.push(`Your pick · ${fmt.b(mine.name)} with ${coins(mine.amount)}`);
  const notes = ['pool split among those who picked the champion, at least 1:1'];
  if (c.open) notes.unshift('/winner <amount> <name>');
  out.push(fmt.footer(ev, ...notes));
  return out.join('\n');
}

// ---- messages for commands -----------------------------------------------------------------------

function coinsMessage({ guild, from, watches }) {
  const me = wallet(guild, from);
  const key = String(from.id);
  const open = [];
  for (const w of watches) {
    for (const e of openEntries(w)) {
      const wg = e.wagers[key];
      if (wg) open.push(`${fmt.esc(e.roundLabel)} · ${coins(wg.amount)} on ${fmt.b(e.players[wg.side].name)} ${fmt.i(`vs ${e.players[1 - wg.side].name}`)}`);
    }
    const pick = w.champ && !w.champ.result ? w.champ.picks[key] : null;
    if (pick) open.push(`🏆 Event winner · ${coins(pick.amount)} on ${fmt.b(pick.name)}${w.name ? ` ${fmt.i(`(${w.name})`)}` : ''}`);
  }
  const mine = [
    `Balance · ${fmt.b(coins(me.balance))}${open.length ? ` · ${fmt.i(`${open.length} open bet${open.length === 1 ? '' : 's'}`)}` : ''}`,
    `Record · ${fmt.esc(`${me.bets} bets · won ${coins(me.won)} · lost ${coins(me.lost)}`)}`,
    `Income · ${fmt.esc(`+${coins(DAILY)} every day`)}`,
  ];
  const out = [`${COIN} ${fmt.b(walletName(me, key))}`, fmt.quote(mine)];
  if (open.length) out.push(fmt.quote(open));
  const rows = Object.entries(wallets(guild))
    .map(([k, w]) => ({ k, w: wallet(guild, { id: k }) }))
    .sort((a, c) => c.w.balance - a.w.balance || (c.w.won - c.w.lost) - (a.w.won - a.w.lost))
    .slice(0, 15)
    .map(({ k, w }, idx) => {
      const nm = k === key ? fmt.b(walletName(w, k)) : fmt.esc(walletName(w, k));
      const net = w.won - w.lost;
      return `${idx + 1}. ${nm} · ${fmt.b(coins(w.balance))} ${fmt.i(`(${net >= 0 ? '+' : '−'}${Math.abs(net)} from bets)`)}`;
    });
  if (rows.length > 1) out.push(`🏦 ${fmt.b('Richest bettors')}`, fmt.quote(rows));
  return out.join('\n');
}

module.exports = {
  START, DAILY, STAKE, COIN, coins,
  wallet, wallets, walletName, enabled,
  bets, openRound, keyboard, boardMessages, buttonLabel,
  placeBet, openEntries, findOpenPlayer,
  settle, settledMessage, refundOpen, boardsShowing, coinsMessage,
  champ, closeChamp, placeChampBet, settleChamp, champMessage,
};
