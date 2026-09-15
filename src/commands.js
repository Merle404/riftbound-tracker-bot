'use strict';
// Telegram command handlers. Each handler gets (ctx, deps) where deps = { store, tracker, log }.
const api = require('./api');
const ed = require('./eventdata');
const fmt = require('./format');
const betting = require('./betting');
const { interpretMatch, matchRoster, norm, name, fullName, legendShort } = require('./model');

const HELP = `🤖 <b>Riftbound Tracker</b>

📡 <b>Tracking</b>
/watch &lt;event url or id&gt; · post roster results in this chat
/watch &lt;url&gt; backfill · same, plus every result so far
/unwatch &lt;event id&gt; · stop tracking
/watching · tracked events

👥 <b>Roster</b> <i>(matched by Spicerack display name or event nickname)</i>
/team add &lt;name&gt; [@telegram] · add a player, the @handle gets pinged
/team remove &lt;name&gt;[, name2, ...] · partial names work if unique
/team import name1, name2, name3
/team list

🔔 <b>DM alerts</b> <i>(your pairings and results in a private chat)</i>
/link &lt;roster name&gt; · link your Telegram account to a roster player
/unlink [roster name] · stop DM alerts
<i>Send /start to the bot in a private chat first: Telegram only lets it DM people who did.</i>

📊 <b>Info</b> <i>(event is optional when only one is watched)</i>
/status [event] · round, timer, players left
/players [event] · total / still in / dropped
/leaderboard [event] · roster players in the standings
/results [event] [round] · roster results for a round
/pairings [event] · roster pairings for the current round
/player &lt;name&gt; [event] · match history of one player
/legends [event] · legend breakdown of the whole field
/legends &lt;legend&gt; [event] · every player on that legend

🎲 <b>Betting</b> <i>(every user starts with ${betting.START}🪙 and gets ${betting.DAILY}🪙 a day)</i>
/bets [event] · betting board for the current round, plus your open bets
/bet &lt;amount&gt; &lt;player&gt; · stake any amount on a player (or tap a name on the board for ${betting.STAKE}🪙)
/coins · your balance and the richest bettors
/betting on|off · admins: turn betting off or on for this chat

<i>⭐ best-placed player on their legend in the whole event · ❤️ roster player</i>`;


function args(ctx) {
  return (ctx.match || '').trim();
}

function chatKey(ctx) { return String(ctx.chat.id); }

async function isAllowed(ctx) {
  if (process.env.ADMIN_ONLY === 'false') return true;
  if (ctx.chat.type === 'private') return true;
  if (!ctx.from) return true; // channel / anonymous admin posts
  if (ctx.from.id === 1087968824) return true; // GroupAnonymousBot (anonymous admin)
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'creator' || m.status === 'administrator';
  } catch {
    return false;
  }
}

// Splits "/cmd tokens" into { eventId, round, rest }: URLs or big numbers are event ids,
// 1-2 digit numbers are round numbers, everything else is free text.
function parseTarget(text) {
  const out = { eventId: null, round: null, rest: [] };
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (/\/events\/\d+/.test(tok) || /^\d{5,}$/.test(tok)) out.eventId = api.parseEventId(tok);
    else if (/^\d{1,2}$/.test(tok) && out.round == null) out.round = Number(tok);
    else out.rest.push(tok);
  }
  return out;
}

function resolveEventId(ctx, store, explicit) {
  if (explicit) return explicit;
  const watches = Object.values(store.watches(chatKey(ctx)));
  if (!watches.length) return null;
  const active = watches.filter((w) => !w.finished);
  const list = active.length ? active : watches;
  list.sort((a, c) => (a.addedAt < c.addedAt ? 1 : -1));
  return list[0].eventId;
}

