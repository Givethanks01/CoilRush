# Coil Rush

A modern arcade snake game with accounts, public leaderboards and live presence. It deploys to Netlify as a static site plus one serverless function, with storage in Netlify Blobs, so there is no external database to set up.

## What's inside

| Area | Features |
|---|---|
| Modes | **Endless** (ranked), **Daily Run** (same seed for everyone, ranked per day), **Levels** (15 hand-built grids that unlock one by one, with 1–3 stars each), **Zen** (edges wrap, no rocks) |
| Gameplay | Smooth movement, combos up to ×8, **Fever** (double points), golden plums, power-ups (Ghost, Slow-mo, Magnet), falling rocks, portals, close-call bonus, a one-beat grace before crashes |
| Progression | Daily missions, XP rank, six unlockable skins, a daily streak, level stars |
| Accounts | **Username + password only**. Progress (rank, missions, skins, level stars, settings) syncs to the account, and guests can play and sign in later without losing progress |
| Public | Leaderboards (Today / All-time / Levels), **live online and playing counts**, a recent-runs feed, global stats (players, runs today), public player profiles, player search, "You're #3!" toasts |
| Controls | Keyboard, swipe, and 3 on-screen schemes (D-pad, Joystick, Turn) chosen in **Options** |
| Audio | Generated sound effects and adaptive background music, with Music and Effects volume sliders in **Options** |

## Deploy to Netlify

The site needs Netlify to **install one npm package and build the function**. The two methods below do that.

> Drag-and-drop on app.netlify.com only uploads static files. It doesn't install packages or build functions, so the game would load but accounts, leaderboards and the online count would be missing.

### Option A: from GitHub (recommended)

1. Unzip, then push the `coil-rush` folder to a new GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub**, and pick the repo.
3. Leave the settings as detected. `netlify.toml` already sets the publish folder (`public`) and the functions folder.
4. Optional but recommended: **Site configuration → Environment variables → Add** `SESSION_SECRET` with a long random string (for example, the output of `openssl rand -hex 32`). If you skip this, the function generates a key once and keeps it in Blobs.
5. Deploy. Every push redeploys.

### Option B: Netlify CLI

```bash
cd coil-rush
npm install
npx netlify-cli login
npx netlify-cli init            # create or link a site
npx netlify-cli deploy --prod   # builds the function and publishes
```

### Run locally

```bash
npm install
npx netlify-cli dev     # http://localhost:8888, with the API and a local Blobs store
```

Opening `public/index.html` directly, or serving `public/` with any static server, also works. The game then runs offline, and progress saves in the browser.

## Coil Rush Plus (optional paywall)

Plus is a **one-time purchase** that unlocks levels 6–15, three exclusive skins (Midnight, Molten, Prism) and a Plus badge on leaderboards and profiles. Levels 1–5, every other mode, missions and rank skins stay free.

**The paywall is off until you add the two Stripe settings below.** Until then the game is fully free and shows no Plus UI.

### Turn it on (about 10 minutes, no code)

1. **Create a Stripe account** at stripe.com and finish account activation, so you can receive payouts.
2. **Create a product:** Product catalog → Add product → name it "Coil Rush Plus", choose a **one-time** price (for example $2.99).
3. **Create a Payment Link** for that product (Payment Links → New):
   - **After payment** → "Don't show confirmation page" → **Redirect customers to your website** → `https://YOUR-SITE.netlify.app/#plus-thanks`
   - Optional: turn on automatic tax (Stripe Tax) if you need to collect sales tax or VAT.
   - Copy the link. It looks like `https://buy.stripe.com/...`.
4. **Add a webhook** (Developers → Webhooks → Add endpoint):
   - Endpoint URL: `https://YOUR-SITE.netlify.app/api/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`
   - Copy the **Signing secret**. It starts with `whsec_`.
5. In **Netlify → Site configuration → Environment variables**, add:
   - `STRIPE_PAYMENT_LINK` = the Payment Link URL
   - `STRIPE_WEBHOOK_SECRET` = the signing secret
   - `PLUS_PRICE` = the price label shown in the game, for example `$2.99` (optional; defaults to $2.99)
