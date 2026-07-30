// delta.js
// Talks to Delta Exchange India's public REST API — the same endpoints the
// ODD_V5 dashboard uses in the browser (see api.india.delta.exchange calls
// in ODD_V5.html). No auth needed for public market data.

const fetch = require('node-fetch');

const BASE = 'https://api.india.delta.exchange';

// Delta doesn't expose one universal "futures" symbol per coin the same way
// for every asset; BTC/ETH perpetuals are BTCUSD / ETHUSD on Delta India.
function futuresSymbolFor(underlying) {
  return `${underlying}USD`;
}

// Fetches the perpetual futures ticker for spot/underlying price — same
// call as the dashboard's fetchFuturesPrice().
async function fetchFuturesPrice(underlying) {
  const symbol = futuresSymbolFor(underlying);
  const res = await fetch(`${BASE}/v2/tickers/${symbol}`);
  if (!res.ok) throw new Error(`futures ticker HTTP ${res.status}`);
  const json = await res.json();
  const r = json && json.result;
  if (!r) throw new Error('futures ticker: empty result');
  const priceRaw = (r.mark_price && r.mark_price !== '') ? r.mark_price : r.close;
  const price = parseFloat(priceRaw);
  return isNaN(price) ? null : price;
}

// Fetches the full call+put option chain for one underlying — same call
// (and same field names) as the dashboard's chain snapshot fetch. Returns
// a flat array of rows shaped like what renderSideSpread() expects:
// { symbol, strike, expiry, contract_type, ltp, bid, ask, volume }
async function fetchOptionChain(underlying) {
  const url = `${BASE}/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=${underlying}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`option chain HTTP ${res.status}`);
  const json = await res.json();
  const list = (json && json.result) || [];

  return list.map(r => {
    const q = r.quotes || {};
    const bid = q.best_bid != null && q.best_bid !== '' ? parseFloat(q.best_bid) : null;
    const ask = q.best_ask != null && q.best_ask !== '' ? parseFloat(q.best_ask) : null;
    const ltpRaw = r.close ?? r.mark_price ?? null;
    const ltp = ltpRaw != null ? parseFloat(ltpRaw) : null;
    return {
      symbol: r.symbol,
      strike: r.strike_price != null ? parseFloat(r.strike_price) : null,
      expiry: extractExpiry(r.symbol),
      contract_type: r.contract_type, // 'call_options' | 'put_options'
      ltp: isNaN(ltp) ? null : ltp,
      bid: (bid != null && !isNaN(bid)) ? bid : null,
      ask: (ask != null && !isNaN(ask)) ? ask : null,
      volume: r.volume != null ? parseFloat(r.volume) : null,
    };
  }).filter(r => r.strike != null && r.expiry != null);
}

// Same symbol format Delta uses: C-BTC-68000-250725 / P-BTC-68000-250725
// The last dash-separated part is DDMMYY.
function extractExpiry(symbol) {
  if (!symbol) return null;
  const parts = symbol.split('-');
  const d = parts[parts.length - 1];
  if (!/^\d{6}$/.test(d)) return null;
  const dd = d.slice(0, 2), mm = d.slice(2, 4), yy = '20' + d.slice(4, 6);
  return `${yy}-${mm}-${dd}`;
}

module.exports = { fetchFuturesPrice, fetchOptionChain, futuresSymbolFor, extractExpiry };
