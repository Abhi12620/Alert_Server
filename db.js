// db.js
// Talks to the Supabase (Postgres) database. This is the ONLY place SQL
// lives, so the rest of the app just calls plain JS functions.
//
// Why Postgres and not a local file/SQLite: Render's free web service has
// an EPHEMERAL filesystem — any local file is wiped on every restart,
// redeploy, or sleep/wake cycle. Supabase's free Postgres is a separate,
// persistent service, so alerts survive restarts. See the setup guide
// (SETUP.md) for how the two connect.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set. Add it in Render → Environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooler requires SSL; reject:false is standard for hosted
  // Postgres providers that use a proxy-issued cert Node doesn't recognize.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // A dropped idle connection should not crash the whole process — the
  // pool reconnects on the next query automatically.
  console.error('[db] Unexpected pool error (will retry on next query):', err.message);
});

// Creates the alerts table on first run. Safe to call on every boot —
// IF NOT EXISTS makes it a no-op after the first successful deploy.
// Note: expiry2/mode columns are kept for forward-compatibility (in case
// a calendar-spread dashboard is wired to the same server later) but are
// unused by alerts_dashboard.html, which only does same-expiry ratio spreads.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id           TEXT PRIMARY KEY,
      side         TEXT NOT NULL,
      expiry       TEXT NOT NULL,
      expiry2      TEXT,
      s1           NUMERIC NOT NULL,
      s2           NUMERIC NOT NULL,
      mode         TEXT NOT NULL DEFAULT 'ratio',
      ratio        NUMERIC NOT NULL DEFAULT 1,
      field        TEXT NOT NULL,
      op           TEXT NOT NULL,
      value        NUMERIC NOT NULL,
      fired        BOOLEAN NOT NULL DEFAULT FALSE,
      underlying   TEXT NOT NULL DEFAULT 'BTC',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[db] Schema ready (alerts table present).');
}

async function listAlerts() {
  const { rows } = await pool.query('SELECT * FROM alerts ORDER BY created_at ASC');
  return rows;
}

async function upsertAlert(alert) {
  const { id, side, expiry, expiry2, s1, s2, mode, ratio, field, op, value, underlying } = alert;
  const { rows } = await pool.query(
    `INSERT INTO alerts (id, side, expiry, expiry2, s1, s2, mode, ratio, field, op, value, fired, underlying)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, FALSE, $12)
     ON CONFLICT (id) DO UPDATE SET
       expiry2 = EXCLUDED.expiry2,
       mode    = EXCLUDED.mode,
       ratio   = EXCLUDED.ratio,
       field   = EXCLUDED.field,
       op      = EXCLUDED.op,
       value   = EXCLUDED.value,
       fired   = FALSE
     RETURNING *`,
    [id, side, expiry, expiry2 || null, s1, s2, mode || 'ratio', ratio || 1, field, op, value, underlying || 'BTC']
  );
  return rows[0];
}

async function deleteAlert(id) {
  await pool.query('DELETE FROM alerts WHERE id = $1', [id]);
}

async function setFired(id, fired) {
  await pool.query('UPDATE alerts SET fired = $2 WHERE id = $1', [id, fired]);
}

module.exports = { pool, initSchema, listAlerts, upsertAlert, deleteAlert, setFired };
