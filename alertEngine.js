// alertEngine.js
// The heart of the 24/7 checker. Every poll cycle:
//   1. Fetch the live option chain for whichever underlyings have alerts
//   2. For each saved alert, recompute that exact spread's LTP/BID/ASK.
//      s1/s2 (and expiry/expiry2) are fixed at save-time by whichever
//      dashboard created the alert — this file doesn't care which
//      dashboard that was, only the mode/expiry2 columns, which both
//      dashboards populate consistently. See computeSpreadValues() below.
//   3. Compare against the alert's condition; fire once on cross, re-arm
//      once the condition clears — identical semantics to the dashboards'
//      own evaluateAlerts()/fireAlert() (now server-side only).

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

// Recomputes ltp/bid/ask for one alert's spread. Two dashboards write to
// this same table, distinguished purely by the `mode`/`expiry2` columns
// (both already existed in the schema for forward-compatibility):
//
//  - alerts_dashboard.html: always mode='ratio', expiry2 unused — same
//    expiry both legs. Unchanged behavior from before.
//  - ODD_V5.html: mode is 'ratio' OR 'calendar', and can set a distinct
//    expiry2 for calendar/diagonal spreads. Also supports Ratio = 0,
//    which per ODD_V5's own spec means "solo leg" — the "shifted"/"near"
//    leg contributes nothing, so only the remaining leg's own price is
//    needed (and that leg alone must be live, not both).
//
// s1/s2 are always the exact, fixed strikes captured at the moment the
// alert was saved (both dashboards do this — nearest-neighbor or
// exact-match resolution already happened client-side before saving), so
// this function does a strict lookup, never a fresh nearest-match.
function computeSpreadValues(alert, chainIndex) {
  const contractType = alert.side === 'call' ? 'call_options' : 'put_options';
  const s1 = Number(alert.s1), s2 = Number(alert.s2);
  const ratioRaw = Number(alert.ratio);
  const ratio = isNaN(ratioRaw) ? 1 : ratioRaw; // NaN falls back to 1; a real 0 must stay 0
  const isCalendar = alert.mode === 'calendar' && alert.expiry2 && alert.expiry2 !== alert.expiry;

  const expiry1 = alert.expiry;
  const expiry2 = isCalendar ? alert.expiry2 : alert.expiry;
  const leg1 = chainIndex[expiry1]?.[contractType]?.[s1]; // near (calendar) / base (ratio)
  const leg2 = chainIndex[expiry2]?.[contractType]?.[s2]; // far (calendar) / shifted (ratio)

  if (ratio === 0) {
    // Solo-leg row: the leg that would be multiplied by Ratio drops out
    // entirely, so only the remaining leg needs to be live.
    const soloLeg = isCalendar ? leg2 : leg1;
    if (!soloLeg) return null;
    return { ltp: soloLeg.ltp, bid: soloLeg.bid, ask: soloLeg.ask };
  }

  if (!leg1 || !leg2) return null;

  if (isCalendar) {
    // Spread = Far − Near×Ratio
    return {
      ltp: (leg2.ltp != null && leg1.ltp != null) ? leg2.ltp - leg1.ltp * ratio : null,
      bid: (leg2.ask != null && leg1.bid != null) ? leg2.ask - leg1.bid * ratio : null,
      ask: (leg2.bid != null && leg1.ask != null) ? leg2.bid - leg1.ask * ratio : null,
    };
  }
  // Spread = Strike1(base) − Strike2(shifted)×Ratio
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
  // ODD_V5 ids are `n|side|expiry1|expiry2|s1|s2` — pull the builder number
  // out if present so the message says which of the 3 groups fired.
  const idParts = String(alert.id).split('|');
  const builderPrefix = idParts.length === 6 ? `#${idParts[0]} ` : '';
  const isCalendar = alert.mode === 'calendar' && alert.expiry2 && alert.expiry2 !== alert.expiry;
  const expiryLabel = isCalendar ? `${alert.expiry} → ${alert.expiry2}` : alert.expiry;
  const title = `🔔 Spread alert ${builderPrefix}: ${alert.s1}/${alert.s2} (${alert.side.toUpperCase()}) · ${expiryLabel}`;
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
