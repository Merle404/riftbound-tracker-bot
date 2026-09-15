'use strict';
require('dotenv').config();
const path = require('path');
const { Bot, GrammyError, HttpError } = require('grammy');
const { Store } = require('./store');
const { Tracker } = require('./tracker');
const { handlers } = require('./commands');
const betting = require('./betting');

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
  editMarkup: (chatId, msgId, keyboard) => bot.api.editMessageReplyMarkup(chatId, msgId, { reply_markup: keyboard }),
  send: async (chatKey, watch, html, { replyMarkup = null } = {}) => {
    const post = () => bot.api.sendMessage(watch.channelId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(watch.threadId ? { message_thread_id: watch.threadId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    try {
      return await post();
    } catch (err) {
      const newId = err instanceof GrammyError ? err.parameters.migrate_to_chat_id : null;
      if (!newId) throw err;
      migrate(watch.channelId, newId);
      return post();
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

// Betting board buttons: "b:<eventId>:<matchId>:<side>".
bot.on('callback_query:data', async (ctx) => {
  const m = /^b:(\d+):(\d+):([01])$/.exec(ctx.callbackQuery.data);
  if (!m) return ctx.answerCallbackQuery().catch(() => {});
  const chat = ctx.callbackQuery.message?.chat;
  if (!chat) return ctx.answerCallbackQuery({ text: 'This board is too old to bet on.' }).catch(() => {});
  const key = String(chat.id);
  const guild = store.guild(key);
  const watch = store.watches(key)[m[1]];
  if (!watch) return ctx.answerCallbackQuery({ text: 'This event is no longer tracked here.', show_alert: true }).catch(() => {});
  if (!betting.enabled(guild)) return ctx.answerCallbackQuery({ text: 'Betting is turned off in this chat.', show_alert: true }).catch(() => {});
  const side = Number(m[3]);
  const res = betting.placeBet({ guild, watch, matchId: Number(m[2]), side, from: ctx.from });
  store.save();
  await ctx.answerCallbackQuery({ text: res.text, show_alert: !res.ok }).catch(() => {});
  if (!res.ok) return;
  // Tell the chat who bet on whom (the popup above is only seen by the tapper). Repeated taps on the
  // same player update the announcement in place, so a 100🪙 bet is one message, not ten.
  const html = betting.betAnnouncement({ guild, entry: res.entry, side, from: ctx.from });
  const wager = res.entry.wagers[String(ctx.from.id)];
  let edited = false;
  if (wager.msgId) {
    edited = await bot.api.editMessageText(watch.channelId, wager.msgId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      .then(() => true, (err) => { console.error('bet announcement edit failed:', err.description || err.message); return false; });
  }
  if (!edited) { // first bet on this match, or the old announcement is gone: post a fresh one
    const sent = await tracker.send(key, watch, html)
      .catch((err) => console.error('bet announcement failed:', err.description || err.message));
    if (sent?.message_id) { wager.msgId = sent.message_id; store.save(); }
  }
  await tracker.refreshBoards(watch, [Number(m[2])]);
});

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
    { command: 'bets', description: 'Betting board for the current round and your open bets' },
    { command: 'bet', description: 'Stake coins on a player: /bet <amount> <name>' },
    { command: 'winner', description: 'Pick the event winner: /winner <amount> <name>' },
    { command: 'wagers', description: 'Every open bet in the chat and who backs whom' },
    { command: 'coins', description: 'Your coins and the richest bettors' },
    { command: 'donate', description: 'Give coins to someone: /donate <@handle or name> <amount>' },
    { command: 'help', description: 'Show all commands' },
  ]);
  tracker.start();
  console.log('Riftbound Tracker Bot started');
  await bot.start({ allowed_updates: ['message', 'channel_post', 'callback_query'] });
})();