6. **Redeploy:** Deploys → Trigger deploy → Deploy site.

**Test first:** use Stripe's **test mode**, which has its own Payment Link and webhook secret. Pay with card `4242 4242 4242 4242`, any future date and any CVC. Confirm the game shows "Welcome to Plus", then switch the two settings to your live-mode values.

### How it works

- The Plus window shows guests a **Create a FREE account** button, with a **Get Plus for $2.99 now →** link at the bottom that goes straight to Stripe.
- Signed-in buyers: Plus is added to their account right away.
- Guests who pay first get a private claim code, kept in their browser. After payment they're asked to create a FREE account (or sign in), and the purchase attaches to that account automatically. One purchase can only ever attach to one account.
- The game sends players to your Payment Link with `client_reference_id=<their account id>`. When Stripe confirms the payment, it calls `/api/stripe-webhook`. The function checks Stripe's signature and marks that account as Plus.
- A refund in Stripe (`charge.refunded`) removes Plus automatically.
- To grant or remove Plus by hand, open Netlify → your site → **Blobs** → store `plus`. Each account id has a record with `"active": true` or `false`.
- **Pro (free Plus) accounts:** `Slimzy169` and `GiveThanks` always have Plus. To give it to more players without touching code, set the environment variable `PRO_USERS` to a comma-separated list of usernames (for example `alice,bob99`) and redeploy.

## Sharing

After every run (except Zen) there's a **Share** button. It draws a **1080×1350 score card image**, a size that suits Instagram, TikTok, X, WhatsApp and Facebook. The card shows the mode, score, stats or stars, the player's snake in their skin, their name, rank and Plus badge, and a "Can you beat me?" link.

- **Share image** (phones): opens the system share sheet with the picture, for Instagram, TikTok, WhatsApp and others
- **Save image** / **Copy image**: for posting from a computer
- One-tap links for **X, WhatsApp, Facebook, Telegram and Reddit**
- **Copy text**: a text version like this:

```
🐍 Coil Rush · Daily Run 2026-11-23
1,240 pts · ×6 combo · 2m 31s
🍓 34  ⭐ 3  🔥 Fever ×1
Beat me: https://your-site.netlify.app/#daily
```

The `#daily` link (or `#levels`) opens the game with that mode selected, so friends can play the same Daily Run straight away.

## Challenges

Players can challenge each other to a race to **500, 1,000, 2,000 or 3,000 points**.

- **Same board:** both players get the same seed, so it's fair.
- **Fastest wins:** the fastest time to reach the target in one run wins. Each player can try as many times as they like; their best time counts.
- **When it ends:** as soon as both players have hit the target, or 24 hours after it was accepted. If only one hit the target, they win. If neither did, the higher score wins. Identical times are a draw.
- **How to start one:**
  - Challenges tab → type a username (or leave it empty) → pick a target → send.
  - **Challenge this player** on anyone's profile (click a name on the leaderboard or in the Live feed).
  - Leave the name empty to get a **challenge link** anyone can accept (`https://your-site/#ch-…`). People without an account are asked to create a FREE one, then go straight into the race.
- **Notifications:** players get pop-ups when they're challenged, when a challenge is accepted and when it's decided. A badge on the tab shows challenges waiting for them.
- **Limits:** results feed the Live feed ("Bob beat Ann to 1,000 in 31.5s") and a **Challenge wins** count on profiles. Each player can have up to 5 open challenges, and unaccepted invites expire after 48 hours.
- **Fair play:** scores and times are checked by the server, so impossible results are rejected.

## Notifications

Players get **push notifications** on their phone or computer, even when the game is closed:

| When | Who gets it | Example |
|---|---|---|
| Someone challenges you | The challenged player | "You've been challenged! ⚔️ Slimzy169 challenged you to hit 1,000 points." |
| Your challenge is accepted | The challenger | "GiveThanks accepted your 1,000 challenge. Game on!" |
| Your opponent sets a new best time | The other player | "Slimzy169 set a time: 31.5s. Can you beat it?" |
| A challenge is decided | Both players | "You won the challenge! 👑" / "Slimzy169 won the challenge" |

