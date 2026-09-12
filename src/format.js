'use strict';
// Builds Telegram HTML messages. Every user-provided string goes through esc().
//
// Style rules, so every message looks the same:
//   - one emoji at the start of the header, a second one only when it carries meaning
//   - player names in <b>, game scores in <code>, side notes in <i>, dropped players in <s>
//   - the details of a message live in one <blockquote>; long lists use <blockquote expandable>
//   - the last line is an italic footer with the event link
//   - ⭐ = best-placed player on their legend in the whole event, ❤️ = on this chat's roster
const { name, fullName, record, legendShort, outcomeFor, opponentOf, matchRoster } = require('./model');
const { isBestOfLegend } = require('./eventdata');

const MAX_LEN = 4000;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b(s) { return `<b>${esc(s)}</b>`; }
function i(s) { return `<i>${esc(s)}</i>`; }
function s(t) { return `<s>${esc(t)}</s>`; }
function code(t) { return `<code>${esc(t)}</code>`; }
function link(text, url) { return `<a href="${esc(url)}">${esc(text)}</a>`; }

// One blockquote from a list of already escaped lines; empty lines are dropped.
function quote(lines, { expandable = false } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).filter((l) => l != null && l !== '').join('\n');
  return `<blockquote${expandable ? ' expandable' : ''}>${body}</blockquote>`;
}

function footer(ev, ...extra) {
  const parts = [...extra.filter(Boolean).map(esc), link(ev.name, ev.url)];
  return `<i>${parts.join(' · ')}</i>`;
}

function handle(tg) {
  if (!tg) return '';
  return tg.startsWith('@') ? tg : `@${tg}`;
}
function mention(entry) {
  return entry?.tg ? ` ${esc(handle(entry.tg))}` : '';
}

// Short status word for a lifecycle value such as EVENT_IN_PROGRESS.
function prettyLifecycle(v) {
  if (!v) return 'unknown';
  return v.replace(/^EVENT_/, '').toLowerCase().replace(/_/g, ' ');
}

// "#3" padded to the widest rank in the list so a column of them lines up in <code>.
function rankCell(rank, width) {
  return code(`#${rank}`.padEnd(width + 1));
}
function rankWidth(rows) {
  return rows.reduce((w, r) => Math.max(w, String(r.rank ?? '').length), 1);
}

function bar(done, total, size = 10) {
  if (!total) return '';
  const f = Math.round((size * done) / total);
  return '▰'.repeat(f) + '▱'.repeat(size - f);
}

// "3-1-0 · 9 pts · #3 of 64 after Round 3"
function pointsLine(p, st, ev) {
  const row = st?.byId.get(p.id);
  let out = `${esc(record(p))} · ${b(`${p.points} pts`)}`;
  if (row) out += ` · #${row.rank} of ${st.total} ${i(`after ${ev.label(st.round)}`)}`;
  return out;
}

function bestOfNote(p, st) {
  const row = st?.byId.get(p.id);
  if (!row || !isBestOfLegend(st, p.id)) return '';
  const n = st.byLegend.get(row.legendId)?.length ?? 0;
  return `⭐ Best ${esc(legendShort(row.legend))} in the event · ${n} playing it`;
}

const RESULT_EMOJI = { WIN: '✅', LOSS: '❌', DRAW: '🤝', BYE: '🎟', DOUBLE_LOSS: '⛔', PENDING: '⏳' };

// Plain "won 2-1 vs X" phrase for a stored outcome, from one player's point of view.
function outcomePhrase(m, playerId) {
  const o = outcomeFor(m, playerId);
  const opp = opponentOf(m, playerId);
  if (o.result === 'BYE') return 'bye';
  if (o.result === 'WIN') return `won ${o.score}${opp ? ` vs ${name(opp)}` : ''}`;
  if (o.result === 'LOSS') return `lost ${o.score}${opp ? ` vs ${name(opp)}` : ''}`;
  if (o.result === 'DRAW') return `drew ${o.score}${opp ? ` with ${name(opp)}` : ''}`;
  return 'no result (double loss)';
}

// Opponent side note: "(Mathieu B · 2-0-0 · #5)"; the display name only when it differs from the nickname.
function oppNote(opp, st) {
  const bits = [];
  if (fullName(opp) !== name(opp)) bits.push(opp.displayName);
  bits.push(record(opp));
  const row = st?.byId.get(opp.id);
  if (row) bits.push(`#${row.rank}`);
  return `(${bits.join(' · ')})`;
}

