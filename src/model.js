'use strict';
// Pure helpers that turn raw API objects into the small shapes the bot works with.

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function legendShort(name) {
  if (!name) return 'Unknown';
  return name.split(',')[0].trim();
}

function playerFromRel(rel) {
  const ues = rel.user_event_status || {};
  const card = ues.deck_defining_card || null;
  return {
    id: rel.player?.id ?? ues.user?.id ?? null,
    displayName: rel.player?.best_identifier || ues.user?.best_identifier || '?',
    nickname: ues.best_identifier || null,
    legend: card?.name || null,
    legendId: card?.id || null,
    won: ues.matches_won ?? 0,
    lost: ues.matches_lost ?? 0,
    drawn: ues.matches_drawn ?? 0,
    points: ues.total_match_points ?? 0,
    status: ues.registration_status || null,
  };
}

function playerFromStanding(row) {
  const ues = row.user_event_status || {};
  const card = ues.deck_defining_card || null;
  return {
    id: row.player?.id ?? row.id,
    displayName: row.player?.best_identifier || '?',
    nickname: ues.best_identifier || null,
    legend: card?.name || null,
    legendId: card?.id || null,
    won: ues.matches_won ?? 0,
    lost: ues.matches_lost ?? 0,
    drawn: ues.matches_drawn ?? 0,
    points: row.points ?? row.match_points ?? ues.total_match_points ?? 0,
    status: ues.registration_status || null,
    rank: row.rank,
    record: row.record,
    omw: row.opponent_match_win_percentage,
    gw: row.game_win_percentage,
    ogw: row.opponent_game_win_percentage,
  };
}

function playerFromRegistration(reg) {
  return {
    id: reg.user?.id ?? null,
    displayName: reg.user?.best_identifier || '?',
    nickname: reg.best_identifier || null,
    legend: null,
    legendId: null,
    won: reg.matches_won ?? 0,
    lost: reg.matches_lost ?? 0,
    drawn: reg.matches_drawn ?? 0,
    points: reg.total_match_points ?? 0,
    status: reg.registration_status || null,
    finalPlace: reg.final_place_in_standings ?? null,
  };
}

function name(p) { return p.nickname || p.displayName; }
function fullName(p) {
  if (p.nickname && norm(p.nickname) !== norm(p.displayName)) return `${p.nickname} (${p.displayName})`;
  return p.displayName;
}
function record(p) { return p.record || `${p.won}-${p.lost}-${p.drawn}`; }

function interpretMatch(match) {
  const players = (match.player_match_relationships || []).map(playerFromRel);
  return {
    id: match.id,
    status: match.status,
    table: match.table_number,
    roundId: match.tournament_round,
    players,
    isBye: !!match.match_is_bye,
    isDoubleLoss: !!match.match_is_loss,
    isDraw: !!(match.match_is_intentional_draw || match.match_is_unintentional_draw),
    winnerId: match.winning_player ?? null,
    gamesWinner: match.games_won_by_winner ?? 0,
    gamesLoser: match.games_won_by_loser ?? 0,
    gamesDrawn: match.games_drawn ?? 0,
    ghost: !!match.is_ghost_match,
    updatedAt: match.updated_at,
  };
}

// Result of a completed match from one player's point of view.
function outcomeFor(m, playerId) {
  if (m.isBye) return { result: 'BYE', score: null };
  if (m.status !== 'COMPLETE') return { result: 'PENDING', score: null };
  if (m.isDraw) return { result: 'DRAW', score: `${m.gamesWinner}-${m.gamesLoser}` };
  if (m.isDoubleLoss || m.winnerId == null) return { result: 'DOUBLE_LOSS', score: null };
  if (m.winnerId === playerId) return { result: 'WIN', score: `${m.gamesWinner}-${m.gamesLoser}` };
  return { result: 'LOSS', score: `${m.gamesLoser}-${m.gamesWinner}` };
}

// The part of a completed match a judge can change; stored per reported match so a later edit is noticed.
function matchOutcome(m) {
  return {
    winnerId: m.winnerId ?? null,
    gamesWinner: m.gamesWinner ?? 0,
    gamesLoser: m.gamesLoser ?? 0,
    isDraw: !!m.isDraw,
    isDoubleLoss: !!m.isDoubleLoss,
    isBye: !!m.isBye,
  };
}

function sameOutcome(a, b) {
  if (!a || !b) return false;
  return a.winnerId === b.winnerId && a.gamesWinner === b.gamesWinner && a.gamesLoser === b.gamesLoser
    && !!a.isDraw === !!b.isDraw && !!a.isDoubleLoss === !!b.isDoubleLoss && !!a.isBye === !!b.isBye;
}

function opponentOf(m, playerId) {
  return m.players.find((p) => p.id !== playerId) || null;
}

// Roster entry: { name, id?, discordId? }
function matchRoster(roster, player) {
  for (const entry of roster) {
    if (entry.id && player.id && Number(entry.id) === Number(player.id)) return entry;
    const n = norm(entry.name);
    if (n && (n === norm(player.displayName) || n === norm(player.nickname))) return entry;
  }
  return null;
}

module.exports = {
  norm, legendShort, playerFromRel, playerFromStanding, playerFromRegistration,
  name, fullName, record, interpretMatch, outcomeFor, matchOutcome, sameOutcome, opponentOf, matchRoster,
};
