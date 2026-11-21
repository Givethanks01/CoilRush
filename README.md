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

## Troubleshooting

| What players see | Likely cause | Fix |
|---|---|---|
| "Page not found" on the site | The whole `coil-rush` folder was dragged in, or the Git repo has `coil-rush/` inside it | In Netlify, **Site configuration → Build & deploy → Base directory** = `coil-rush` (if the repo has that folder), or push the *contents* of `coil-rush` to the repo root |
| Game works, but no Sign in button, no Live tab, "leaderboard is offline" | Deployed with drag-and-drop, so the function never got built | Deploy from GitHub or with the CLI (above) |
| Players get signed out at random | An old build created two session keys at once (fixed in v0.3) | Set `SESSION_SECRET`, then redeploy. Everyone signs in once more |
| Scores missing from the leaderboard | An old build lost writes when players finished at the same moment (fixed in v0.3) | Redeploy. Future scores are kept; anyone missing just plays one more run |
| Someone's progress showed up on another account | An old build shared one save slot per device (fixed in v0.3) | Redeploy. Each account now has its own slot |
| Game froze when rocks appeared (older iPhones / Android) | Old browsers lack `roundRect` (fixed in v0.3) | Redeploy |

**Crash reports:** errors in players' browsers are sent to the function and logged. To see them, open your site in Netlify → **Logs → Functions → api** and look for lines starting `[client error]`. They include the error, where it happened, the game state and the browser.

## How it works

```
coil-rush/
  netlify.toml                 Publish dir, functions dir, security headers
  package.json                 One dependency: @netlify/blobs
  netlify/functions/api.mjs    The whole backend, served at /api/*
  public/
    index.html, styles.css
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
