'use strict';
// Loads an event and derives the views the bot needs (rounds, standings, counts).
const api = require('./api');
const { playerFromStanding, playerFromRegistration, norm, legendShort } = require('./model');

function flattenRounds(event) {
  const phases = [...(event.tournament_phases || [])].sort((a, b) => a.order_in_phases - b.order_in_phases);
  const out = [];
  for (const p of phases) {
    const rounds = [...(p.rounds || [])].sort((a, b) => a.round_number - b.round_number);
    for (const r of rounds) {
      out.push({
        ...r,
        phase: {
          id: p.id, name: p.phase_name, type: p.round_type, order: p.order_in_phases,
          numberOfRounds: p.number_of_rounds, status: p.status,
        },
      });
    }
  }
  return out;
}

async function loadEvent(eventId, { fresh = false } = {}) {
  const event = await api.event(eventId, { avoidCache: fresh });
  const rounds = flattenRounds(event);
  const multiPhase = (event.tournament_phases || []).length > 1;
  const label = (r) => (multiPhase ? `${r.phase.name} R${r.round_number}` : `Round ${r.round_number}`);
  return {
    id: eventId,
    event,
    rounds,
    multiPhase,
    label,
    name: event.name,
    url: api.eventUrl(eventId),
    lifecycle: event.settings?.event_lifecycle_status || null,
    currentRound: [...rounds].reverse().find((r) => r.pairings_status === 'GENERATED') || null,
    latestStandingsRound: [...rounds].reverse().find((r) => r.standings_status === 'GENERATED') || null,
  };
}

// Standings are cached briefly: they only change when a round is (re)generated.
const standingsCache = new Map();
const STANDINGS_TTL_MS = 2 * 60 * 1000;

async function loadStandingsForRound(round) {
  const hit = standingsCache.get(round.id);
  if (hit && Date.now() - hit.at < STANDINGS_TTL_MS) return hit.value;
  const rows = (await api.roundStandings(round.id)).map(playerFromStanding);
  const value = indexStandings(round, rows);
  standingsCache.set(round.id, { at: Date.now(), value });
  return value;
}

async function loadStandings(ev) {
  if (!ev.latestStandingsRound) return null;
  return loadStandingsForRound(ev.latestStandingsRound);
}

function indexStandings(round, rows) {
  rows.sort((a, b) => a.rank - b.rank);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byLegend = new Map();
  for (const r of rows) {
    if (!r.legendId) continue;
    if (!byLegend.has(r.legendId)) byLegend.set(r.legendId, []);
    byLegend.get(r.legendId).push(r);
  }
  const active = rows.filter((r) => r.status !== 'DROPPED').length;
  return { round, rows, byId, byLegend, total: rows.length, active, dropped: rows.length - active };
}

// True when this player is the best-ranked player on their legend in the standings.
function isBestOfLegend(st, playerId) {
  const p = st?.byId.get(playerId);
  if (!p || !p.legendId) return false;
  const list = st.byLegend.get(p.legendId);
  return !!list && list[0].id === playerId;
}

// Legend groups (from st.byLegend) whose name matches a query: exact short name ("Kennen") first,
// then any legend whose full name contains the query. Returns [] when nothing matches.
function findLegendGroups(st, query) {
  const q = norm(query);
  if (!q || !st) return [];
  const groups = [...st.byLegend.values()];
  const exact = groups.filter((g) => norm(legendShort(g[0].legend)) === q || norm(g[0].legend) === q);
  if (exact.length) return exact;
  return groups.filter((g) => norm(g[0].legend).includes(q));
}

// Player counts, preferring the event's own numbers and falling back to standings.
function counts(ev, st) {
  const e = ev.event;
  const total = e.starting_player_count ?? st?.total ?? null;
  const active = e.registered_user_count ?? st?.active ?? null;
  return {
    total,
    active,
    dropped: total != null && active != null ? total - active : st?.dropped ?? null,
  };
}

// All players in the event (from standings if any, else registrations).
async function loadPlayers(ev) {
  const st = await loadStandings(ev);
  if (st) return st.rows;
  return (await api.registrations(ev.id)).map(playerFromRegistration);
}

function findPlayerByName(players, query) {
  const q = norm(query);
  if (!q) return null;
  return (
    players.find((p) => norm(p.nickname) === q || norm(p.displayName) === q)
    || players.find((p) => norm(p.nickname).includes(q) || norm(p.displayName).includes(q))
    || null
  );
}

module.exports = {
  flattenRounds, loadEvent, loadStandings, loadStandingsForRound, indexStandings,
  isBestOfLegend, findLegendGroups, counts, loadPlayers, findPlayerByName,
};