async function reply(ctx, html) {
  for (const part of fmt.chunk(html)) {
    await ctx.reply(part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
}

const warn = (text) => `⚠️ ${text}`;
const usage = (syntax) => `Usage · ${fmt.code(syntax)}`;
const names = (entries) => entries.map((e) => fmt.b(e.name)).join(', ');

const handlers = {
  async start(ctx, { store }) {
    if (ctx.chat.type === 'private' && ctx.from) {
      const linked = registerUser(store, ctx.from);
      store.save();
      const lines = [`👋 ${fmt.b('Hi!')} I can now DM you your pairings and results.`];
      if (linked.length) {
        lines.push(`🔗 Linked you to ${names(linked)} ${fmt.i(`(matched your @${ctx.from.username})`)}`);
      } else {
        lines.push('To get alerts, link yourself to a roster player: /link &lt;roster name&gt;');
        lines.push(fmt.i('or ask a team admin to add you with /team add <name> @yourhandle'));
      }
      await reply(ctx, lines.join('\n'));
    }
    await reply(ctx, HELP);
  },
  async help(ctx) { await reply(ctx, HELP); },

  // /link <roster name>: in a DM searches every chat's roster, in a group only that chat's.
  async link(ctx, { store, dm }) {
    if (!ctx.from) return reply(ctx, warn('Run /link from your own account.'));
    const query = args(ctx);
    if (!query) return reply(ctx, usage('/link <roster name>'));
    const priv = ctx.chat.type === 'private';
    if (priv) registerUser(store, ctx.from);
    const candidates = (priv ? store.allRosterEntries() : store.roster(chatKey(ctx)).map((entry) => ({ chatKey: chatKey(ctx), entry })))
      .filter(({ entry }) => norm(entry.name) === norm(query));
    if (!candidates.length) {
      return reply(ctx, warn(priv
        ? `No roster player called ${fmt.b(query)} in any chat I know. Ask a team admin to /team add you first.`
        : `${fmt.b(query)} is not on this chat's roster. See /team list.`));
    }
    const me = ctx.from.id;
    const myHandle = (ctx.from.username || '').toLowerCase();
    const done = [];
    const refused = [];
    for (const { entry } of candidates) {
      const handle = (entry.tg || '').replace(/^@/, '').toLowerCase();
      if (handle && handle !== myHandle) { refused.push(`${entry.name}: reserved for @${handle}`); continue; }
      if (entry.tgId && Number(entry.tgId) !== me) { refused.push(`${entry.name}: already linked to someone else (an admin can /unlink it)`); continue; }
      entry.tgId = me;
      if (!entry.tg && ctx.from.username) { entry.tg = '@' + ctx.from.username; entry.tgAuto = true; } // so group pings work too
      done.push(entry);
    }
    store.save();
    const lines = [];
    if (done.length) lines.push(`🔗 Linked ${fmt.b(ctx.from.first_name || String(me))} to ${names(done)}`);
    for (const r of refused) lines.push(warn(fmt.esc(r)));
    if (done.length && !priv) {
      // Telegram only lets the bot DM people who opened a private chat with it; check now.
      const known = store.knownUser(me);
      let ok = !!known?.startedAt;
      if (ok && dm) {
        try { await dm(me, `🔗 You are linked to ${names(done)}\n${fmt.i('I will DM you your pairings and results.')}`); }
        catch { ok = false; }
      }
      if (!ok) {
        const botName = ctx.me?.username ? `@${ctx.me.username}` : 'me';
        lines.push(warn(`I cannot DM you yet: open a private chat with ${fmt.esc(botName)} and send /start.`));
      } else {
        lines.push(fmt.i('You will get your pairings and results by DM.'));
      }
    } else if (done.length) {
      lines.push(fmt.i('You will get your pairings and results here as soon as they are posted.'));
    }
    await reply(ctx, lines.join('\n'));
  },

  // /unlink [name]: your own links (DM or group), or any entry in this chat if you are an admin.
  async unlink(ctx, { store }) {
    if (!ctx.from) return reply(ctx, warn('Run /unlink from your own account.'));
    const query = args(ctx);
    const priv = ctx.chat.type === 'private';
    const pool = priv ? store.allRosterEntries() : store.roster(chatKey(ctx)).map((entry) => ({ chatKey: chatKey(ctx), entry }));
    let targets = pool.filter(({ entry }) => entry.tgId != null && (!query || norm(entry.name) === norm(query)));
    const mine = targets.filter(({ entry }) => Number(entry.tgId) === ctx.from.id);
    if (mine.length < targets.length) {
      if (priv || !(await isAllowed(ctx))) targets = mine;
    }
    if (!targets.length) return reply(ctx, warn(query ? `${fmt.b(query)} is not linked to you.` : 'Nothing is linked to you.'));
    for (const { entry } of targets) {
      entry.tgId = null;
      if (entry.tgAuto) { entry.tg = null; delete entry.tgAuto; } // handle came from /link, not from an admin
    }
    store.save();
    await reply(ctx, `🔕 Unlinked ${names(targets.map((t) => t.entry))} ${fmt.i('· no more DM alerts')}`);
  },

  async watch(ctx, { store, tracker }) {
    if (!(await isAllowed(ctx))) return reply(ctx, warn('Only group admins can do that.'));
    const text = args(ctx);
    const eventId = api.parseEventId(text.split(/\s+/)[0]);
    if (!eventId) return reply(ctx, usage('/watch https://locator.riftbound.uvsgames.com/events/926094 [backfill]'));
    const backfill = /\bbackfill\b/i.test(text);
    const key = chatKey(ctx);
    const watches = store.watches(key);
    if (watches[eventId]) return reply(ctx, warn(`Already watching ${fmt.b(watches[eventId].name || eventId)} here. Use /unwatch ${eventId} first to reset.`));

    const watch = store.newWatch({
      eventId,
      channelId: ctx.chat.id,
      threadId: ctx.msg?.message_thread_id ?? null,
      addedBy: ctx.from?.id ?? null,
      backfill,
    });
    watch.threadId = ctx.msg?.message_thread_id ?? null;
    watches[eventId] = watch;
    store.save();

    await reply(ctx, `🔎 Looking up event ${fmt.code(String(eventId))}…`);
    let res;
    try {
      res = await tracker.pollWatch(key, watch);
    } catch (err) {
      delete watches[eventId];
      store.save();
      const why = err.status === 404 ? 'event not found' : err.message;
      return reply(ctx, warn(`Could not load event ${fmt.code(String(eventId))}: ${fmt.esc(why)}`));
    }
    store.save();

    const { ev, st, counts } = res;
    const roster = store.roster(key);
    const lines = [`👀 ${fmt.b('Now watching')} ${fmt.link(ev.name, ev.url)}`];
    const info = [`Status · ${fmt.b(fmt.prettyLifecycle(ev.lifecycle))}`];
    if (counts.total != null) info.push(`Players · ${fmt.b(String(counts.active ?? '?'))} of ${counts.total} still in`);
    if (ev.currentRound) info.push(`Round · ${fmt.b(ev.label(ev.currentRound).replace(/^Round /, ''))}`);
    lines.push(fmt.quote(info));
    if (!roster.length) {
      lines.push(warn('The roster is empty. Add players with /team add &lt;name&gt; and I will start reporting.'));
    } else {
      const players = await ed.loadPlayers(ev);
      const found = [];
      const missing = [];
      for (const entry of roster) {
        const p = players.find((pl) => matchRoster([entry], pl));
        if (p) found.push(p); else missing.push(entry);
      }
      lines.push(`✅ Roster players found · ${fmt.b(`${found.length}/${roster.length}`)}${found.length ? ` · ${fmt.esc(found.map(fullName).join(', '))}` : ''}`);
      if (missing.length) lines.push(warn(`Not found · ${fmt.esc(missing.map((e) => e.name).join(', '))} ${fmt.i('(check spelling)')}`));
      if (st && found.length) {
        lines.push('');
        lines.push(fmt.standingsMessage({ ev, st, roster, counts, title: 'Current standings' }));
      }
    }
    if (backfill) lines.push(fmt.i('Backfill posted above.'));
    await reply(ctx, lines.join('\n'));
  },

  async unwatch(ctx, { store }) {
    if (!(await isAllowed(ctx))) return reply(ctx, warn('Only group admins can do that.'));
    const eventId = api.parseEventId(args(ctx)) || resolveEventId(ctx, store, null);
    const watches = store.watches(chatKey(ctx));
    if (!eventId || !watches[eventId]) return reply(ctx, warn('Not watching that event. See /watching.'));
    const nm = watches[eventId].name || eventId;
    const refunded = betting.refundOpen(store.guild(chatKey(ctx)), watches[eventId]).filter((r) => r.line);
    delete watches[eventId];
    store.save();
    await reply(ctx, `🛑 Stopped watching ${fmt.b(nm)}${refunded.length ? ` ${fmt.i(`· ${refunded.length} open bet${refunded.length === 1 ? '' : 's'} refunded`)}` : ''}`);
  },

  async watching(ctx, { store }) {
    const watches = Object.values(store.watches(chatKey(ctx)));
    if (!watches.length) return reply(ctx, warn('Not watching any event in this chat. Use /watch &lt;url&gt;.'));
    const rows = watches.map((w) => {
      const icon = w.finished ? '🏁' : w.lastError ? '🔴' : '🟢';
      const state = w.finished ? 'finished' : w.lastError ? `error: ${w.lastError}` : 'live';
      return `${icon} ${fmt.link(w.name || String(w.eventId), api.eventUrl(w.eventId))} · ${fmt.code(String(w.eventId))} · ${fmt.i(state)}`;
    });
    await reply(ctx, [`📡 ${fmt.b('Watched events')}`, fmt.quote(rows)].join('\n'));
  },

  async team(ctx, { store }) {
    const text = args(ctx);
    let [sub, ...restTok] = text.split(/\s+/);
    const rest = restTok.join(' ').trim();
    const key = chatKey(ctx);
    const roster = store.roster(key);

    if (!sub || sub === 'list') {
      if (!roster.length) return reply(ctx, warn('Roster is empty. Add players with /team add &lt;name&gt; [@telegram].'));
      const rows = roster.map((e) => {
        const extra = [
          e.tg ? fmt.esc(fmt.handle(e.tg)) : null,
          e.tgId ? '🔗 DM' : null,
          e.id ? fmt.i(`id ${e.id}`) : null,
        ].filter(Boolean);
        return [fmt.b(e.name), ...extra].join(' · ');
      });
      return reply(ctx, [`👥 ${fmt.b('Roster')} · ${roster.length} player${roster.length === 1 ? '' : 's'}`, fmt.quote(rows)].join('\n'));
    }

    if (!(await isAllowed(ctx))) return reply(ctx, warn('Only group admins can change the roster.'));

    // "/team add a, b, c" is almost always a mislabelled import: treat it as one.
    if (sub === 'add' && rest.includes(',')) sub = 'import';

    if (sub === 'add') {
      const parsed = parseRosterEntry(rest);
      if (!parsed.name) return reply(ctx, usage('/team add <name> [@telegram] [id:123456]'));
      if (roster.some((e) => norm(e.name) === norm(parsed.name))) return reply(ctx, warn(`${fmt.b(parsed.name)} is already on the roster.`));
      const entry = { ...parsed, tgId: linkByHandle(store, parsed.tg), addedBy: ctx.from?.id ?? null, addedAt: new Date().toISOString() };
      roster.push(entry);
      store.save();
      const note = entry.tgId ? '🔗 DM alerts on' : parsed.tg ? `${fmt.esc(parsed.tg)} can DM me /start to get alerts` : '';
      return reply(ctx, [`✅ Added ${fmt.b(parsed.name)}${parsed.tg ? ` ${fmt.esc(parsed.tg)}` : ''} · roster is now ${roster.length}`, note ? fmt.i(note) : ''].filter(Boolean).join('\n'));
    }

    if (sub === 'import') {
      const names = rest.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) return reply(ctx, usage('/team import name1, name2, name3'));
      let added = 0;
      for (const n of names) {
        const parsed = parseRosterEntry(n);
        if (!parsed.name || roster.some((e) => norm(e.name) === norm(parsed.name))) continue;
        roster.push({ ...parsed, tgId: linkByHandle(store, parsed.tg), addedBy: ctx.from?.id ?? null, addedAt: new Date().toISOString() });
        added++;
      }
      store.save();
      return reply(ctx, `✅ Added ${fmt.b(String(added))} player${added === 1 ? '' : 's'} · roster is now ${roster.length}`);
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'del') {
      const queries = rest.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (!queries.length) return reply(ctx, usage('/team remove <name>[, name2, ...]'));
      const removed = [];
      const missing = [];
      const ambiguous = [];
      for (const q of queries) {
        const nq = norm(q);
        let hits = roster.filter((e) => norm(e.name) === nq);
        if (!hits.length) hits = roster.filter((e) => norm(e.name).includes(nq));
        if (hits.length === 1) {
          roster.splice(roster.indexOf(hits[0]), 1);
          removed.push(hits[0].name);
        } else if (hits.length > 1) {
          ambiguous.push(`${q} (${hits.map((e) => e.name).join(' / ')})`);
        } else {
          missing.push(q);
        }
      }
      if (removed.length) store.save();
      const lines = [];
      if (removed.length) lines.push(`🗑 Removed ${fmt.b((removed.join(', ')))} · roster is now ${roster.length}`);
      if (ambiguous.length) lines.push(warn(`Ambiguous, be more specific · ${fmt.esc(ambiguous.join('; '))}`));
      if (missing.length) lines.push(warn(`Not on the roster · ${fmt.esc(missing.join(', '))}${roster.length ? ` ${fmt.i('(see /team list)')}` : ''}`));
      return reply(ctx, lines.join('\n'));
    }

    if (sub === 'clear') {
      roster.splice(0, roster.length);
      store.save();
      return reply(ctx, '🗑 Roster cleared.');
    }

    return reply(ctx, usage('/team add|remove|import|list|clear'));
  },

  async status(ctx, { store }) {
    const { eventId } = parseTarget(args(ctx));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const st = await ed.loadStandings(ev);
    let matches = null;
    if (ev.currentRound) matches = (await api.roundMatches(ev.currentRound.id, { avoidCache: true })).map(interpretMatch);
    await reply(ctx, fmt.statusMessage({ ev, st, counts: ed.counts(ev, st), matches }));
  },

  async players(ctx, { store }) {
    const { eventId } = parseTarget(args(ctx));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const st = await ed.loadStandings(ev);
    await reply(ctx, fmt.playersMessage({ ev, counts: ed.counts(ev, st) }));
  },

  async leaderboard(ctx, { store }) {
    const { eventId } = parseTarget(args(ctx));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const roster = store.roster(chatKey(ctx));
    if (!roster.length) return reply(ctx, warn('Roster is empty. Add players with /team add &lt;name&gt;.'));
    const st = await ed.loadStandings(ev);
    if (!st) return reply(ctx, warn('No standings have been generated yet for this event.'));
    await reply(ctx, fmt.leaderboardMessage({ ev, st, roster, counts: ed.counts(ev, st) }));
  },

  // /legends [event] — legend breakdown; /legends <legend> [event] — every player on that legend.
  async legends(ctx, { store }) {
    const { eventId, rest } = parseTarget(args(ctx));
    const query = rest.join(' ');
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const st = await ed.loadStandings(ev);
    if (!st) return reply(ctx, warn('No standings have been generated yet for this event.'));
    const roster = store.roster(chatKey(ctx));
    if (!query) return reply(ctx, fmt.legendsMessage({ ev, st, roster }));
    const groups = ed.findLegendGroups(st, query);
    if (!groups.length) {
      const known = [...new Set([...st.byLegend.values()].map((g) => legendShort(g[0].legend)))].sort((a, c) => a.localeCompare(c));
      return reply(ctx, [warn(`No legend matching ${fmt.b(query)} in ${fmt.esc(ev.name)}.`), fmt.i(`Legends in play: ${known.join(', ')}`)].join('\n'));
    }
    if (groups.length > 3) {
      const found = groups.map((g) => legendShort(g[0].legend));
      return reply(ctx, warn(`${fmt.b(query)} matches ${groups.length} legends: ${fmt.esc(found.join(', '))}. Be more specific.`));
    }
    await reply(ctx, groups.map((group) => fmt.legendPlayersMessage({ ev, st, group, roster })).join('\n\n'));
  },

  async results(ctx, { store }) {
    const { eventId, round: roundNo } = parseTarget(args(ctx));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const roster = store.roster(chatKey(ctx));
    if (!roster.length) return reply(ctx, warn('Roster is empty. Add players with /team add &lt;name&gt;.'));
    const paired = ev.rounds.filter((r) => r.pairings_status === 'GENERATED');
    const round = roundNo ? paired.find((r) => r.round_number === roundNo) : paired.at(-1);
    if (!round) return reply(ctx, warn('That round has no pairings yet.'));
    const st = await ed.loadStandings(ev);
    const matches = (await api.roundMatches(round.id, { avoidCache: round.status !== 'COMPLETE' })).map(interpretMatch).filter((m) => !m.ghost);
    const ours = matches.map((m) => ({ m, hits: m.players.map((p) => ({ p, entry: matchRoster(roster, p) })).filter((h) => h.entry) })).filter((x) => x.hits.length);
    if (!ours.length) return reply(ctx, warn(`No roster players were paired in ${fmt.b(ev.label(round))}.`));
    const done = ours.filter((x) => x.m.status === 'COMPLETE');
    const pending = ours.filter((x) => x.m.status !== 'COMPLETE');
    const parts = [`📋 ${fmt.b(`${ev.label(round)} · Results`)} · ${fmt.i(`${done.length} done, ${pending.length} playing`)}`];
    for (const x of done) parts.push(fmt.resultMessage({ ev, round, ...x, st, withFooter: false }));
    if (pending.length) parts.push(fmt.pairingsMessage({ ev, round, ours: pending, st, emoji: '⏳', title: 'Still playing', withFooter: false }));
    parts.push(fmt.footer(ev));
    await reply(ctx, parts.join('\n\n'));
  },

  async pairings(ctx, { store }) {
    const { eventId } = parseTarget(args(ctx));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const roster = store.roster(chatKey(ctx));
    if (!roster.length) return reply(ctx, warn('Roster is empty. Add players with /team add &lt;name&gt;.'));
    const round = ev.currentRound;
    if (!round) return reply(ctx, warn('No round has been paired yet.'));
    const st = await ed.loadStandings(ev);
    const matches = (await api.roundMatches(round.id, { avoidCache: true })).map(interpretMatch).filter((m) => !m.ghost);
    const ours = matches.map((m) => ({ m, hits: m.players.map((p) => ({ p, entry: matchRoster(roster, p) })).filter((h) => h.entry) })).filter((x) => x.hits.length);
    if (!ours.length) return reply(ctx, warn(`No roster players are paired in ${fmt.b(ev.label(round))}.`));
    await reply(ctx, fmt.pairingsMessage({ ev, round, ours, st }));
  },

  async player(ctx, { store }) {
    const { eventId, rest } = parseTarget(args(ctx));
    const query = rest.join(' ');
    if (!query) return reply(ctx, usage('/player <name> [event]'));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const players = await ed.loadPlayers(ev);
    const player = ed.findPlayerByName(players, query);
    if (!player) return reply(ctx, warn(`No player matching ${fmt.b(query)} in ${fmt.esc(ev.name)}.`));
    const st = await ed.loadStandings(ev);
    const history = [];
    for (const round of ev.rounds) {
      if (round.pairings_status !== 'GENERATED') continue;
      const matches = await api.roundMatches(round.id, { avoidCache: round.status !== 'COMPLETE' });
      const m = matches.map(interpretMatch).find((x) => !x.ghost && x.players.some((p) => p.id === player.id));
      if (m) history.push({ round, m });
    }
    const entry = matchRoster(store.roster(chatKey(ctx)), player);
    await reply(ctx, fmt.playerHistoryMessage({ ev, player, history, st, entry }));
  },

  // /bets [event]: (re)post the betting board for the current round and list your open bets.
  async bets(ctx, { store, tracker }) {
    const { eventId } = parseTarget(args(ctx));
    const key = chatKey(ctx);
    const guild = store.guild(key);
    if (!betting.enabled(guild)) return reply(ctx, warn('Betting is turned off in this chat. An admin can /betting on.'));
    const ev = await loadOrExplain(ctx, store, eventId);
    if (!ev) return;
    const watch = store.watches(key)[ev.id];
    if (!watch) return reply(ctx, warn(`Bets only work on watched events. /watch ${ev.url} first.`));
    const lines = [];
    if (ctx.from) {
      const mine = betting.openEntries(watch).map((e) => ({ e, wg: e.wagers[String(ctx.from.id)] })).filter((x) => x.wg);
      if (mine.length) {
        lines.push(`${betting.COIN} ${fmt.b('Your open bets')} · ${fmt.i(`balance ${betting.coins(betting.wallet(guild, ctx.from).balance)}`)}`);
        lines.push(fmt.quote(mine.map(({ e, wg }) => `${fmt.esc(e.roundLabel)} · ${betting.coins(wg.amount)} on ${fmt.b(e.players[wg.side].name)} ${fmt.i(`vs ${e.players[1 - wg.side].name}`)}`)));
      }
    }
    const round = ev.currentRound;
    if (!round || round.status === 'COMPLETE') {
      lines.push(warn(round ? `${fmt.b(ev.label(round))} is over. Bets open again when the next round is paired.` : 'No round has been paired yet.'));
      store.save();
      return reply(ctx, lines.join('\n'));
    }
    if (lines.length) await reply(ctx, lines.join('\n'));
    const st = await ed.loadStandings(ev);
    const matches = (await api.roundMatches(round.id, { avoidCache: true })).map(interpretMatch);
    const { matches: offered, limited } = betting.openRound({ ev, watch, round, matches, roster: store.roster(key) });
    if (!offered.length) {
      store.save();
      return reply(ctx, warn(`Every match of ${fmt.b(ev.label(round))} is already finished.`));
    }
    for (const { html, matchIds } of betting.boardMessages({ ev, round, matches: offered, st, limited })) {
      const sent = await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: betting.keyboard(watch, matchIds) });
      if (sent?.message_id) watch.betMsgs[sent.message_id] = matchIds;
    }
    store.save();
  },

  // /bet <amount> <player> (or "/bet <player> <amount>", "all" for everything you have).
  async bet(ctx, { store, tracker }) {
    if (!ctx.from) return reply(ctx, warn('Run /bet from your own account.'));
    const key = chatKey(ctx);
    const guild = store.guild(key);
    if (!betting.enabled(guild)) return reply(ctx, warn('Betting is turned off in this chat.'));
    const toks = args(ctx).split(/\s+/).filter(Boolean);
    const idx = toks.findIndex((t) => /^\d+$/.test(t) || /^all$/i.test(t));
    const query = toks.filter((_, i) => i !== idx).join(' ');
    if (idx < 0 || !query) return reply(ctx, usage('/bet <amount|all> <player name>'));
    const eventId = resolveEventId(ctx, store, null);
    const watch = eventId ? store.watches(key)[eventId] : null;
    if (!watch) return reply(ctx, warn('Nothing is watched in this chat, so there is nothing to bet on.'));
    const hit = betting.findOpenPlayer(watch, query);
    if (hit.error) return reply(ctx, warn(fmt.esc(hit.error) + (Object.keys(watch.bets || {}).length ? '' : ' Post the board with /bets first.')));
    const w = betting.wallet(guild, ctx.from);
    const amount = /^all$/i.test(toks[idx]) ? w.balance : Number(toks[idx]);
    const res = betting.placeBet({ guild, watch, matchId: hit.entry.matchId, side: hit.side, from: ctx.from, amount });
    store.save();
    if (!res.ok) return reply(ctx, warn(fmt.esc(res.text)));
    await reply(ctx, `${fmt.esc(res.text)} ${fmt.i(`· ${hit.entry.roundLabel} vs ${hit.entry.players[1 - hit.side].name}`)}`);
    await tracker.refreshBoards(watch, [hit.entry.matchId]);
  },

  async coins(ctx, { store }) {
    if (!ctx.from) return reply(ctx, warn('Run /coins from your own account.'));
    const key = chatKey(ctx);
    const guild = store.guild(key);
    const html = betting.coinsMessage({ guild, from: ctx.from, watches: Object.values(store.watches(key)) });
    store.save();
    await reply(ctx, html);
  },

  // /betting on|off — admins turn the betting boards off or on for this chat.
  async betting(ctx, { store }) {
    const key = chatKey(ctx);
    const guild = store.guild(key);
    const sub = args(ctx).toLowerCase();
    if (sub !== 'on' && sub !== 'off') {
      return reply(ctx, `🎲 Betting is ${fmt.b(betting.enabled(guild) ? 'on' : 'off')} in this chat · ${usage('/betting on|off')}`);
    }
    if (!(await isAllowed(ctx))) return reply(ctx, warn('Only group admins can do that.'));
    guild.betting = sub === 'on';
    store.save();
    await reply(ctx, sub === 'on'
      ? '🎲 Betting is on: I will post a betting board when a round is paired.'
      : '🎲 Betting is off: no more boards. Open bets still settle. /betting on to turn it back on.');
  },
};