Tapping a notification opens the game on the Challenges tab.

- **Turning it on:** a **Never miss a challenge** banner in the Challenges tab, or **Options → Notifications** (which also has **Send a test**).
- **Accounts:** notifications follow the account, not the device. Signing out stops them on that device, and signing in moves them to the new account.
- **iPhone / iPad:** Apple only allows web notifications for sites added to the Home Screen (iOS 16.4 or later). The game detects this and tells players: Share → **Add to Home Screen**, open Coil Rush from there, then turn notifications on. The site ships a web-app manifest and icons for this.
- **Fallbacks:** while the game is open in a background tab, the tab title shows a count, like "(2) Coil Rush", and a notification appears even without push set up.
- **No setup needed:** the notification keys (VAPID) are generated once and stored in Netlify Blobs. To use your own, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and optionally `VAPID_SUBJECT` (a `mailto:` or `https:` contact). Without them, the site's own URL is used as the contact.
- **Devices:** each player can have up to 6 devices. Devices that stop accepting notifications are removed automatically.

## Messages (player chat)

Signed-in players can **message each other directly**.

- **Where:** the chat button in the header (with an unread badge), **Message** on any player profile, Message on challenges, or a username typed into the inbox.
- **Speed:** while a chat is open, new messages appear within about 2.5 seconds. Otherwise the inbox is checked every 20 seconds (once a minute in a background tab).
- **Notifications:** players with notifications on get a push notification for new messages, at most one per conversation every 45 seconds, and none while they're looking at that chat. Tapping it opens the conversation (`#chat-<username>`).
- **In a conversation:** "Seen" receipts, quick replies (GG! 👏, Rematch? ⚔️, Nice run 🔥…), a ⚔️ button to challenge from the chat, and the player's profile one tap away.
- **Safety:**
  - Messages are plain text only (shown as text, never as HTML) and at most 500 characters.
  - Rate limits apply: at least 0.6s between messages, and 20 per minute.
  - **Block** stops all messages both ways; **Report** saves the last messages from that player to the `reports` record in Blobs (store `meta`) and to the function logs (`[report]`).
- **Storage:** one record per pair of players keeps the last 200 messages, plus a small inbox per player. To keep function usage down, all background checks pause or slow down while the game tab is hidden.

**About "real time" on Netlify:** Netlify Functions can't hold connections open, so chat checks for new messages frequently instead. Each check is a function call, so watch your usage in Netlify (Usage & billing) as the player count grows. If chat gets busy, the next step is a realtime service (Ably, Pusher, or Supabase Realtime) for instant delivery.

## Crowns

The **#1 player on each leaderboard** (Today, All-time and Levels) gets a gold crown. It appears:

- on their leaderboard row, with a gold highlight
- next to their name in the Live feed and in Challenges
- on their account button
- on their profile, as "#1 All-time", "#1 Today" or "#1 Levels"
- on their score cards

## Troubleshooting

| What players see | Likely cause | Fix |
|---|---|---|
| "Page not found" on the site | The whole `coil-rush` folder was dragged in, or the Git repo has `coil-rush/` inside it | In Netlify, **Site configuration → Build & deploy → Base directory** = `coil-rush` (if the repo has that folder), or push the *contents* of `coil-rush` to the repo root |
| Game works, but no Sign in button, no Live tab, "leaderboard is offline" | Deployed with drag-and-drop, so the function never got built | Deploy from GitHub or with the CLI (above) |
| Players get signed out at random | An old build created two session keys at once (fixed in v0.3) | Set `SESSION_SECRET`, then redeploy. Everyone signs in once more |
| Scores missing from the leaderboard | An old build lost writes when players finished at the same moment (fixed in v0.3) | Redeploy. Future scores are kept; anyone missing just plays one more run |
| Someone's progress showed up on another account | An old build shared one save slot per device (fixed in v0.3) | Redeploy. Each account now has its own slot |
| Game froze when rocks appeared (older iPhones / Android) | Old browsers lack `roundRect` (fixed in v0.3) | Redeploy |
| Paid, but Plus didn't unlock | The webhook isn't reaching the site, or the secret is wrong | Stripe → Developers → Webhooks → your endpoint shows failed attempts. Check the URL ends in `/api/stripe-webhook` and that `STRIPE_WEBHOOK_SECRET` matches, then click **Resend** on the failed event |
| No Plus button anywhere | Paywall is off | Add both `STRIPE_PAYMENT_LINK` and `STRIPE_WEBHOOK_SECRET`, then redeploy |

