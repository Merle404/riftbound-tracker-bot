'use strict';
// Dry run without Telegram: prints what the bot would post for an event and a list of names.
//   node src/cli.js <event url|id> "Name One" "Name Two" ...
require('dotenv').config();
const path = require('path');
const { Store } = require('./store');
const { Tracker } = require('./tracker');
const api = require('./api');

function html2text(s) {
  return s.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 <$1>').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

(async () => {
  const [target, ...names] = process.argv.slice(2);
  const eventId = api.parseEventId(target);
  if (!eventId || !names.length) {
    console.error('usage: node src/cli.js <event url|id> "Player name" ...');
    process.exit(1);
  }
  const store = new Store(path.resolve(process.env.DRY_DATA_FILE || './data/dry-run.json'));
  const key = 'cli';
  const roster = store.roster(key);
  for (const n of names) if (!roster.some((e) => e.name === n)) roster.push({ name: n });
  const watches = store.watches(key);
  if (!watches[eventId]) watches[eventId] = store.newWatch({ eventId, channelId: 0, backfill: true });
  const tracker = new Tracker({ store, send: async (_k, _w, html) => console.log(html2text(html) + '\n---') });
  const res = await tracker.pollWatch(key, watches[eventId]);
  store.save();
  console.log(`event: ${res.ev.name}\nposted: ${JSON.stringify(res.summary)} counts: ${JSON.stringify(res.counts)}`);
})().catch((err) => { console.error(err); process.exit(1); });
