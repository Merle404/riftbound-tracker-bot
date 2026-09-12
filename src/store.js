'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON-file persistence. Shape:
// {
//   guilds: { [chatId]: { roster: [{ name, tg?, id?, tgId? }], watches: { [eventId]: {...} } } },
//   users:  { [tgId]: { username, firstName, startedAt, dmSent: { [key]: true } } }  // people who DM'd /start
// }
class Store {
  constructor(file) {
    this.file = file;
    this.data = { guilds: {}, users: {} };
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!this.data.guilds) this.data.guilds = {};
    if (!this.data.users) this.data.users = {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  guild(guildId) {
    if (!this.data.guilds[guildId]) this.data.guilds[guildId] = { roster: [], watches: {} };
    const g = this.data.guilds[guildId];
    if (!g.roster) g.roster = [];
    if (!g.watches) g.watches = {};
    return g;
  }

  roster(guildId) { return this.guild(guildId).roster; }
  watches(guildId) { return this.guild(guildId).watches; }

  // A Telegram user who has opened a DM with the bot (only they can receive DMs).
  user(tgId) {
    const key = String(tgId);
    if (!this.data.users[key]) this.data.users[key] = { username: null, firstName: null, startedAt: null, dmSent: {} };
    const u = this.data.users[key];
    if (!u.dmSent) u.dmSent = {};
    return u;
  }

  knownUser(tgId) { return this.data.users[String(tgId)] || null; }

  userByUsername(username) {
    const want = String(username || '').replace(/^@/, '').toLowerCase();
    if (!want) return null;
    for (const [id, u] of Object.entries(this.data.users)) {
      if ((u.username || '').toLowerCase() === want) return { tgId: Number(id), ...u };
    }
    return null;
  }

  // Every roster entry across all chats, with its chat key.
  allRosterEntries() {
    const out = [];
    for (const [chatKey, g] of Object.entries(this.data.guilds)) {
      for (const entry of g.roster || []) out.push({ chatKey, entry });
    }
    return out;
  }

  // Telegram gives a group a new id when it is upgraded to a supergroup. Move everything stored
  // under the old chat id to the new one; anything already stored under the new id is merged in.
  // Forum topic ids do not survive the upgrade, so watches fall back to posting in the main chat.
  migrateGuild(oldId, newId) {
    const from = String(oldId);
    const to = String(newId);
    if (from === to || !this.data.guilds[from]) return false;
    const old = this.data.guilds[from];
    delete this.data.guilds[from];
    const target = this.data.guilds[to];
    if (target) {
      const names = new Set((old.roster || []).map((e) => e.name.toLowerCase()));
      for (const e of target.roster || []) if (!names.has(e.name.toLowerCase())) old.roster.push(e);
      old.watches = { ...(target.watches || {}), ...(old.watches || {}) };
    }
    this.data.guilds[to] = old;
    for (const w of Object.values(old.watches || {})) {
      if (String(w.channelId) === from) {
        w.channelId = Number(to);
        w.threadId = null;
      }
    }
    this.save();
    return true;
  }

  newWatch({ eventId, channelId, addedBy, backfill }) {
    return {
      eventId,
      channelId,
      name: null,
      addedBy,
      addedAt: new Date().toISOString(),
      backfill: !!backfill,
      initialized: false,
      finished: false,
      reportedMatches: {},
      postedPairings: {},
      postedStandings: {},
      finalizedRounds: {},
      lastError: null,
    };
  }
}

module.exports = { Store };
