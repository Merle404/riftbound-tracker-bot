# Riftbound Tracker Bot

Telegram bot that follows your team's players in Riftbound tournaments hosted on
[locator.riftbound.uvsgames.com](https://locator.riftbound.uvsgames.com) and posts their results
to a chat as they come in.

For every roster player it reports, per round:

- win / loss / draw / bye and the game score (e.g. `2-1`)
- who they played and which legend both of them use
- current record, match points and rank in the standings
- `⭐` when the player is the best-placed player on that legend in the whole event

It also posts the roster's pairings when a new round is paired, followed by the roster leaderboard (the same
message as `/leaderboard`: every roster player with rank, record, points, legend and ⭐) once per round,
and the final standings when the event finishes.

## Setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
   Optionally `/setprivacy` → Disable is **not** required: commands always reach the bot.
2. Install and configure:

   ```sh
   npm install
   cp .env.example .env      # paste TELEGRAM_BOT_TOKEN
   npm start
   ```

3. Add the bot to your team's group (or DM it), then:

   ```
   /team import astar, GoldGalio, KAI GVBZ
   /watch https://locator.riftbound.uvsgames.com/events/926094
   ```

Names are matched case-insensitively against a player's Spicerack display name ("Mathieu B") **or** their
event nickname ("astar"). `/watch` tells you which roster names were found in the event.

State (roster + watched events) lives in `data/state.json`, so restarts do not repost anything.

### DM alerts for players

Besides the group post, every roster player can get their own pairing and result as a private message:

1. The player opens a private chat with the bot and sends `/start` (Telegram only lets bots message
   people who did this).
2. If an admin added them with their handle (`/team add astar @alice`), they are linked right away.
   Otherwise they send `/link astar` to the bot, in the DM or in the group.

`/team list` shows `🔗 DM` next to linked players. `/unlink` stops the alerts; in a group an admin can
`/unlink <name>` for anyone. A name whose roster entry carries an `@handle` can only be linked by that
handle. Two chats tracking the same event with the same player only produce one DM.

## Commands

| Command | What it does |
| --- | --- |
| `/watch <url or id> [backfill]` | Track an event in this chat. `backfill` also posts every result so far. |
| `/unwatch [id]` | Stop tracking. |
| `/watching` | List tracked events and their poll state. |
| `/team add <name> [@handle] [id:123]` | Add a roster player. The @handle is pinged in their reports. `id:` pins a Spicerack user id if two players share a name. |
| `/team remove <name>` · `/team import a, b, c` · `/team list` · `/team clear` | Roster management. |
| `/link <roster name>` | Link your Telegram account to a roster player to get pairings and results by DM (send the bot `/start` in private first). |
| `/unlink [name]` | Stop DM alerts. Admins can unlink anyone in their group. |
| `/status [event]` | Lifecycle, current round and progress, round timer, players left. |
| `/players [event]` | Total players, still playing, dropped. |
| `/leaderboard [event]` | Roster players sorted by rank with record, points, legend and ⭐ for the best-placed player on a legend. |
| `/results [event] [round]` | Roster results for a round (default: latest paired round). |
| `/pairings [event]` | Roster pairings for the current round, with table numbers and opponent's legend/record/rank. |
| `/player <name> [event]` | Full match history and tiebreakers for any player in the event (not only roster). |
| `/legends [event]` | Legend breakdown of the whole field, best-ranked pilot per legend, how many of ours play it. |
| `/legends <legend> [event]` | Every player on that legend (e.g. `/legends kennen`), best-placed first, with record, points, `⭐` for the best-placed player and `❤️` on roster players. |
| `/bets [event]` | Betting board for the current round (all matches with a button per player) and your open bets. |
| `/bet <amount> <player>` | Stake any amount (or `all`) on a player in the current round. |
| `/winner <amount> <player>` · `/winner` | Pick the event winner (open until the first result); alone, shows the pool and everyone's picks. |
| `/coins` | Your balance, record and the chat's richest bettors. |
| `/betting on\|off` | Admins: turn the betting boards off or on for this chat. |

The `[event]` argument is optional when the chat watches one event. It accepts the event URL or id.

In groups, `/watch`, `/unwatch` and roster changes are admin-only. Set `ADMIN_ONLY=false` in `.env` to let
anyone use them.

### Betting

When a round is paired the bot posts a **betting board** for the round: every match (at events with
more than `BET_MAX_MATCHES` matches only the ones with roster players), with two buttons per match.
Tapping a player's name stakes `BET_STAKE` coins (default 10) on them; tap again to add more, or use
`/bet 25 astar` for any amount. You can only back one side of a match, and the buttons show how much
is riding on each player.

Every Telegram user has a wallet per chat: `BET_START_COINS` (default 100) to begin with, plus
`BET_DAILY_COINS` (default 10) for every calendar day since. A won bet pays 1:1, so 10 coins on the
winner come back as 20. Draws, double losses and matches that end without a result are refunded. Bets
close as soon as the bot sees the match completed (within one poll interval), and the bot posts a
"Bets settled" summary with everyone's gains, losses and new balances. `/coins` shows balances and the
richest bettors; `/bets` reposts the board or lists your open bets; admins can `/betting off`.

**Event winner.** `/winner 20 astar` picks who takes the whole event, one pick per person (more coins
can be added to the same pick). Picks are open from `/watch` until the bot sees the first real result of
the event. All stakes form a pool; when the event finishes, the pool is split among those who picked
the champion in proportion to their stakes, and never less than 1:1. If nobody picked the champion,
or the event ends without standings, everyone is refunded. `/winner` alone shows the pool.

### Dry run without Telegram

```sh
node src/cli.js https://locator.riftbound.uvsgames.com/events/926094 "astar" "GoldGalio"
```

Prints exactly what the bot would post (state kept in `data/dry-run.json`).

## How it works

The site is a Next.js frontend over the public Spicerack "hydraproxy" API. Everything the bot needs is
readable without authentication:

| Endpoint | Used for |
| --- | --- |
| `GET /events/{id}/` | Name, lifecycle status, phases and rounds (ids + pairing/standings status), player counts, round timer. |
| `GET /tournament-rounds/{round_id}/matches/paginated/?page_size=500` | All matches of a round: both players, their legend (`deck_defining_card`), status, winner, game score, bye/draw flags, table. |
| `GET /tournament-rounds/{round_id}/standings/paginated/?page_size=1000` | Rank, record, points, tiebreakers, legend and dropped status for every player. |
| `GET /events/{id}/registrations/?page_size=250` | Fallback player list before round 1 standings exist. |

Base URL: `https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2`. Add `avoid_cache=true` to bypass
the CDN cache (the bot does this for the live round).

Every `POLL_INTERVAL_SECONDS` (default 45) the bot, per watched event, fetches the event, the latest standings
(cached 2 min) and the matches of every round that is not yet finalized, then posts anything it has not
posted before (tracked per match id / round id). For every reported match the bot stores the outcome (winner,
game score, draw / double loss / bye) and compares it on each poll while the round is still open; when a judge
edits the result, it posts a "Result corrected" message (and DMs linked players again). Once the round is
finalized the match is no longer checked.

The ⭐ mark (best of legend) is computed from the most recent generated standings: a player gets it when no other player on
the same legend has a better rank. A result posted mid-round uses the standings of the previous round; the
roster leaderboard posted after the round refreshes it.