// A single completed match involving one or two roster players. `previous` is the outcome that was posted
// earlier (see model.matchOutcome) when a judge has since corrected the match.
function resultMessage({ ev, round, m, hits, st, previous = null, withFooter = true }) {
  const rl = ev.label(round);
  const mentions = hits.map((h) => mention(h.entry)).join('');
  const out = [];
  if (previous) {
    const before = { ...m, ...previous, status: 'COMPLETE' };
    const was = hits.map((h) => `${name(h.p)} ${outcomePhrase(before, h.p.id)}`).join(', ');
    out.push(`✏️ ${b('Corrected')} · ${s(was)}`);
  }

  if (hits.length === 2) {
    const [a, c] = hits.map((h) => h.p);
    const oa = outcomeFor(m, a.id);
    const winner = oa.result === 'WIN' ? a : oa.result === 'LOSS' ? c : null;
    const loser = winner ? (winner === a ? c : a) : null;
    out.push(`🔁 ${b(rl)} · team mirror${mentions}`);
    if (winner) out.push(`${b(name(winner))} beat ${b(name(loser))} ${code(outcomeFor(m, winner.id).score)}`);
    else out.push(`${b(name(a))} and ${b(name(c))} · ${oa.result === 'DRAW' ? 'draw' : 'no result'}`);
    for (const p of [a, c]) {
      out.push(quote([
        `${b(fullName(p))} · ${esc(legendShort(p.legend))}`,
        pointsLine(p, st, ev),
        bestOfNote(p, st),
      ]));
    }
  } else {
    const me = hits[0].p;
    const opp = opponentOf(m, me.id);
    const o = outcomeFor(m, me.id);
    const emoji = RESULT_EMOJI[o.result] || '';
    let head;
    if (o.result === 'BYE') head = `${b(name(me))} has a bye`;
    else if (o.result === 'WIN') head = `${b(name(me))} won ${code(o.score)} vs ${b(name(opp))}`;
    else if (o.result === 'LOSS') head = `${b(name(me))} lost ${code(o.score)} vs ${b(name(opp))}`;
    else if (o.result === 'DRAW') head = `${b(name(me))} drew ${code(o.score)} with ${b(name(opp))}`;
    else head = `${b(name(me))} vs ${b(name(opp))} · no result (double loss)`;
    out.push(`${emoji} ${b(rl)} · ${head}${mentions}`);
    const legends = opp
      ? `${esc(legendShort(me.legend))} vs ${esc(legendShort(opp.legend))} ${i(oppNote(opp, st))}`
      : esc(legendShort(me.legend));
    out.push(quote([legends, pointsLine(me, st, ev), bestOfNote(me, st)]));
  }
  if (withFooter) out.push(footer(ev, tableLabel(m)));
  return out.join('\n');
}

function tableLabel(m) {
  return m.table != null && m.table >= 0 ? `Table ${m.table}` : '';
}

// Pairings for a freshly generated round (or the matches still running, via `title`).
function pairingsMessage({ ev, round, ours, st, emoji = '🪑', title = 'Pairings', withFooter = true }) {
  const out = [`${emoji} ${b(`${ev.label(round)} · ${title}`)}`];
  const blocks = [];
  for (const { m, hits } of ours) {
    for (const { p, entry } of hits) {
      const opp = opponentOf(m, p.id);
      if (m.isBye || !opp) {
        blocks.push(`🎟 ${b(name(p))} · bye${mention(entry)}`);
        continue;
      }
      const table = tableLabel(m);
      blocks.push(
        `${b(name(p))} vs ${b(name(opp))}${table ? ` · ${esc(table)}` : ''}${mention(entry)}\n`
        + i(`${legendShort(p.legend)} vs ${legendShort(opp.legend)} ${oppNote(opp, st)}`),
      );
    }
  }
  out.push(quote(blocks.join('\n\n')));
  if (withFooter) out.push(footer(ev));
  return out.join('\n');
}

// One standings row: "#3  astar · 3-0-0 · 9 pts · Kennen ⭐"; roster players are bold, dropped ones struck.
function standingRow(r, { width, st, entry, boldAll = false, markRoster = false }) {
  const dropped = r.status === 'DROPPED';
  const nm = dropped ? s(name(r)) : boldAll || entry ? b(name(r)) : esc(name(r));
  const bits = [
    `${rankCell(r.rank, width)} ${nm}${markRoster && entry ? ' ❤️' : ''}${entry ? mention(entry) : ''}`,
    esc(record(r)),
    boldAll ? b(`${r.points} pts`) : esc(`${r.points} pts`),
  ];
  return bits.join(' · ');
}

