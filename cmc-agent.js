#!/usr/bin/env node
/**
 * cmc-agent | CoinMarketCap API agent CLI (CMC API Hackathon 2026 entry, BUIDL)
 * Zero-dependency Node.js (>=18). Agent-first design: every command is also a
 * composable tool with JSON output, and `ask` answers plain-language questions
 * while printing a transparent tool-use trace.
 *
 * Commands:
 *   price <SYM[,SYM...]>          Latest quotes (price, mcap, %1h/24h/7d, volume)
 *   top [N]                       Top N by market cap (default 10)
 *   gainers [N] | losers [N]      Top movers 24h (default 10)
 *   trending [N]                  CMC trending coins (most viewed/searched)
 *   ohlcv <SYM>                   Latest OHLCV bar (open/high/low/close/volume)
 *   compare <SYM1,SYM2,...>       Side-by-side compare (price, mcap, moves)
 *   global                        Global market metrics (total mcap, dominance)
 *   fng                           Fear & Greed index
 *   map <SYM>                     Resolve symbol -> CMC id(s) + rank
 *   verify <SYM>                  Trust score for a symbol's market data (0-100)
 *   dex pairs <dex> <network> [N] Top DEX spot pairs (e.g. uniswap-v3 ethereum)
 *   dex pair <network> <address>  Single pair quote by pool contract address
 *   ask "<question>"              Natural-language query with tool-use trace
 *   watch add <SYM> --above X | --below Y | --change24h PCT
 *   watch list | watch rm <id> | watch run [--json]
 *
 * Config: CMC_API_KEY env var, or CMC_API_KEY= in ~/.cmc-hack/env
 * Options: --json for machine output; --trace writes request evidence to stderr.
 * CMC_CONFIG_DIR isolates watch state and configuration.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://pro-api.coinmarketcap.com';
const DIR = process.env.CMC_CONFIG_DIR || path.join(os.homedir(), '.cmc-hack');
const WATCH_FILE = path.join(DIR, 'watchlist.json');

function loadKey() {
  if (process.env.CMC_API_KEY) return process.env.CMC_API_KEY;
  try {
    const line = fs.readFileSync(path.join(DIR, 'env'), 'utf8')
      .split('\n').find(l => l.startsWith('CMC_API_KEY='));
    if (line) return line.slice('CMC_API_KEY='.length).trim();
  } catch {}
  fail('No CMC_API_KEY. Set env or write CMC_API_KEY=... to ' + path.join(DIR, 'env'));
}
function fail(msg, code = 1) { const e = new Error(msg); e.exitCode = code; throw e; }

const trace = [];
let totalCredits = 0;

async function api(p, params = {}) {
  const key = loadKey();
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const t = { endpoint: p, params, requested_at: new Date().toISOString(), outcome: 'pending', credits: null };
  trace.push(t);
  try {
    const res = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    t.http_status = res.status;
    let body;
    try { body = await res.json(); } catch { fail('CMC returned a non-JSON response (HTTP ' + res.status + ')'); }
    const st = body.status || {};
    t.api_status = st.error_code ?? null;
    t.response_timestamp = st.timestamp ?? null;
    t.credits = Number.isFinite(st.credit_count) ? st.credit_count : null;
    if (t.credits !== null) totalCredits += t.credits;
    if (!res.ok || String(st.error_code) !== '0') fail('CMC request failed (HTTP ' + res.status + ', API ' + String(st.error_code ?? 'missing') + ')');
    if (body.data == null) fail('CMC response has no data');
    fresh(st.timestamp, 'response');
    t.outcome = 'success';
    if (process.env.CMC_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.CMC_EVIDENCE_DIR, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(process.env.CMC_EVIDENCE_DIR, Date.now() + '-' + require('crypto').randomUUID() + '.json'), JSON.stringify({request: {host: BASE, endpoint: p, params}, response: body}, null, 2), {mode: 0o600, flag: 'wx'});
    }
    return body.data;
  } catch (e) {
    t.outcome = 'error';
    // Never echo a server body, request header, or arbitrary network exception.
    if (/^(CMC|No CMC)/.test(e.message)) throw e;
    fail(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'CMC request timed out after 15 seconds' : 'CMC network request failed');
  }
}

function positiveCount(v = '10') {
  if (!/^\d+$/.test(String(v)) || +v < 1 || +v > 100) fail('count must be an integer from 1 to 100');
  return +v;
}
function symbolList(v) {
  const arr = [...new Set(v.split(',').map(x => x.trim().toUpperCase()).filter(Boolean))];
  if (!arr.length || arr.length > 100 || arr.some(x => !/^[A-Z0-9]{1,20}$/.test(x))) fail('use 1-100 comma-separated asset symbols');
  return arr;
}
function validateRule(r) {
  if (!r || typeof r.id !== 'string' || typeof r.symbol !== 'string' || !/^[A-Z0-9]{1,20}$/.test(r.symbol)) fail('invalid watch rule');
  const values = ['above', 'below', 'change24h'].filter(k => r[k] != null);
  if (values.length !== 1 || values.some(k => !Number.isFinite(r[k]) || r[k] <= 0)) fail('watch rule requires exactly one positive finite threshold');
  return r;
}

const fmtUsd = n => !Number.isFinite(n) ? 'n/a' : '$' + (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const fmtPct = n => !Number.isFinite(n) ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtBig = n => !Number.isFinite(n) ? 'n/a' : '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);

function fresh(timestamp, label = 'quote', maxMs = 15 * 60 * 1000) {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t) || Date.now() - t > maxMs || t - Date.now() > 5 * 60 * 1000) fail(label + ' timestamp is missing, stale, or in the future');
}
function quoteRow(q) {
  if (!q || typeof q.symbol !== 'string' || typeof q.name !== 'string') fail('malformed quote identity');
  const usd = q.quote?.USD || {};
  return {
    id: q.id, symbol: q.symbol, name: q.name, rank: q.cmc_rank, last_updated: usd.last_updated ?? q.last_updated ?? null,
    price: usd.price, change_1h: usd.percent_change_1h, change_24h: usd.percent_change_24h,
    change_7d: usd.percent_change_7d, market_cap: usd.market_cap, volume_24h: usd.volume_24h,
  };
}
function printRow(r) {
  console.log(`#${String(r.rank ?? '-').padEnd(4)} ${r.symbol.padEnd(8)} ${r.name.padEnd(20).slice(0,20)} ${fmtUsd(r.price).padStart(12)}  1h ${fmtPct(r.change_1h).padStart(8)}  24h ${fmtPct(r.change_24h).padStart(8)}  7d ${fmtPct(r.change_7d).padStart(8)}  mcap ${fmtBig(r.market_cap).padStart(9)}`);
}

function loadWatch() {
  let raw;
  try { raw = fs.readFileSync(WATCH_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; fail('cannot read watchlist; refusing to overwrite'); }
  let w;
  try { w = JSON.parse(raw); } catch { fail('watchlist is corrupt; refusing to overwrite'); }
  if (!Array.isArray(w)) fail('watchlist must be an array; refusing to overwrite');
  return w.map(validateRule);
}
function saveWatch(w) {
  w.forEach(validateRule);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = WATCH_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2), {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, WATCH_FILE);
}

const ALIASES = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', bnb: 'BNB' };

async function cmdPrice(symbols) {
  symbols = symbolList(symbols.join(','));
  const data = await api('/v2/cryptocurrency/quotes/latest', { symbol: symbols.join(',') });
  // a symbol can map to many assets; keep the canonical one (lowest rank, priced)
  const rows = symbols.map(s => {
    const d = data[s.toUpperCase()];
    const arr = (Array.isArray(d) ? d : d ? [d] : []).map(quoteRow)
      .filter(r => Number.isFinite(r.price) && r.price > 0)
      .sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
    if (!arr.length) fail('no priced asset returned for ' + s);
    fresh(arr[0].last_updated);
    return { ...arr[0], symbol_matches: Array.isArray(d) ? d.length : 1, resolution: 'lowest CMC rank with a positive finite USD price' };
  }).filter(Boolean);
  if (!rows.length) fail('symbol not found: ' + symbols.join(','));
  return rows;
}
async function cmdTop(n) {
  const data = await api('/v1/cryptocurrency/listings/latest', { limit: n, convert: 'USD' });
  if (!Array.isArray(data) || !data.length) fail('no listings returned');
  return data.map(quoteRow);
}
async function cmdMovers(kind, n) {
  // Sort the full listings server-side, not a truncated native gainers sample.
  const data = await api('/v1/cryptocurrency/listings/latest', {
    limit: n, sort: 'percent_change_24h', sort_dir: kind === 'gainers' ? 'desc' : 'asc', convert: 'USD',
  });
  if (!Array.isArray(data) || !data.length) fail('no movers returned');
  if (!Array.isArray(data) || !data.length) fail('no listings returned');
  return data.map(quoteRow);
}
async function cmdTrending(n) {
  const data = await api('/v1/cryptocurrency/trending/latest', { limit: n, convert: 'USD' });
  if (!Array.isArray(data) || !data.length) fail('no trending assets returned');
  return data.slice(0, n).map(quoteRow);
}
async function cmdOhlcv(sym) {
  const data = await api('/v2/cryptocurrency/ohlcv/latest', { symbol: sym });
  const d = data[sym.toUpperCase()];
  const arr = (Array.isArray(d) ? d : d ? [d] : []);
  const rows = arr.map(o => {
    const q = (o.quote && o.quote.USD) || {};
    return { id: o.id, symbol: o.symbol, time_open: o.time_open, time_high: o.time_high, time_low: o.time_low,
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, last_updated: q.last_updated };
  }).filter(r => r.close != null);
  if (!rows.length) fail('no OHLCV for ' + sym);
  // v2 returns every symbol collision; canonical = highest 24h volume
  rows.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return [rows[0]];
}
async function cmdCompare(symbols) {
  const rows = await cmdPrice(symbols);
  return rows.map(r => ({
    id: r.id, symbol: r.symbol, last_updated: r.last_updated, rank: r.rank, price: r.price, market_cap: r.market_cap,
    volume_24h: r.volume_24h, change_1h: r.change_1h, change_24h: r.change_24h, change_7d: r.change_7d,
    vol_mcap_ratio: r.market_cap ? +(r.volume_24h / r.market_cap).toFixed(4) : null,
  }));
}
async function cmdGlobal() {
  const d = await api('/v1/global-metrics/quotes/latest', { convert: 'USD' });
  const q = d.quote?.USD;
  if (!q || !Number.isFinite(d.btc_dominance) || !Number.isFinite(d.eth_dominance)) fail('global metrics are incomplete');
  return {
    total_market_cap: q.total_market_cap, total_volume_24h: q.total_volume_24h,
    btc_dominance: d.btc_dominance, eth_dominance: d.eth_dominance,
    altcoin_market_cap: q.altcoin_market_cap, defi_volume_24h: d.defi_volume_24h,
    active_cryptocurrencies: d.active_cryptocurrencies,
  };
}
async function cmdFng() {
  const d = await api('/v3/fear-and-greed/latest', {});
  if (!Number.isFinite(d.value) || d.value < 0 || d.value > 100 || !d.value_classification || !d.update_time) fail('sentiment data is incomplete');
  return { value: d.value, classification: d.value_classification, updated: d.update_time };
}
async function cmdMap(sym) {
  const data = await api('/v1/cryptocurrency/map', { symbol: sym });
  if (!Array.isArray(data) || !data.length) fail('no symbol matches returned');
  return data.slice(0, 5).map(d => ({ id: d.id, symbol: d.symbol, name: d.name, rank: d.rank, active: d.is_active === 1 }));
}


const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'TUSD', 'PYUSD', 'USDD']);

// cmdVerify: trust score for a symbol's market data (0-100).
// Answers "can you trust this number?" with deterministic checks over three
// independent CMC endpoints: quotes, symbol map, and OHLCV.
async function cmdVerify(sym) {
  sym = symbolList(sym)[0];
  const quotes = await api('/v2/cryptocurrency/quotes/latest', { symbol: sym });
  const map = await api('/v1/cryptocurrency/map', { symbol: sym });
  const ohlcv = await api('/v2/cryptocurrency/ohlcv/latest', { symbol: sym });

  // resolve the canonical asset the same way `price` does
  const d = quotes[sym];
  const cands = (Array.isArray(d) ? d : d ? [d] : []).map(quoteRow)
    .filter(r => Number.isFinite(r.price) && r.price > 0)
    .sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
  if (!cands.length) fail('no priced asset returned for ' + sym);
  const r = cands[0];

  const mapArr = Array.isArray(map) ? map : [];
  const active = mapArr.filter(m => m.is_active === 1).sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
  const ohlcvArr = (Array.isArray(ohlcv[sym]) ? ohlcv[sym] : ohlcv[sym] ? [ohlcv[sym]] : []);
  const bar = ohlcvArr.find(o => o.id === r.id) || null;
  const close = bar && bar.quote && bar.quote.USD ? bar.quote.USD.close : null;

  const checks = [];
  const add = (name, points, max, detail) => checks.push({ name, points, max, detail });

  // 1. resolution clarity: how ambiguous is this symbol
  const n = active.length || mapArr.length;
  if (n <= 1) add('resolution_clarity', 20, 20, (active.length || 'no') + ' active match(es); unambiguous');
  else if ((r.rank ?? 9e9) === 1) add('resolution_clarity', 16, 20, n + ' active matches; resolved to rank #1');
  else if ((r.rank ?? 9e9) <= 100) add('resolution_clarity', 10, 20, n + ' active matches; resolved to rank #' + r.rank);
  else add('resolution_clarity', 4, 20, n + ' active matches; resolved to weak rank #' + r.rank);

  // 2. freshness of the quote
  const ageSec = (Date.now() - Date.parse(r.last_updated)) / 1000;
  if (!Number.isFinite(ageSec)) add('freshness', 0, 20, 'no quote timestamp');
  else if (ageSec <= 300) add('freshness', 20, 20, 'quote ' + Math.round(ageSec) + 's old');
  else if (ageSec <= 900) add('freshness', 14, 20, 'quote ' + Math.round(ageSec / 60) + 'm old');
  else if (ageSec <= 3600) add('freshness', 6, 20, 'quote ' + Math.round(ageSec / 60) + 'm old');
  else add('freshness', 0, 20, 'quote ' + Math.round(ageSec / 3600) + 'h old');

  // 3. cross-endpoint consistency: quotes price vs OHLCV close
  if (!Number.isFinite(close) || close <= 0) add('cross_endpoint_consistency', 0, 20, 'no OHLCV close for resolved id ' + r.id);
  else {
    const dev = Math.abs(r.price - close) / r.price;
    if (dev <= 0.005) add('cross_endpoint_consistency', 20, 20, 'quotes vs OHLCV close differ ' + (dev * 100).toFixed(2) + '%');
    else if (dev <= 0.02) add('cross_endpoint_consistency', 12, 20, 'quotes vs OHLCV close differ ' + (dev * 100).toFixed(2) + '%');
    else if (dev <= 0.05) add('cross_endpoint_consistency', 5, 20, 'quotes vs OHLCV close differ ' + (dev * 100).toFixed(2) + '%');
    else add('cross_endpoint_consistency', 0, 20, 'quotes vs OHLCV close differ ' + (dev * 100).toFixed(2) + '% (endpoint disagreement)');
  }

  // 4. volume/market-cap sanity
  const ratio = r.market_cap > 0 ? r.volume_24h / r.market_cap : null;
  if (ratio === null) add('volume_mcap_sanity', 0, 15, 'no market cap');
  else if (ratio >= 0.001 && ratio <= 2) add('volume_mcap_sanity', 15, 15, 'volume/mcap ' + ratio.toFixed(4));
  else if (ratio >= 0.0001 && ratio <= 5) add('volume_mcap_sanity', 8, 15, 'volume/mcap ' + ratio.toFixed(4) + ' (unusual)');
  else add('volume_mcap_sanity', 0, 15, 'volume/mcap ' + ratio.toFixed(4) + ' (extreme; dead or wash-traded market)');

  // 5. short-term move plausibility
  if (!Number.isFinite(r.change_1h)) add('move_plausibility', 5, 10, 'no 1h change reported');
  else if (Math.abs(r.change_1h) <= 15) add('move_plausibility', 10, 10, '1h move ' + r.change_1h.toFixed(2) + '%');
  else if (Math.abs(r.change_1h) <= 40) add('move_plausibility', 5, 10, '1h move ' + r.change_1h.toFixed(2) + '% (large)');
  else add('move_plausibility', 0, 10, '1h move ' + r.change_1h.toFixed(2) + '% (possible bad tick)');

  // 6. stablecoin peg (tracked stables) or identity confirmation (others)
  let cap = null;
  if (STABLECOINS.has(sym)) {
    const dev = Math.abs(r.price - 1);
    const pct = (dev * 100).toFixed(2) + '%';
    if (dev <= 0.005) add('stablecoin_peg', 15, 15, 'peg deviation ' + pct);
    else if (dev <= 0.02) add('stablecoin_peg', 8, 15, 'peg deviation ' + pct);
    else if (dev <= 0.05) { add('stablecoin_peg', 3, 15, 'peg deviation ' + pct); cap = ['CAUTION', 'stablecoin ' + pct + ' off peg']; }
    else { add('stablecoin_peg', 0, 15, 'peg deviation ' + pct); cap = ['UNRELIABLE', 'stablecoin ' + pct + ' off peg']; }
  } else {
    const best = active[0];
    if (best && best.id === r.id) add('identity_confirmation', 15, 15, 'quote id ' + r.id + ' matches top-ranked map entry');
    else if (best) add('identity_confirmation', 5, 15, 'quote id ' + r.id + ' != top-ranked map id ' + best.id);
    else add('identity_confirmation', 10, 15, 'no active map entry to cross-check identity');
  }

  let score = checks.reduce((s, c) => s + c.points, 0);
  let verdict = score >= 75 ? 'TRUSTED' : score >= 45 ? 'CAUTION' : 'UNRELIABLE';
  if (cap) {
    const order = ['TRUSTED', 'CAUTION', 'UNRELIABLE'];
    if (order.indexOf(verdict) < order.indexOf(cap[0])) verdict = cap[0];
    checks.push({ name: 'verdict_cap', points: null, max: null, detail: 'verdict capped at ' + cap[0] + ': ' + cap[1] });
  }

  return {
    symbol: r.symbol, id: r.id, name: r.name, rank: r.rank,
    trust_score: score, verdict,
    checks,
    context: {
      price: r.price, ohlcv_close: close, active_symbol_matches: n,
      volume_24h: r.volume_24h, market_cap: r.market_cap, change_1h: r.change_1h,
      quote_age_seconds: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
      endpoints: ['/v2/cryptocurrency/quotes/latest', '/v1/cryptocurrency/map', '/v2/cryptocurrency/ohlcv/latest'],
    },
    note: 'deterministic checks over three CMC endpoints; measures data trustworthiness, not investment quality. Not financial advice.',
  };
}

async function cmdDexPairs(dexSlug, networkSlug, n) {
  const data = await api('/v4/dex/spot-pairs/latest', {
    dex_slug: dexSlug, network_slug: networkSlug, limit: n,
  });
  if (!Array.isArray(data) || !data.length) fail('no DEX pairs returned');
  return data.slice(0, n).map(p => {
    const q = (p.quote || [])[0] || {};
    if (!p.contract_address || !Number.isFinite(q.price) || q.price <= 0) fail('DEX pair quote is incomplete');
    return {
      pair: p.name, contract_address: p.contract_address,
      dex: p.dex_slug, network: p.network_slug,
      price_usd: q.price, change_24h: q.percent_change_price_24h,
      volume_24h: q.volume_24h, liquidity: q.liquidity,
      base: p.base_asset_symbol, quote_asset: p.quote_asset_symbol,
      last_updated: q.last_updated || p.last_updated,
    };
  });
}
async function cmdDexPairQuote(networkSlug, address) {
  const data = await api('/v4/dex/pairs/quotes/latest', {
    network_slug: networkSlug, contract_address: address,
  });
  const arr = Array.isArray(data) ? data : data ? [data] : [];
  if (!arr.length) fail('no DEX pair quote returned');
  return arr.map(p => {
    const q = (p.quote || [])[0] || {};
    if (!p.contract_address || !Number.isFinite(q.price) || q.price <= 0) fail('DEX pair quote is incomplete');
    return {
      pair: p.name, contract_address: p.contract_address,
      dex: p.dex_slug, network: p.network_slug,
      price_usd: q.price, change_1h: q.percent_change_price_1h, change_24h: q.percent_change_price_24h,
      volume_24h: q.volume_24h, liquidity: q.liquidity,
      last_updated: q.last_updated || p.last_updated,
    };
  });
}
function printDexRow(r) {
  console.log(`${String(r.pair || '-').padEnd(18).slice(0,18)} ${fmtUsd(r.price_usd).padStart(14)}  24h ${fmtPct(r.change_24h).padStart(8)}  vol ${fmtBig(r.volume_24h).padStart(9)}  liq ${fmtBig(r.liquidity).padStart(9)}`);
}

function resolveSymbol(word) {
  const w = word.toLowerCase();
  if (ALIASES[w]) return ALIASES[w];
  if (/^[A-Za-z]{2,10}$/.test(word)) return word.toUpperCase();
  return null;
}

async function cmdAsk(question) {
  const q = question.toLowerCase();
  if (/\b(buy|sell|invest|recommend|should|predict|forecast|tomorrow)\b/.test(q)) fail('ask supports data lookup only, not trading advice or forecasts');
  const words = question.replace(/[?,.$]/g, '').split(/\s+/);
  const out = { question, tools: [], answer: null };

  const wantsGainers = /gainer|rising|pumping|up most/.test(q);
  const wantsLosers = /loser|falling|dumping|down most/.test(q);
  const wantsGlobal = /global|total market|dominance|market (cap|overview)/.test(q) && !/price of/.test(q);
  const wantsFng = /fear|greed|sentiment/.test(q);
  const wantsTop = /top \d+|top coins|biggest|largest/.test(q);

  let sym = null;
  for (const w of words) {
    if (ALIASES[w.toLowerCase()]) { sym = ALIASES[w.toLowerCase()]; break; }
  }
  if (!sym) for (const w of words) {
    if (/^[A-Z]{2,10}$/.test(w) && !['THE','USD','AND','FOR','WHAT','HOW','IS','TOP','NOW'].includes(w)) { sym = w; break; }
  }

  if (/trending/.test(q)) {
    const rows = await cmdTrending(positiveCount(q.match(/top (\d+)/)?.[1] || '5'));
    out.tools = [...trace];
    out.answer = rows.map(r => `${r.symbol} ${fmtUsd(r.price)}`).join('\n');
  } else if (wantsFng) {
    const f = await cmdFng();
    out.tools = [...trace];
    out.answer = `Fear & Greed index: ${f.value} (${f.classification}), updated ${f.updated}.`;
  } else if (wantsGainers || wantsLosers) {
    const n = positiveCount(q.match(/top (\d+)/)?.[1] || '5');
    const rows = await cmdMovers(wantsGainers ? 'gainers' : 'losers', n);
    out.tools = [...trace];
    out.answer = rows.slice(0, n).map(r =>
      `${r.symbol} ${fmtUsd(r.price)} 24h ${fmtPct(r.change_24h)}`).join('\n');
  } else if (wantsGlobal) {
    const g = await cmdGlobal();
    out.tools = [...trace];
    out.answer = `Total crypto market cap ${fmtBig(g.total_market_cap)}, 24h volume ${fmtBig(g.total_volume_24h)}. BTC dominance ${g.btc_dominance.toFixed(1)}%, ETH ${g.eth_dominance.toFixed(1)}%.`;
  } else if (wantsTop && !sym) {
    const n = positiveCount(q.match(/top (\d+)/)?.[1] || '10');
    const rows = await cmdTop(n);
    out.tools = [...trace];
    out.answer = rows.map(r => `#${r.rank} ${r.symbol} ${fmtUsd(r.price)} mcap ${fmtBig(r.market_cap)}`).join('\n');
  } else if (sym) {
    const rows = await cmdPrice([sym]);
    out.tools = [...trace];
    if (!rows.length) fail('symbol not found: ' + sym);
    const r = rows[0];
    out.answer = `${r.name} (${r.symbol}) is ${fmtUsd(r.price)} | 1h ${fmtPct(r.change_1h)}, 24h ${fmtPct(r.change_24h)}, 7d ${fmtPct(r.change_7d)}. Market cap ${fmtBig(r.market_cap)}, rank #${r.rank}.`;
  } else fail('Could not parse a supported intent. Try: price of BTC / top 10 / biggest gainers / global market / fear and greed');
  return out;
}

async function watchRun(asJson) {
  const rules = loadWatch();
  if (!rules.length) fail('watchlist empty | add rules with: watch add BTC --above 100000');
  const symbols = [...new Set(rules.map(r => r.symbol))];
  const rows = await cmdPrice(symbols);
  const bySym = Object.fromEntries(rows.map(r => [r.symbol, r]));
  const fired = [];
  const unavailable = [];
  for (const rule of rules) {
    const r = bySym[rule.symbol];
    if (!r) fail('missing watch quote for ' + rule.symbol);
    if (rule.change24h != null && !Number.isFinite(r.change_24h)) { unavailable.push({id: rule.id, symbol: rule.symbol, field: 'change_24h'}); continue; }
    let hit = null;
    if (rule.above != null && r.price >= rule.above) hit = `price ${fmtUsd(r.price)} >= ${fmtUsd(rule.above)}`;
    if (rule.below != null && r.price <= rule.below) hit = `price ${fmtUsd(r.price)} <= ${fmtUsd(rule.below)}`;
    if (rule.change24h != null && Number.isFinite(r.change_24h) && Math.abs(r.change_24h) >= rule.change24h) hit = `24h move ${fmtPct(r.change_24h)} (|>= ${rule.change24h}%)`;
    if (hit) fired.push({ id: rule.id, symbol: rule.symbol, alert: hit, price: r.price });
  }
  const result = { semantics: 'level-triggered snapshot; no background monitoring or delivery', tools: [...trace], checked_at: new Date().toISOString(), rules: rules.length, fired, unavailable, credits: totalCredits };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`checked ${rules.length} rule(s) at ${result.checked_at}`);
    if (unavailable.length) console.log(`${unavailable.length} rule(s) unavailable: required field missing`);
    if (!fired.length) console.log('no alerts triggered among evaluable rules');
    for (const f of fired) console.log(`ALERT [${f.id}] ${f.symbol}: ${f.alert}`);
  }
  return result;
}

(async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const withTrace = args.includes('--trace');
  const rest = args.filter(a => !['--json', '--trace'].includes(a));
  const [cmd, ...sub] = rest;
  if (!cmd || cmd === 'help') {
    console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
    process.exit(0);
  }
  try {
    if (cmd === 'price') {
      const syms = symbolList(sub.join(''));
      if (!syms.length) fail('usage: price <SYM[,SYM...]>');
      const rows = await cmdPrice(syms);
      asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printRow);
    } else if (cmd === 'top') {
      const rows = await cmdTop(positiveCount(sub[0]));
      asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printRow);
    } else if (cmd === 'gainers' || cmd === 'losers') {
      const rows = await cmdMovers(cmd, positiveCount(sub[0]));
      asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printRow);
    } else if (cmd === 'trending') {
      const rows = await cmdTrending(positiveCount(sub[0]));
      asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printRow);
    } else if (cmd === 'ohlcv') {
      if (!sub[0]) fail('usage: ohlcv <SYM>');
      const rows = await cmdOhlcv(sub[0].toUpperCase());
      if (asJson) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.symbol} O ${fmtUsd(r.open)}  H ${fmtUsd(r.high)}  L ${fmtUsd(r.low)}  C ${fmtUsd(r.close)}  vol ${fmtBig(r.volume)}  (${r.time_open})`);
    } else if (cmd === 'compare') {
      const syms = symbolList(sub.join(''));
      if (syms.length < 2) fail('usage: compare <SYM1,SYM2,...>');
      const rows = await cmdCompare(syms);
      if (asJson) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log('sym      rank  price         mcap       vol24h     1h       24h      7d       vol/mcap');
        for (const r of rows) console.log(`${r.symbol.padEnd(8)} #${String(r.rank ?? '-').padEnd(5)} ${fmtUsd(r.price).padStart(12)} ${fmtBig(r.market_cap).padStart(10)} ${fmtBig(r.volume_24h).padStart(10)} ${fmtPct(r.change_1h).padStart(8)} ${fmtPct(r.change_24h).padStart(8)} ${fmtPct(r.change_7d).padStart(8)} ${String(r.vol_mcap_ratio ?? 'n/a').padStart(9)}`);
      }
    } else if (cmd === 'global') {
      const g = await cmdGlobal();
      if (asJson) console.log(JSON.stringify(g, null, 2));
      else {
        console.log(`total market cap : ${fmtBig(g.total_market_cap)}`);
        console.log(`24h volume       : ${fmtBig(g.total_volume_24h)}`);
        console.log(`BTC dominance    : ${g.btc_dominance.toFixed(2)}%   ETH: ${g.eth_dominance.toFixed(2)}%`);
        console.log(`altcoin mcap     : ${fmtBig(g.altcoin_market_cap)}   DeFi 24h vol: ${fmtBig(g.defi_volume_24h)}`);
      }
    } else if (cmd === 'fng') {
      const f = await cmdFng();
      asJson ? console.log(JSON.stringify(f, null, 2)) : console.log(`Fear & Greed: ${f.value} (${f.classification}) | ${f.updated}`);
    } else if (cmd === 'map') {
      if (!sub[0]) fail('usage: map <SYM>');
      const m = await cmdMap(symbolList(sub[0])[0]);
      console.log(JSON.stringify(m, null, 2));
    } else if (cmd === 'verify') {
      if (!sub[0]) fail('usage: verify <SYM>');
      const v = await cmdVerify(sub[0].toUpperCase());
      if (asJson) console.log(JSON.stringify(v, null, 2));
      else {
        console.log(`${v.symbol} ${v.name} (rank #${v.rank ?? '-'})  trust ${v.trust_score}/100  ${v.verdict}`);
        for (const c of v.checks) console.log(`  ${c.name.padEnd(26)} ${c.points == null ? '  ' : String(c.points).padStart(2)}/${c.max ?? '  '}  ${c.detail}`);
        console.log('note: ' + v.note);
      }
    } else if (cmd === 'dex') {
      const [action, ...da] = sub.filter(a => a !== '--json');
      if (action === 'pairs') {
        const [dexSlug, networkSlug, n] = da;
        if (!dexSlug || !networkSlug) fail('usage: dex pairs <dex_slug> <network_slug> [N]');
        const rows = await cmdDexPairs(dexSlug, networkSlug, positiveCount(n));
        asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printDexRow);
      } else if (action === 'pair') {
        const [networkSlug, address] = da;
        if (!networkSlug || !address) fail('usage: dex pair <network_slug> <pool_contract_address>');
        const rows = await cmdDexPairQuote(networkSlug, address);
        asJson ? console.log(JSON.stringify(rows, null, 2)) : rows.forEach(printDexRow);
      } else fail('usage: dex pairs|pair');
    } else if (cmd === 'ask') {
      const out = await cmdAsk(sub.join(' '));
      if (!asJson) console.log('tool trace:');
      if (!asJson) for (const t of out.tools) console.log(`  ${t.endpoint} ${JSON.stringify(t.params)} (${t.credits} credits)`);
      out.credits = totalCredits;
      if (!asJson) console.log('answer:\n' + out.answer);
      if (asJson) console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'watch') {
      const [action, ...wa] = sub;
      if (action === 'add') {
        const sym = (wa[0] || '').toUpperCase();
        if (!sym) fail('usage: watch add <SYM> --above X | --below Y | --change24h PCT');
        const rule = { id: 'w' + require('crypto').randomUUID(), symbol: sym, created: new Date().toISOString() };
        const ai = wa.indexOf('--above'), bi = wa.indexOf('--below'), ci = wa.indexOf('--change24h');
        if (ai >= 0) rule.above = +wa[ai + 1];
        if (bi >= 0) rule.below = +wa[bi + 1];
        if (ci >= 0) rule.change24h = +wa[ci + 1];
        if (rule.above == null && rule.below == null && rule.change24h == null) fail('need --above, --below or --change24h');
        validateRule(rule);
        const w = loadWatch(); w.push(rule); saveWatch(w);
        console.log(asJson ? JSON.stringify(rule) : 'added: ' + JSON.stringify(rule));
      } else if (action === 'list') console.log(JSON.stringify(loadWatch(), null, 2));
      else if (action === 'rm') { if (!wa[0]) fail('usage: watch rm <id>'); const w = loadWatch(); if (!w.some(r => r.id === wa[0])) fail('watch rule not found'); saveWatch(w.filter(r => r.id !== wa[0])); console.log(asJson ? JSON.stringify({removed: wa[0]}) : 'removed ' + wa[0]); }
      else if (action === 'run') await watchRun(asJson);
      else fail('usage: watch add|list|rm|run');
    } else fail('unknown command: ' + cmd + ' (try: help)');
  } catch (e) { console.error(JSON.stringify({error: e.message, tools: trace})); process.exitCode = e.exitCode || 1; }
  finally { if (withTrace) console.error(JSON.stringify({tools: trace, total_credits: totalCredits})); }
})();