// Remember a user who opened a DM with the bot and link every roster entry carrying their @handle.
// Returns the entries that were newly linked.
function registerUser(store, from) {
  const u = store.user(from.id);
  u.username = from.username || null;
  u.firstName = from.first_name || null;
  if (!u.startedAt) u.startedAt = new Date().toISOString();
  const linked = [];
  if (from.username) {
    const want = from.username.toLowerCase();
    for (const { entry } of store.allRosterEntries()) {
      if ((entry.tg || '').replace(/^@/, '').toLowerCase() !== want) continue;
      if (Number(entry.tgId) === from.id) continue;
      entry.tgId = from.id;
      linked.push(entry);
    }
  }
  return linked;
}

// Telegram id of a user who already /start-ed the bot with this @handle, else null.
function linkByHandle(store, tg) {
  if (!tg) return null;
  const u = store.userByUsername(tg);
  return u?.startedAt ? u.tgId : null;
}

function parseRosterEntry(text) {
  const out = { name: '', tg: null, id: null, tgId: null };
  const toks = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (/^@\w{3,}$/.test(tok)) out.tg = tok;
    else if (/^id:(\d+)$/i.test(tok)) out.id = Number(tok.split(':')[1]);
    else toks.push(tok);
  }
  out.name = toks.join(' ').trim();
  return out;
}

async function loadOrExplain(ctx, store, explicitId) {
  const eventId = resolveEventId(ctx, store, explicitId);
  if (!eventId) {
    await reply(ctx, warn('No event given and nothing is watched in this chat. Use /watch &lt;url&gt; or pass the event url/id.'));
    return null;
  }
  try {
    return await ed.loadEvent(eventId);
  } catch (err) {
    await reply(ctx, warn(`Could not load event ${fmt.code(String(eventId))}: ${fmt.esc(err.status === 404 ? 'not found' : err.message)}`));
    return null;
  }
}

module.exports = { handlers, HELP, name, fullName };