// Roster leaderboard from a standings snapshot.
function standingsMessage({ ev, st, roster, counts, emoji = '📊', title = 'Standings', sub }) {
  const ours = st.rows.filter((r) => matchRoster(roster, r));
  const head = `${emoji} ${b(title)} · ${i(sub === undefined ? `after ${ev.label(st.round)}` : sub)}`;
  const out = [head];
  if (!ours.length) {
    out.push(i('None of the roster players appear in the standings.'));
  } else {
    const width = rankWidth(ours);
    out.push(quote(ours.map((r) => {
      let line = `${standingRow(r, { width, st, boldAll: true })} · ${esc(legendShort(r.legend))}`;
      if (isBestOfLegend(st, r.id)) line += ' ⭐';
      if (r.status === 'DROPPED') line += ` ${i('dropped')}`;
      return line;
    })));
  }
  const still = counts?.total != null ? `${counts.active ?? '?'} of ${counts.total} still in` : '';
  out.push(footer(ev, still));
  return out.join('\n');
}

function statusMessage({ ev, st, counts, matches }) {
  const e = ev.event;
  const rows = [`Status · ${b(prettyLifecycle(ev.lifecycle))}`];
  const cur = ev.currentRound;
  if (cur) {
    const total = cur.phase.numberOfRounds;
    const state = cur.status.toLowerCase().replace(/_/g, ' ');
    rows.push(`Round · ${b(`${ev.label(cur).replace(/^Round /, '')} of ${total}`)} · ${esc(state)}`);
    if (matches?.length) {
      const done = matches.filter((m) => m.status === 'COMPLETE').length;
      rows.push(`Matches · ${bar(done, matches.length)} ${done}/${matches.length} reported`);
    }
  } else {
    rows.push('Round · not paired yet');
  }
  if (e.timer_end_datetime) {
    const end = new Date(e.timer_end_datetime);
    if (e.timer_is_running) {
      const mins = Math.max(0, Math.round((end - Date.now()) / 60000));
      rows.push(`⏱ Timer · ${b(`${mins} min`)} left · ends ${esc(end.toISOString().slice(11, 16))} UTC`);
    } else if (e.timer_paused_at_datetime) {
      rows.push('⏱ Timer · paused');
    }
  }
  if (counts.total != null) {
    rows.push(`👥 Players · ${b(String(counts.active ?? '?'))} of ${counts.total} still in · ${counts.dropped ?? '?'} dropped`);
  }
  if (st) rows.push(`Standings · through ${esc(ev.label(st.round))}`);
  return [`🏟 ${b(ev.name)}`, quote(rows), `<i>${link('open event', ev.url)}</i>`].join('\n');
}

function playersMessage({ ev, counts }) {
  const head = `👥 ${b(ev.name)}`;
  if (counts.total == null) return [head, i('Player counts are not available yet (event not started).')].join('\n');
  const rows = [
    `Total · ${b(String(counts.total))}`,
    `Still in · ${b(String(counts.active ?? '?'))}`,
    `Dropped · ${b(String(counts.dropped ?? '?'))}`,
  ];
  if (ev.currentRound) rows.push(`Round · ${esc(ev.label(ev.currentRound).replace(/^Round /, ''))} of ${ev.currentRound.phase.numberOfRounds}`);
  return [head, quote(rows), footer(ev)].join('\n');
}

function legendsMessage({ ev, st, roster, limit = 15 }) {
  const active = st.rows.filter((r) => r.status !== 'DROPPED');
  const groups = [...st.byLegend.values()]
    .map((list) => ({
      legend: list[0].legend,
      count: list.filter((r) => r.status !== 'DROPPED').length,
      best: list[0],
      ours: list.filter((r) => matchRoster(roster, r)).length,
    }))
    .filter((g) => g.count > 0)
    .sort((a, c) => c.count - a.count);
  const out = [`🃏 ${b('Legends')} · ${i(`after ${ev.label(st.round)}`)}`];
  const rows = groups.slice(0, limit).map((g) => {
    const pct = ((100 * g.count) / active.length).toFixed(1);
    const bestIsOurs = !!matchRoster(roster, g.best);
    const others = g.ours - (bestIsOurs ? 1 : 0);
    let line = `${b(legendShort(g.legend))} ${g.count} ${i(`${pct}%`)} · ⭐ ${esc(name(g.best))} #${g.best.rank}${bestIsOurs ? ' ❤️' : ''}`;
    if (others > 0) line += ` · +${others} ours`;
    return line;
  });
  out.push(quote(rows));
  const unknown = active.filter((r) => !r.legendId).length;
  const notes = ['⭐ best-placed pilot', '❤️ on the roster'];
  if (unknown) notes.push(`${unknown} without a registered legend`);
  out.push(footer(ev, ...notes));
  return out.join('\n');
}