**Crash reports:** errors in players' browsers are sent to the function and logged. To see them, open your site in Netlify → **Logs → Functions → api** and look for lines starting `[client error]`. They include the error, where it happened, the game state and the browser.

## How it works

```
coil-rush/
  netlify.toml                 Publish dir, functions dir, security headers
  package.json                 Dependencies: @netlify/blobs, web-push
  netlify/functions/api.mjs    The whole backend, served at /api/*
  public/
    index.html, styles.css
    sw.js            Service worker: shows push notifications, opens the game when one is tapped
    manifest.webmanifest, icons/   Installable web app (needed for iPhone notifications)
    src/
      main.js        App shell: states, game loop, input, HUD, panels, accounts UI
      game.js        Pure simulation (walls, portals, rocks, combos, fever)
      render.js      Canvas renderer
      levels.js      The 15 Levels-mode grids and star thresholds
      progress.js    Profile, XP rank, missions, streak (local first)
      online.js      Backend adapter: claude.ai artifact or Netlify /api, picked automatically
      audio.js       WebAudio sound effects and music sequencer
      config.js, rng.js
```

### API

| Route | Auth | What it does |
|---|---|---|
| `GET /api/health` | – | Lets the client detect the backend |
| `POST /api/register` `{username, password}` | – | Creates an account and returns `{token, user}` |
| `POST /api/login` `{username, password}` | – | Returns `{token, user}` |
| `GET /api/me` | ✓ | Returns the user, saved profile and score record |
| `PUT /api/profile` | ✓ | Saves progress (up to 100 KB) |
| `POST /api/score` | ✓ | `{mode: endless\|daily, score, seconds}` or `{mode: levels, stars, cleared, level, won}`. Updates boards, feed and stats |
| `GET /api/leaderboard?board=endless\|daily\|levels` | – | Top 50 |
| `GET /api/feed` | – | Latest 40 runs plus `{players, runs, runsToday}` |
| `GET /api/player?name=` | – | Public profile |
| `POST /api/presence` `{cid, status}` | – | Heartbeat; returns `{online, playing}` |
| `GET /api/config` | – | Whether Plus is on, plus the payment link and price |
| `GET /api/claim?c=` | – | Whether a guest purchase has been paid |
| `GET /api/chat/inbox` | ✓ | Your conversations and unread counts |
| `GET /api/chat/thread?with=<name>&since=<ms>` | ✓ | Messages (new ones since a time), marks them read, and the other player's "seen" time |
| `POST /api/chat/send` `{to, text}` | ✓ | Sends a message |
| `POST /api/chat/block` `{name, block}` | ✓ | Blocks or unblocks a player |
| `POST /api/chat/report` `{name, reason}` | ✓ | Reports a player |
| `GET /api/push/key` | – | The public key the browser needs to subscribe |
| `POST /api/push/subscribe` `{subscription}` | ✓ | Turns on notifications for this device |
| `POST /api/push/unsubscribe` `{endpoint}` | ✓ | Turns them off for this device |
| `POST /api/push/test` | ✓ | Sends a test notification |
| `GET /api/challenges` | ✓ | Your challenges, with finished ones settled automatically |
| `POST /api/challenges` `{to?, target}` | ✓ | Creates a challenge (to a username, or an open link if `to` is empty) |
| `GET /api/challenge?id=` | – | Public view of one challenge (for invite links) |
| `POST /api/challenge/accept`, `/decline`, `/cancel` `{id}` | ✓ | Responds to a challenge |
| `POST /api/challenge/result` `{id, score, seconds, reach}` | ✓ | Records a run (the time it hit the target, or its best score) |
| `POST /api/claim` `{claim}` | ✓ | Attaches a paid guest purchase to the signed-in account |
| `POST /api/stripe-webhook` | Stripe signature | Grants Plus on a paid checkout and removes it on a refund |
| `POST /api/log` | – | Records crash reports from players' browsers in the function logs |

