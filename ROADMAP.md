# Roadmap

Ideas for the next sessions, roughly in order of value. Each item lists what the API already offers and
where in the code it would land.

## 1. Ping players by DM when their pairing is up — done (2026-09-12)
- `/start` in a DM records the user in `store.users`, `/link <name>` (or a matching `@handle` on the
  roster entry) sets `tgId`, and `src/tracker.js` DMs the pairing/result, once per user per match.
- Possible follow-ups: a deep link (`t.me/<bot>?start=link_<name>`) that links in one tap; an opt-out
  per alert type; stop DMing after Telegram reports the user blocked the bot.

## 2. Re-post corrected results — done (2026-09-12)
- `watch.reportedMatches[m.id]` now holds the outcome (`model.matchOutcome`); `src/tracker.js` compares it
  on every poll until the round is finalized and posts "✏️ Result corrected · was: ..." when it differs.
- Entries written by the old version (`true`) are upgraded to the current outcome silently on first sight.
- Possible follow-up: also notice a match that goes back to in-progress (status leaves `COMPLETE`).

## 2b. Betting on match results — done (2026-09-15)
- `src/betting.js`: per-chat wallets (`guild.wallets`, 100 coins + 10 a day, credited lazily), bet
  entries per match (`watch.bets`), betting boards with inline buttons (`watch.betMsgs`), 1:1 payout,
  refunds for draws / no result / unwatch / event end. Tracker posts the board when a round pairs and
  settles as results come in; `bot.on('callback_query:data')` in `src/index.js` handles the taps.
- Event winner pool (`watch.champ`): `/winner <amount> <name>`, closes at the first real result,
  parimutuel split (min 1:1) on `EVENT_FINISHED` using rank 1 of the latest standings.
- Possible follow-ups: parimutuel odds (pool split by side) or odds from standings; a per-chat
  season leaderboard with a reset command; re-settle when a judge corrects an already settled
  result (today the first seen result is final); a "close bets N minutes into the round" option.

## 2c. Free-slot alerts for full events — done (2026-09-21)
- `src/slots.js`: `SlotWatcher` polls `GET /events/{id}/` (`avoid_cache=true`) every
  `SLOT_POLL_INTERVAL_SECONDS` for every `guild.slotWatches` entry and posts when
  `registered_user_count < capacity`, reminders every `SLOT_REMIND_MINUTES`, "full again", status
  changes, and marks the watch finished once the event is in progress. `/slots` in `src/commands.js`.
- Possible follow-ups: DM the person who added the watch as well as the chat; auto-register.

## 3. Cross-tournament stats for the roster
- Persist every reported match (event id, round, player id, opponent id, legends, outcome, score) to
  `data/history.json` from `src/tracker.js`.
- Commands: `/stats <name>` (overall record, win rate by own legend, win rate vs each opposing legend),
  `/h2h <name> <name>`, `/team stats` (best legends for the team).

## 4. End-of-event meta report
- Standings already carry every player's legend; `is_feature_match` and the Top8 phase come from the
  event object.
- When `event_lifecycle_status` becomes `EVENT_FINISHED`, post: legend share of the field, share of
  Top 8 / Top 32 / Day 2, conversion rate per legend (Top 32 share ÷ field share).
- Also makes a good on-demand `/meta [event]` command using the latest standings.

## 5. Auto-discover events
- The site exposes `GET /events/` with filters (see `quick-filters` and the locator's list page);
  inspect the query params the frontend sends to filter by game, date and country.
- Command `/upcoming [country]` listing Showdown events, and `/autowatch` to watch any event where a
  roster player is registered (poll registrations of upcoming events once a day).

## 6. Feature match and Top 8 alerts
- `is_feature_match` is on every match object; post a special message when a roster player is on
  the feature table.
- Post a short "X made Top 8 / Day 2" message when a new phase's first round pairs and a roster
  player is in it (phases have `rank_required_to_enter_phase`).

## 7. Round timer reminders
- `timer_end_datetime` / `timer_is_running` are on the event object; post "5 minutes left in Round N"
  once per round, optional per chat.

## 8. Quality of life
- `/settings` per chat: toggle pairings posts, standings summaries, mentions, poll interval.
- Track several chats for the same event with different rosters (already supported by chat-keyed
  state) and a `/team copy <other chat>` helper.
- Photo of the legend card in result posts (`deck_defining_card.image_url`, signed URL valid ~24h).
- Docker file + systemd unit for running on a small VPS.
- Tests: fixture JSON from a finished event, unit tests for `model.js` outcomes and BEST OF logic.

## Known gaps to keep in mind
- Decklists need a logged-in session (`deck-submissions` and `recap` endpoints return 401); only the
  legend is public.
- Day 2 and Top 8 phases have not been observed live yet; labels come from `phase_name`.
- Registrations endpoint caps at 250 per page and ignores `search=`; standings (1000 per page) is the
  better source once round 1 standings exist.