// Every player on one legend, best-placed first. Roster players are marked; long lists are cut but
// roster players below the cut are still shown.
function legendPlayersMessage({ ev, st, group, roster, limit = 40 }) {
  const active = st.rows.filter((r) => r.status !== 'DROPPED').length;
  const playing = group.filter((r) => r.status !== 'DROPPED');
  const pct = active ? ((100 * playing.length) / active).toFixed(1) : '0.0';
  const legend = group[0].legend;
  const short = legendShort(legend);
  const sub = [];
  if (legend && legend !== short) sub.push(legend);
  sub.push(`${playing.length} playing`, `${pct}% of the field`);
  if (group.length > playing.length) sub.push(`${group.length - playing.length} dropped`);
  const out = [`🃏 ${b(short)} · ${i(`after ${ev.label(st.round)}`)}`, i(sub.join(' · '))];

  const width = rankWidth(group);
  const line = (r) => {
    let l = standingRow(r, { width, st, entry: matchRoster(roster, r), markRoster: true });
    if (isBestOfLegend(st, r.id)) l += ' ⭐';
    if (r.status === 'DROPPED') l += ` ${i('dropped')}`;
    return l;
  };
  const shown = group.slice(0, limit).map(line);
  const rest = group.slice(limit);
  const oursBelow = rest.filter((r) => matchRoster(roster, r));
  if (oursBelow.length) shown.push('…', ...oursBelow.map(line));
  const hidden = rest.length - oursBelow.length;
  if (hidden > 0) shown.push(i(`… and ${hidden} more`));
  out.push(quote(shown, { expandable: shown.length > 12 }));
  out.push(footer(ev));
  return out.join('\n');
}

function playerHistoryMessage({ ev, player, history, st, entry }) {
  const out = [`👤 ${b(fullName(player))}${mention(entry)}`];
  const row = st?.byId.get(player.id);
  const legend = row?.legend || player.legend;
  const info = [];
  if (legend) info.push(esc(legend));
  info.push(pointsLine(row || player, st, ev), bestOfNote(player, st));
  if (row) info.push(i(`OMW ${(row.omw * 100).toFixed(1)}% · GW ${(row.gw * 100).toFixed(1)}% · OGW ${(row.ogw * 100).toFixed(1)}%`));
  if (player.status === 'DROPPED') info.push('⚠️ Dropped from the event');
  out.push(quote(info));

  if (!history.length) {
    out.push(i('No matches yet.'));
  } else {
    const rows = history.map(({ round, m }) => {
      const o = outcomeFor(m, player.id);
      const opp = opponentOf(m, player.id);
      const emoji = RESULT_EMOJI[o.result] || '';
      const rl = ev.multiPhase ? `${round.phase.name} R${round.round_number}` : `R${round.round_number}`;
      if (o.result === 'BYE') return `${emoji} ${b(rl)} bye`;
      const vs = opp ? `vs ${esc(name(opp))} ${i(`(${legendShort(opp.legend)})`)}` : '';
      const table = m.table != null && m.table >= 0 ? ` · T${m.table}` : '';
      if (o.result === 'PENDING') return `${emoji} ${b(rl)} ${vs}${table} · playing`;
      const score = o.result === 'DOUBLE_LOSS' ? 'no result' : code(o.score);
      return `${emoji} ${b(rl)} ${score} ${vs}${table}`;
    });
    out.push(quote(rows));
  }
  out.push(footer(ev));
  return out.join('\n');
}

// The roster leaderboard, as posted by /leaderboard and after every round.
function leaderboardMessage({ ev, st, roster, counts }) {
  return standingsMessage({ ev, st, roster, counts, emoji: '🏆', title: 'Team leaderboard' });
}

function finalMessage({ ev, st, roster, counts }) {
  return standingsMessage({ ev, st, roster, counts, emoji: '🏁', title: 'Final standings', sub: 'event finished' });
}

// Split a long HTML message on line boundaries so each part fits Telegram's limit. A blockquote that
// straddles the cut is closed at the end of one part and reopened at the start of the next.
function chunk(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let cur = '';
  let open = null; // the <blockquote …> tag still open at the end of `cur`
  let fresh = true; // `cur` holds nothing but a reopened tag
  for (const line of text.split('\n')) {
    if (!fresh && cur.length + line.length + 1 + (open ? 13 : 0) > MAX_LEN) {
      parts.push(open ? `${cur}</blockquote>` : cur);
      cur = open || '';
      fresh = true;
    }
    cur += (fresh ? '' : '\n') + line;
    fresh = false;
    for (const tag of line.match(/<\/?blockquote[^>]*>/g) || []) open = tag.startsWith('</') ? null : tag;
  }
  if (cur) parts.push(cur);
  return parts;
}

module.exports = {
  esc, b, i, s, code, link, quote, footer, handle, prettyLifecycle, chunk,
  resultMessage, pairingsMessage, standingsMessage, statusMessage, playersMessage,
  legendsMessage, legendPlayersMessage, playerHistoryMessage, leaderboardMessage, finalMessage,
};