### Storage (Netlify Blobs stores)

- `users`: `name/<lowercase>` → id, display name, scrypt salt and hash
- `profiles`: `<userId>` → saved progress
- `scores`: `<userId>` → best scores, stars, runs, rank
- `boards`: `endless`, `daily-YYYY-MM-DD`, `levels` → top-50 arrays
- `meta`: `feed`, `stats`, `day-YYYY-MM-DD`, login-failure counters, the generated session key
- `presence`: `<minute>/<clientId>~<status>`. Online means distinct clients seen in the current or previous minute; old minutes are cleaned up automatically

### Security notes

- Passwords are hashed with scrypt and a per-user salt, and are never stored or logged in plain text.
- Sessions are HMAC-signed tokens that expire after 60 days. They are kept in the browser's localStorage.
- Five wrong passwords lock that username for 10 minutes.
- Usernames are limited to `A–Z a–z 0–9 _`, and all names are rendered as text, never as HTML.
- Scores are rate-limited (one every 2.5 s per player) and rejected if the points per second are impossible. This stops casual cheating, but not a determined one, because the game runs in the browser. See next steps.
- There is no password reset, because there is no email by design. A player who forgets their password has to create a new account.

## Tuning knobs

- Speed: `Game.interval()` in `public/src/game.js`. Levels set their own speed in `levels.js`.
- Combo window: `spawnBerry()` (distance + 8 ticks).
- XP curve: `levelInfo()` in `progress.js`. Missions: `POOL` in `progress.js`.
- Score plausibility cap: `submitScore()` in `api.mjs` (80 + 400 points per second).

## Metrics to watch

- D1 and D7 return rate (Daily Run and streaks are the hooks)
- Guest-to-account conversion after the first finished run
- Runs per session, median run length, and mission completion by type
- How far players get in Levels (the drop-off level tells you where it gets too hard)

## Changelog

- **v0.8**: Player-to-player messages (inbox, unread badges, fast refresh while open, push notifications, "Seen", quick replies, block and report, rate limits). Background polling pauses or slows when the tab is hidden.
- **v0.7**: Push notifications for challenges (challenged, accepted, new best time, result), a service worker, an installable web app (manifest + icons), an iPhone Home Screen guide, tab-title counts and a background-tab fallback.
- **v0.6**: Challenges (500/1,000/2,000/3,000 races on a shared seed, by username or link, notifications, results in the feed, challenge wins on profiles) and crowns for every #1.
- **v0.5**:
  - Score card image sharing
  - Guest checkout with automatic claim on sign-up, and a "Create a FREE account" first step in the Plus window
  - Pro accounts (Slimzy169, GiveThanks, plus `PRO_USERS`)
  - Version label in Options
- **v0.4**: Coil Rush Plus (Stripe Payment Links + verified webhook, refunds handled, Plus badge, 3 exclusive skins, levels 6–15), Share button with `#daily` and `#levels` deep links.
- **v0.3** (reliability):
  - Atomic, retried writes for leaderboards, feed, stats and score records, so nothing is lost when players finish at the same time
  - Username sign-ups are claimed atomically
  - One shared session key
  - A separate saved-progress slot per account on each device
  - `roundRect` fallback for older phones
  - The game loop recovers from errors instead of freezing
  - Player-side crash reports go to the function logs (`POST /api/log`)
- **v0.2**: Netlify backend, accounts, public leaderboards, live presence, feed, player profiles.

## Next steps

1. Server-verified runs: record inputs plus the seed, then replay them in the function before accepting a score.
2. Weekly leaderboard and friends-only boards.
3. Optional recovery code at sign-up, as a password reset without email.
4. Ghost replay of your best Daily Run.
