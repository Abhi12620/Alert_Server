// server.js
// Entry point. Three jobs:
//   1. Serve the dashboard (public/dashboard.html) + a small JSON API so
//      the bell-button UI can save/list/delete alerts on THIS server
//      instead of localStorage.
//   2. Run a background interval that polls Delta Exchange and evaluates
//      every saved alert — this keeps running even with zero browser tabs
//      open, which is the whole point.
//   3. Expose GET /ping — a free external monitor (UptimeRobot etc.) hits
//      this every few minutes so Render's free tier never spins the
//      service down from inactivity. See SETUP.md.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { fetchFuturesPrice, fetchOptionChain } = require('./delta');
const { runCycle } = require('./alertEngine');
const { sendTelegram } = require('./telegram');

const app = express();

// ---- HTTP Basic Auth: protects the dashboard + all /api routes with a
// username/password (set via env vars). /ping and /healthz are left OPEN
// on purpose — UptimeRobot's keep-alive pings don't send credentials, so
// locking those too would make the ping fail, the service would then sleep
// after 15 min idle, and your alerts would stop running in the background.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function basicAuth(req, res, next) {
  const user = process.env.DASH_USER;
  const pass = process.env.DASH_PASS;
  if (!user || !pass) {
    // no credentials configured on the server — fail closed rather than
    // silently serving the dashboard unprotected
    res.status(500).send('Dashboard login is not configured. Set DASH_USER and DASH_PASS in Render → Environment.');
    return;
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = decoded.slice(0, sep);
    const reqPass = decoded.slice(sep + 1);
    if (timingSafeEqual(reqUser, user) && timingSafeEqual(reqPass, pass)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Alert Dashboard"');
  res.status(401).send('Login required.');
}

app.use(express.json());

// /ping and /healthz must be registered BEFORE the auth middleware so they
// stay reachable without a login prompt.
const POLL_MS = parseInt(process.env.POLL_MS || '2000', 10); // same 2s cadence as the live dashboards

app.get('/ping', (req, res) => {
  res.status(200).send('alive');
});
app.get('/healthz', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// everything registered after this line requires the dashboard login
app.use(basicAuth);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---- alerts CRUD — mirrors state.alerts from the dashboard, but backed
// by Postgres instead of localStorage so it survives restarts ----
app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await db.listAlerts();
    res.json(alerts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const { id, side, expiry, expiry2, s1, s2, mode, ratio, field, op, value, underlying } = req.body;
    if (!id || !side || !expiry || s1 == null || s2 == null || !field || !op || value == null) {
      return res.status(400).json({ error: 'Missing required alert fields' });
    }
    if (!['ltp', 'bid', 'ask'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
    if (!['gte', 'lte'].includes(op)) return res.status(400).json({ error: 'Invalid op' });
    const saved = await db.upsertAlert({ id, side, expiry, expiry2, s1, s2, mode, ratio, field, op, value, underlying });
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  try {
    await db.deleteAlert(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- live chain passthrough — lets the dashboard UI show current
// strikes/prices without hitting Delta directly from the browser, and
// keeps everything on one origin (avoids any CORS surprises) ----
app.get('/api/chain/:underlying', async (req, res) => {
  try {
    const rows = await fetchOptionChain(req.params.underlying.toUpperCase());
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/api/spot/:underlying', async (req, res) => {
  try {
    const price = await fetchFuturesPrice(req.params.underlying.toUpperCase());
    res.json({ price });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- manual Telegram test button on the settings page ----
app.post('/api/telegram-test', async (req, res) => {
  const result = await sendTelegram('✅ Test message from your 24/7 alert server.');
  res.json(result);
});

// ---- background polling loop ----
let cycleRunning = false;
async function tick() {
  if (cycleRunning) return; // don't overlap cycles if one runs long
  cycleRunning = true;
  try {
    await runCycle();
  } catch (e) {
    console.error('[server] runCycle threw:', e.message);
  } finally {
    cycleRunning = false;
  }
}

async function start() {
  await db.initSchema();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[server] Listening on :${PORT}`);
    console.log(`[server] Polling every ${POLL_MS}ms`);
    setInterval(tick, POLL_MS);
    tick(); // fire the first cycle immediately instead of waiting POLL_MS
  });
}

start().catch(e => {
  console.error('[server] Fatal startup error:', e);
  process.exit(1);
});
