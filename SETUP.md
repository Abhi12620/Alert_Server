# 24/7 Delta Spread Alert Server — Setup Guide

This runs your Telegram spread alerts in the background, all day, even with
every browser and phone closed. Total cost: **₹0/month**.

It has 3 free pieces working together:
1. **Render** (free web service) — runs this code, checks prices every few
   seconds, sends Telegram alerts, and serves a small dashboard page.
2. **Supabase** (free Postgres) — stores your alerts permanently, so they
   survive server restarts (Render's free tier has no persistent disk).
3. **UptimeRobot** (free monitor) — pings the server every 5 minutes so it
   never goes to sleep (Render's free tier sleeps after 15 min idle).

---

## Step 1 — Push this folder to GitHub

1. Create a new **private** GitHub repo (private is fine and recommended —
   nothing here needs to be public).
2. Push this whole `alert-server` folder to it:
   ```bash
   cd alert-server
   git init
   git add .
   git commit -m "Delta spread alert server"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
   `.gitignore` already excludes `node_modules` and `.env` — never commit
   real secrets.

---

## Step 2 — Create the Supabase database

1. Go to [supabase.com](https://supabase.com) → sign up (free, no card) →
   **New Project**.
2. Pick any name/region, set a database password (save it somewhere safe).
3. Wait ~2 minutes for the project to provision.
4. Go to **Project Settings → Database → Connection string** → select the
   **Connection pooling** tab → copy the **URI** (starts with
   `postgresql://postgres.xxxxx:...@...pooler.supabase.com:6543/postgres`).
5. Replace `[YOUR-PASSWORD]` in that string with the password from step 2.
   Keep this string — you'll paste it into Render as `DATABASE_URL`.

---

## Step 3 — Create your Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts →
   copy the **bot token** it gives you (looks like `123456:ABC-...`).
2. Send your new bot any message (e.g. "hi") so it can see your chat.
3. In a browser, open:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   (replace `<YOUR_TOKEN>`). Find `"chat":{"id":987654321,...}` in the
   response — that number is your **chat ID**.

---

## Step 4 — Deploy to Render

1. Go to [render.com](https://render.com) → sign up (free, no card) →
   **New +** → **Web Service**.
2. Connect your GitHub account, pick the repo you pushed in Step 1.
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Before deploying, scroll to **Environment Variables** and add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase pooler URI from Step 2 |
   | `TG_BOT_TOKEN` | your bot token from Step 3 |
   | `TG_CHAT_ID` | your chat id from Step 3 |
   | `POLL_MS` | `2000` (optional — this is the default) |
   | `DASH_USER` | pick any username, e.g. `abhi` |
   | `DASH_PASS` | pick a strong password |
5. Click **Create Web Service**. First deploy takes 2-5 minutes.
6. Once live, Render gives you a URL like
   `https://your-app-name.onrender.com` — open it, you should see the
   dashboard.
7. Check the **Logs** tab — you should see:
   ```
   [db] Schema ready (alerts table present).
   [server] Listening on :10000
   [server] Polling every 2000ms
   ```

---

## Step 5 — Keep it awake with UptimeRobot

Render's free tier sleeps after 15 minutes with no incoming requests. This
step stops that from ever happening.

1. Go to [uptimerobot.com](https://uptimerobot.com) → free sign up.
2. **Add New Monitor**:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: anything, e.g. "Delta Alert Server"
   - **URL**: `https://your-app-name.onrender.com/ping`
   - **Monitoring Interval**: 5 minutes
3. Save. Done — UptimeRobot will now ping `/ping` every 5 minutes forever,
   which resets Render's 15-minute sleep timer before it can trigger.

---

## Step 6 — Set your alerts

1. Open your Render URL in a browser.
2. Pick BTC or ETH, pick an expiry, adjust Gap/Ratio same as before.
3. Click the 🔔 bell on any row → set your condition (LTP/BID/ASK,
   ≥/≤, value) → Save.
4. That's it — the alert is now saved to Supabase and the server checks it
   every `POLL_MS` (default 2s) in the background. **You can close this
   tab, close your laptop, lock your phone — the alert still fires.**
5. Use **⚙ Telegram & Active Alerts** → "Send test message" once to
   confirm delivery works end to end.

---

## Sanity checklist if something doesn't fire

- Render **Logs** tab: look for `[alertEngine] Fired + sent: ...` lines
  when a condition should have crossed.
- If you see `[alertEngine] Telegram send failed`, double check
  `TG_BOT_TOKEN` / `TG_CHAT_ID` in Render's Environment tab (a typo here
  is the most common issue).
- If you see `[alertEngine] chain fetch failed`, Delta's API may be
  briefly down — the next cycle (in `POLL_MS`) will retry automatically.
- Visit `https://your-app-name.onrender.com/healthz` — should return
  `{"ok":true}`. If it errors, `DATABASE_URL` is likely wrong.

## About this dashboard (ODD_V5 trading desk)

`public/dashboard.html` is the full Options Desk dashboard — live option
chain, 3 independent Ratio/Calendar spread builders with Buy/Sell, a
payoff/portfolio tracker, and analytics — with its alert bell wired to
this server instead of localStorage. What changed vs. running it as a
standalone file:

- **Alerts are saved to Supabase**, not your browser. `GET/POST/DELETE
  /api/alerts` handle this. Close the tab, lock your phone — alerts you've
  set keep getting checked every `POLL_MS` in the background.
- **Telegram sending moved server-side.** The dashboard no longer asks for
  a bot token/chat ID — those live in Render's `TG_BOT_TOKEN`/`TG_CHAT_ID`
  env vars only (see Step 4 above). The Settings modal's "Send test
  message" button now calls the server's `/api/telegram-test`.
- **Ratio and mode (Ratio vs Calendar/Diagonal) are locked in at the
  moment you set the alert** — same as the simpler dashboard's alerts.
  If you change a builder's Ratio afterward, alerts you already saved on
  that builder keep watching the ratio they were saved with, not the
  live one. Ratio = 0 (the "solo leg" case) is fully supported.
- Everything else — live prices, the spread ladders, Buy/Sell adding to
  the payoff draft, the payoff chart, analytics — is 100% unchanged and
  still runs entirely client-side in your browser, same as before.
- The dashboard is behind the same Basic Auth login as everything else on
  this server (Step: DASH_USER/DASH_PASS) — no separate setup needed.

## Known free-tier limits (accepted trade-offs)

- Supabase free projects pause after **7 days with zero database
  activity** — not a concern here, since the alert loop queries the
  database every `POLL_MS` around the clock, which counts as activity.
- Render's free tier gives **750 instance-hours/month** — a single
  always-on service uses about 720-750 hours in a 30-31 day month, so
  this is right at the edge. If you hit the cap some month, the service
  pauses until the next month starts. Upgrading to Render's $7/mo Starter
  removes this cap entirely if it becomes a problem.
- None of this is a paid, guaranteed-uptime SLA — treat it as "very
  reliable for personal use," not mission-critical infrastructure.
