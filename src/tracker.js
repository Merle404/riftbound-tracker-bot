'use strict';
// Polls every watched event and posts new results, pairings and the roster leaderboard to its chat.
const api = require('./api');
const { interpretMatch, matchRoster, matchOutcome, sameOutcome } = require('./model');
const ed = require('./eventdata');
const fmt = require('./format');
const betting = require('./betting');

class Tracker {
  constructor({ store, send, dm = null, editMarkup = null, log = console, intervalMs = 45000 }) {
    this.store = store;
    this.send = send; // async (chatKey, watch, html, { replyMarkup }?) => sent message (or nothing)
    this.dm = dm; // async (tgId, html) => void — optional, for linked players
    this.editMarkup = editMarkup; // async (chatId, msgId, keyboard) => void — optional, refreshes betting boards
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    const loop = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.tick(); } catch (err) { this.log.error('tick failed', err); }
      this.running = false;
    };
    loop();
    this.timer = setInterval(loop, this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    for (const [chatKey, g] of Object.entries(this.store.data.guilds)) {
      for (const watch of Object.values(g.watches || {})) {
        if (watch.finished) continue;
        try {
          await this.pollWatch(chatKey, watch);
          watch.lastError = null;
        } catch (err) {
          watch.lastError = `${new Date().toISOString()} ${err.message}`;
          this.log.error(`poll ${watch.eventId} for ${chatKey}:`, err.message);
        }
        this.store.save();
      }
    }
  }

  // Post the betting board(s) for a round and remember which message shows which matches.
  async postBoard(chatKey, watch, { ev, round, matches, st }) {
    const roster = this.store.roster(chatKey);
    const { matches: offered, limited } = betting.openRound({ ev, watch, round, matches, roster });
    if (!offered.length) return 0;
    for (const { html, matchIds } of betting.boardMessages({ ev, round, matches: offered, st, limited })) {
      const sent = await this.send(chatKey, watch, html, { replyMarkup: betting.keyboard(watch, matchIds) });
      if (sent?.message_id) watch.betMsgs[sent.message_id] = matchIds;
    }
    return offered.length;
  }

  // Redraw the buttons of every board that shows one of these matches (totals, results).
  async refreshBoards(watch, matchIds) {
    if (!this.editMarkup || !matchIds.length) return;
    for (const { msgId, matchIds: ids } of betting.boardsShowing(watch, matchIds)) {
      try {
        await this.editMarkup(watch.channelId, msgId, betting.keyboard(watch, ids));
      } catch (err) {
        const why = err.description || err.message || '';
        if (!/not modified/i.test(why)) this.log.error(`refresh board ${msgId}:`, why);
      }
    }
  }

  // Returns a short summary of what happened (used by /watch for its first run).
  async pollWatch(chatKey, watch) {
    const roster = this.store.roster(chatKey);
    const guild = this.store.guild(chatKey);
    const ev = await ed.loadEvent(watch.eventId, { fresh: true });
    watch.name = ev.name;
    const first = !watch.initialized;
    const quiet = first && !watch.backfill; // first pass: learn state, do not spam history
    const post = async (html) => {
      if (quiet) return;
      for (const part of fmt.chunk(html)) await this.send(chatKey, watch, part);
    };
    const summary = { results: 0, corrections: 0, pairings: 0, standings: 0, dms: 0, boards: 0, settled: 0 };
    const settled = []; // { roundLabel, line } for the settlement post
    const touched = []; // match ids whose board buttons need a redraw

    // DM a linked roster player once per (player, key), no matter how many chats track the event.
    // Best effort: a user who blocked the bot or never opened a DM just gets skipped.
    const dmPlayer = async (entry, key, html) => {
      if (quiet || !this.dm || !entry.tgId) return;
      if (String(entry.tgId) === String(chatKey)) return; // the watch already posts to their DM
      const u = this.store.user(entry.tgId);
      if (u.dmSent[key]) return;
      u.dmSent[key] = true;
      try {
        for (const part of fmt.chunk(html)) await this.dm(entry.tgId, part);
        summary.dms++;
      } catch (err) {
        this.log.error(`dm ${entry.name} (${entry.tgId}) failed:`, err.description || err.message);
      }
    };
    // In a DM the @handle ping is noise; render the same message without it.
    const noPing = (hits) => hits.map((h) => ({ ...h, entry: { ...h.entry, tg: null } }));

    const st = await ed.loadStandings(ev);
    const cnt = ed.counts(ev, st);

    // Roster leaderboard: one per round, once that round's standings exist. Only the newest unposted
    // round is posted (older ones are marked as seen) and it goes out after the new round's pairings.
    const pendingStandings = ev.rounds.filter((r) => r.standings_status === 'GENERATED' && !watch.postedStandings[r.id]);
    for (const r of pendingStandings) watch.postedStandings[r.id] = true;
    const newestStandings = pendingStandings.at(-1);

    // Rounds with pairings: report pairings once, each completed match once, and a correction whenever a
    // judge edits an already reported result (only possible while the round is not finalized).
    for (const round of ev.rounds) {
      if (round.pairings_status !== 'GENERATED') continue;
      if (watch.finalizedRounds[round.id]) continue;
      const live = round.status !== 'COMPLETE';
      const matches = (await api.roundMatches(round.id, { avoidCache: live }))
        .map(interpretMatch)
        .filter((m) => !m.ghost);
      const ours = [];
      for (const m of matches) {
        const hits = m.players.map((p) => ({ p, entry: matchRoster(roster, p) })).filter((h) => h.entry);
        if (hits.length) ours.push({ m, hits });
      }

      if (!watch.postedPairings[round.id]) {
        watch.postedPairings[round.id] = true;
        if (live && ours.length) {
          await post(fmt.pairingsMessage({ ev, round, ours, st }));
          summary.pairings++;
          for (const { m, hits } of ours) {
            for (const hit of hits) {
              await dmPlayer(hit.entry, `p:${round.id}:${m.id}`, fmt.pairingsMessage({ ev, round, ours: [{ m, hits: noPing([hit]) }], st }));
            }
          }
        }
        if (live && !quiet && betting.enabled(guild)) {
          summary.boards += await this.postBoard(chatKey, watch, { ev, round, matches, st });
        }
      }

      for (const { m, hits } of ours) {
        if (m.status !== 'COMPLETE') continue;
        const outcome = matchOutcome(m);
        const prev = watch.reportedMatches[m.id];
        if (prev === true) { // reported by an older version that kept no outcome: adopt this one silently
          watch.reportedMatches[m.id] = outcome;
          continue;
        }
        if (prev && sameOutcome(prev, outcome)) continue;
        const previous = prev || null;
        watch.reportedMatches[m.id] = outcome;
        await post(fmt.resultMessage({ ev, round, m, hits, st, previous }));
        if (previous) summary.corrections++; else summary.results++;
        const html = fmt.resultMessage({ ev, round, m, hits: noPing(hits), st, previous });
        const dmKey = previous ? `r:${m.id}:${m.updatedAt || JSON.stringify(outcome)}` : `r:${m.id}`;
        for (const hit of hits) await dmPlayer(hit.entry, dmKey, html);
      }

      // Settle bets on every match that just completed; refund what is still open once the round is final.
      if (watch.bets) {
        for (const m of matches) {
          const entry = watch.bets[m.id];
          if (!entry?.open || m.status !== 'COMPLETE') continue;
          const line = betting.settle(guild, entry, m);
          touched.push(m.id);
          if (line) settled.push({ roundLabel: entry.roundLabel, line });
        }
        if (!live) {
          for (const { entry, line } of betting.refundOpen(guild, watch, round.id)) {
            touched.push(entry.matchId);
            if (line) settled.push({ roundLabel: entry.roundLabel, line });
          }
        }
      }

      if (!live) watch.finalizedRounds[round.id] = true;
    }

    if (settled.length) {
      const byRound = new Map();
      for (const { roundLabel, line } of settled) {
        if (!byRound.has(roundLabel)) byRound.set(roundLabel, []);
        byRound.get(roundLabel).push(line);
      }
      for (const [roundLabel, lines] of byRound) await post(betting.settledMessage({ ev, roundLabel, lines }));
      summary.settled = settled.length;
    }
    if (touched.length) await this.refreshBoards(watch, touched);

    if (newestStandings && roster.length) {
      const snap = st && st.round.id === newestStandings.id ? st : await ed.loadStandingsForRound(newestStandings);
      await post(fmt.leaderboardMessage({ ev, st: snap, roster, counts: cnt }));
      summary.standings++;
    }

    if (ev.lifecycle === 'EVENT_FINISHED') {
      watch.finished = true;
      const refunded = betting.refundOpen(guild, watch);
      const lines = refunded.filter((r) => r.line);
      if (lines.length) await post(betting.settledMessage({ ev, roundLabel: 'Event over', lines: lines.map((r) => r.line) }));
      if (refunded.length) await this.refreshBoards(watch, refunded.map((r) => r.entry.matchId));
      if (st && roster.length) await post(fmt.finalMessage({ ev, st, roster, counts: cnt }));
    }

    watch.initialized = true;
    return { ev, st, counts: cnt, summary };
  }
}

module.exports = { Tracker };
