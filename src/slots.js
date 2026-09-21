'use strict';
// Watches events whose registration is full and posts to the chat when a slot frees up.
// Independent of the result tracker: it only needs GET /events/{id}/ (capacity + registered count).
const api = require('./api');
const fmt = require('./format');

const POLL_MS = Number(process.env.SLOT_POLL_INTERVAL_SECONDS || 60) * 1000;
const REMIND_MS = Number(process.env.SLOT_REMIND_MINUTES ?? 15) * 60 * 1000;

function summarize(event) {
  const s = event.settings || {};
  const capacity = Number(event.capacity) || 0;
  const registered = Number(event.registered_user_count) || 0;
  return {
    id: event.id,
    name: event.name || String(event.id),
    url: api.eventUrl(event.id),
    capacity,
    registered,
    free: capacity ? Math.max(capacity - registered, 0) : null,
    lifecycle: s.event_lifecycle_status || null,
    queue: event.queue_status || null,
    waitlist: !!s.enable_waitlist,
    start: event.start_datetime || null,
    timezone: event.timezone || null,
  };
}

const isOpen = (s) => s.capacity > 0 && s.registered < s.capacity;
// Registration can no longer matter: the event started, ended or was cancelled.
const isOver = (s) => /IN_PROGRESS|FINISHED|CANCEL/.test(s.lifecycle || '');

function startText(s) {
  if (!s.start) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: s.timezone || 'UTC' })
      .format(new Date(s.start));
  } catch {
    return s.start;
  }
}

function statusBlock(s) {
  return fmt.quote([
    `Registered · ${fmt.b(`${s.registered}/${s.capacity}`)}`,
    s.free != null ? `Free · ${fmt.b(String(s.free))}` : null,
    `Registration · ${fmt.b(fmt.prettyLifecycle(s.lifecycle))}${s.waitlist ? ' · waitlist on' : ''}`,
    s.start ? `Starts · ${fmt.esc(startText(s))}` : null,
  ]);
}

const title = (s) => fmt.link(s.name, s.url);

const messages = {
  open: (s) => [
    `🎉 ${fmt.b(`${s.free} slot${s.free === 1 ? '' : 's'} open!`)} ${title(s)}`,
    statusBlock(s),
    `👉 ${fmt.link('Register now', s.url)}`,
  ].join('\n'),
  reminder: (s) => `⏰ ${fmt.b(`Still ${s.free} free`)} at ${title(s)} · ${fmt.link('register', s.url)}`,
  full: (s) => `😕 ${fmt.b('Full again')} · ${title(s)} · ${s.registered}/${s.capacity}`,
  changed: (s) => [`ℹ️ ${fmt.b('Registration status changed')} · ${title(s)}`, statusBlock(s)].join('\n'),
  over: (s) => `🏁 ${title(s)} is ${fmt.prettyLifecycle(s.lifecycle)} · no longer watching for slots`,
  added: (s) => [`👀 ${fmt.b('Watching for free slots')} at ${title(s)}`, statusBlock(s)].join('\n'),
};

// Compares the fresh summary with what the watch saw last time and returns the posts that are due.
// Pure: the caller sends them. `now` is a timestamp in ms.
function decide(watch, s, now = Date.now()) {
  const open = isOpen(s);
  const state = [s.lifecycle, s.queue, s.waitlist, s.capacity].join('|');
  const posts = [];
  if (watch.wasOpen != null) {
    if (open && !watch.wasOpen) {
      posts.push(messages.open(s));
      watch.lastAlertAt = now;
    } else if (open && REMIND_MS > 0 && now - (watch.lastAlertAt || 0) >= REMIND_MS) {
      posts.push(messages.reminder(s));
      watch.lastAlertAt = now;
    } else if (!open && watch.wasOpen) {
      posts.push(messages.full(s));
    }
    if (watch.state && state !== watch.state && !isOver(s)) posts.push(messages.changed(s));
  }
  if (isOver(s)) {
    posts.push(messages.over(s));
    watch.finished = true;
  }
  watch.name = s.name;
  watch.capacity = s.capacity;
  watch.registered = s.registered;
  watch.wasOpen = open;
  watch.state = state;
  watch.checkedAt = new Date(now).toISOString();
  return { s, open, posts };
}

class SlotWatcher {
  constructor({ store, send, log = console, intervalMs = POLL_MS }) {
    this.store = store;
    this.send = send; // async (chatKey, watch, html) => sent message
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    const loop = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.tick(); } catch (err) { this.log.error('slot tick failed', err); }
      this.running = false;
    };
    loop();
    this.timer = setInterval(loop, this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    for (const [chatKey, g] of Object.entries(this.store.data.guilds)) {
      for (const watch of Object.values(g.slotWatches || {})) {
        if (watch.finished) continue;
        try {
          await this.check(chatKey, watch);
          watch.lastError = null;
        } catch (err) {
          watch.lastError = `${new Date().toISOString()} ${err.message}`;
          this.log.error(`slots ${watch.eventId} for ${chatKey}:`, err.message);
        }
        this.store.save();
      }
    }
  }

  // Fetch the event, post whatever changed, return the fresh summary.
  async check(chatKey, watch) {
    const s = summarize(await api.event(watch.eventId, { avoidCache: true }));
    const res = decide(watch, s);
    for (const html of res.posts) await this.send(chatKey, watch, html);
    return res;
  }
}

module.exports = {
  SlotWatcher, summarize, decide, messages, isOpen, isOver, statusBlock,
  POLL_SECONDS: POLL_MS / 1000, REMIND_MINUTES: REMIND_MS / 60000,
};
