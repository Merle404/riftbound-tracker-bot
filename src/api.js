'use strict';
// Thin client for the Spicerack "hydraproxy" API that powers locator.riftbound.uvsgames.com.
// All endpoints used here are public (no auth) and are the same ones the web page calls.

const BASE = process.env.RIFTBOUND_API_BASE
  || 'https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2';

function parseEventId(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/\/events\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function eventUrl(eventId) {
  return `https://locator.riftbound.uvsgames.com/events/${eventId}`;
}

async function getJson(path, { avoidCache = false, retries = 2 } = {}) {
  const url = new URL(BASE + path);
  if (avoidCache) url.searchParams.set('avoid_cache', 'true');
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'riftbound-tracker-bot/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url.pathname}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      const retryable = !err.status || err.status >= 500 || err.status === 429;
      if (attempt >= retries || !retryable) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function getAllPages(path, pageSize, opts) {
  const results = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await getJson(`${path}${sep}page=${page}&page_size=${pageSize}`, opts);
    const rows = data.results || [];
    results.push(...rows);
    if (!data.next_page_number || rows.length === 0) break;
    page = data.next_page_number;
  }
  return results;
}

const api = {
  parseEventId,
  eventUrl,
  event: (eventId, opts) => getJson(`/events/${eventId}/`, opts),
  roundMatches: (roundId, opts) =>
    getAllPages(`/tournament-rounds/${roundId}/matches/paginated/`, 500, opts),
  roundStandings: (roundId, opts) =>
    getAllPages(`/tournament-rounds/${roundId}/standings/paginated/`, 1000, opts),
  registrations: (eventId, opts) =>
    getAllPages(`/events/${eventId}/registrations/`, 250, opts),
};

module.exports = api;
