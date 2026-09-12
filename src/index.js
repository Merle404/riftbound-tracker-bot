'use strict';
require('dotenv').config();
const path = require('path');
const { Bot, GrammyError, HttpError } = require('grammy');
const { Store } = require('./store');
const { Tracker } = require('./tracker');
const { handlers } = require('./commands');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const store = new Store(path.resolve(process.env.DATA_FILE || './data/state.json'));
const bot = new Bot(token);

const dm = async (tgId, html) => {
  await bot.api.sendMessage(tgId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
};

const tracker = new Tracker({
  store,
  intervalMs: Number(process.env.POLL_INTERVAL_SECONDS || 45) * 1000,
  dm,
  send: async (chatKey, watch, html) => {
    const post = () => bot.api.sendMessage(watch.channelId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(watch.threadId ? { message_thread_id: watch.threadId } : {}),
    });
    try {
      await post();
    } catch (err) {
      const newId = err instanceof GrammyError ? err.parameters.migrate_to_chat_id : null;
      if (!newId) throw err;
      migrate(watch.channelId, newId);
      await post();
    }
  },
});

// Group upgraded to a supergroup: carry roster and watches over to the new chat id.
function migrate(oldId, newId) {
  if (store.migrateGuild(oldId, newId)) console.log(`chat ${oldId} migrated to supergroup ${newId}`);
}
bot.on('message:migrate_to_chat_id', (ctx) => migrate(ctx.chat.id, ctx.msg.migrate_to_chat_id));
bot.on('message:migrate_from_chat_id', (ctx) => migrate(ctx.msg.migrate_from_chat_id, ctx.chat.id));

const deps = { store, tracker, dm, log: console };
for (const [cmd, fn] of Object.entries(handlers)) {
  bot.command(cmd, async (ctx) => {
    try {
      await fn(ctx, deps);
    } catch (err) {
      console.error(`/${cmd} failed:`, err);
      await ctx.reply(`⚠️ Something went wrong: ${err.message}`).catch(() => {});
    }
  });
}

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Telegram API error:', e.description);
  else if (e instanceof HttpError) console.error('Could not reach Telegram:', e);
  else console.error('Unhandled error:', e);
});

(async () => {
  await bot.api.setMyCommands([
    { command: 'watch', description: 'Track an event: /watch <url> [backfill]' },
    { command: 'unwatch', description: 'Stop tracking an event' },
    { command: 'watching', description: 'List tracked events' },
    { command: 'team', description: 'Roster: /team add|remove|import|list' },
    { command: 'link', description: 'Get your pairings by DM: /link <roster name>' },
    { command: 'unlink', description: 'Stop DM alerts' },
    { command: 'status', description: 'Round, timer and players left' },
    { command: 'players', description: 'Total / still in / dropped' },
    { command: 'leaderboard', description: 'Roster players in the standings' },
    { command: 'results', description: 'Roster results for a round' },
    { command: 'pairings', description: 'Roster pairings for the current round' },
    { command: 'player', description: 'Match history of one player' },
    { command: 'legends', description: 'Legend breakdown, or /legends <legend> for its players' },
    { command: 'help', description: 'Show all commands' },
  ]);
  tracker.start();
  console.log('Riftbound Tracker Bot started');
  await bot.start({ allowed_updates: ['message', 'channel_post'] });
})();
