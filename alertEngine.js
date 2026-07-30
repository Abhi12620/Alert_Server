// alertEngine.js
// The heart of the 24/7 checker. Every poll cycle:
//   1. Fetch the live option chain for whichever underlyings have alerts
//   2. For each saved alert, recompute that exact spread's LTP/BID/ASK
//      using the SAME formula as alerts_dashboard.html's renderSideSpread():
//      Spread = Strike1.LTP − Strike2.LTP×Ratio, single expiry, and s2 is
//      whatever strike was NEAREST to (s1 ± gap) at the moment the alert
//      was created — the dashboard bakes s2 into the alert id itself
//      (`side|expiry|s1|s2`), so we look that exact s2 up directly rather
//      than recomputing "nearest" again (the nearest strike can drift
//      between poll cycles as new strikes list; re-deriving it would
//      silently change which spread the alert is watching).
//   3. Compare against the alert's condition; fire once on cross, re-arm
//      once the condition clears — identical semantics to the dashboard's
//      evaluateAlerts()/fireAlert().

const { fetchOptionChain } = require('./delta');
const { sendTelegram } = require('./telegram');
const db = require('./db');

// Builds { strike: row } maps per (expiry, contract_type). This dashboard
// has no leg-collision case (one row per strike per expiry/side already),
// so a plain last-write-wins map matches the original's `map[r.strike] = r`.
function indexChain(rows) {
  const idx = {}; // idx[expiry][contract_type][strike] = row
  for (const r of rows) {
    idx[r.expiry] = idx[r.expiry] || {};
    idx[r.expiry][r.contract_type] = idx[r.expiry][r.contract_type] || {};
    idx[r.expiry][r.contract_type][r.strike] = r;
  }
  return idx;
}

// Recomputes ltp/bid/ask for one alert's spread: Spread = Strike1 − Strike2×Ratio,
// same expiry, exact strikes as stored on the alert (s1, s2 are fixed at
// creation time, matching how the dashboard bakes them into the alert id).
function computeSpreadValues(alert, chainIndex) {
  const contractType = alert.side === 'call' ? 'call_options' : 'put_options';
  const s1 = Number(alert.s1), s2 = Number(alert.s2), ratio = Number(alert.ratio) || 1;

  const leg1 = chainIndex[alert.expiry]?.[contractType]?.[s1];
  const leg2 = chainIndex[alert.expiry]?.[contractType]?.[s2];
  if (!leg1 || !leg2) return null;

  return {
    ltp: (leg1.ltp != null && leg2.ltp != null) ? leg1.ltp - leg2.ltp * ratio : null,
    bid: (leg1.ask != null && leg2.bid != null) ? leg1.ask - leg2.bid * ratio : null,
    ask: (leg1.bid != null && leg2.ask != null) ? leg1.bid - leg2.ask * ratio : null,
  };
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

async function fireAlert(alert, value) {
  const opLabel = alert.op === 'gte' ? '≥' : '≤';
  const title = `🔔 Spread alert: ${alert.s1}/${alert.s2} (${alert.side.toUpperCase()}) · ${alert.expiry}`;
  const body = `${alert.field.toUpperCase()} ${opLabel} ${fmt(alert.value)} — now ${fmt(value)}`;
  const res = await sendTelegram(`${title}\n${body}`);
  if (!res.ok) {
    console.error(`[alertEngine] Telegram send failed for alert ${alert.id}:`, res.error);
  } else {
    console.log(`[alertEngine] Fired + sent: ${alert.id}`);
  }
}

// One full poll cycle. Called on an interval by server.js.
async function runCycle() {
  const alerts = await db.listAlerts();
  if (alerts.length === 0) return; // nothing to check — cheapest possible cycle

  // group alerts by underlying so we only fetch each chain once per cycle
  const byUnderlying = {};
  for (const a of alerts) {
    (byUnderlying[a.underlying] = byUnderlying[a.underlying] || []).push(a);
  }

  for (const underlying of Object.keys(byUnderlying)) {
    let chainIndex;
    try {
      const rows = await fetchOptionChain(underlying);
      chainIndex = indexChain(rows);
    } catch (e) {
      console.error(`[alertEngine] chain fetch failed for ${underlying}:`, e.message);
      continue; // skip this underlying's alerts this cycle, try again next cycle
    }

    for (const alert of byUnderlying[underlying]) {
      const vals = computeSpreadValues(alert, chainIndex);
      if (!vals) continue; // strikes not live this cycle — skip, don't misfire
      const v = vals[alert.field];
      if (v === null || v === undefined || isNaN(v)) continue;

      const conditionTrue = alert.op === 'gte' ? v >= Number(alert.value) : v <= Number(alert.value);

      if (conditionTrue && !alert.fired) {
        await fireAlert(alert, v);
        await db.setFired(alert.id, true);
      } else if (!conditionTrue && alert.fired) {
        await db.setFired(alert.id, false); // re-arm once condition clears
      }
    }
  }
}

module.exports = { runCycle, computeSpreadValues, indexChain };
