# cmc-agent

Release candidate v4, 23 November 2026.

A zero-dependency Node.js CLI for CoinMarketCap market-data lookup, deterministic question routing, and local watch-rule evaluation. It does not use an LLM, place trades, forecast prices, or deliver alerts to other services. Proposed track: AI Agents and Automation.

## Run locally

Requires Node.js 18 or later. Extract the source archive and open its folder.

```sh
node cmc-agent.js help
node --test *.test.cjs
```

Set `CMC_API_KEY` securely in the environment. Alternatively, create a private `~/.cmc-hack/env` file containing `CMC_API_KEY=...`. Do not commit that file, put a key on the command line, or include it in a recording. `CMC_CONFIG_DIR` selects another config and watch-state folder. The default is `~/.cmc-hack`.

API access and quotas depend on your current CMC plan. Trending and OHLCV may require event/paid access. Unsupported endpoints fail visibly; there is no claim that every command works on Basic. Obtain a key from https://coinmarketcap.com/api and consult https://coinmarketcap.com/api/documentation/v1.

## Commands and exact endpoints

| Command | Endpoint | Meaning |
| --- | --- | --- |
| `price BTC,ETH` | `/v2/cryptocurrency/quotes/latest` | USD snapshot; selects the lowest-ranked-number priced symbol match and exposes its CMC ID, match count and timestamp in JSON |
| `top 5` | `/v1/cryptocurrency/listings/latest` | CMC listings, market-cap order |
| `gainers 5`, `losers 5` | `/v1/cryptocurrency/listings/latest` | CMC listings sorted server-side by 24h percentage change, descending or ascending; not a trading-quality screen |
| `trending 5` | `/v1/cryptocurrency/trending/latest` | Native trending list, if entitled |
| `ohlcv BTC` | `/v2/cryptocurrency/ohlcv/latest` | Latest returned bar; symbol collision selected by highest returned volume, CMC ID exposed |
| `compare BTC,ETH` | `/v2/cryptocurrency/quotes/latest` | Snapshot comparison and volume/market-cap ratio, not a recommendation |
| `global` | `/v1/global-metrics/quotes/latest` | CMC aggregate metrics |
| `fng` | `/v3/fear-and-greed/latest` | CMC sentiment index, not a prediction |
| `map BTC` | `/v1/cryptocurrency/map` | Up to five returned symbol matches for inspection |
| `dex pairs uniswap-v3 ethereum 5` | `/v4/dex/spot-pairs/latest` | First returned DEX pairs, capped client-side; no independent ranking claim |
| `dex pair ethereum POOL_ADDRESS` | `/v4/dex/pairs/quotes/latest` | Reported pool snapshot, not an executable quote or exit guarantee |
| `verify BTC` | `/v2/cryptocurrency/quotes/latest` + `/v1/cryptocurrency/map` + `/v2/cryptocurrency/ohlcv/latest` | Trust score 0-100 (TRUSTED / CAUTION / UNRELIABLE) for the symbol's market data: symbol-collision count, quote freshness, quotes-vs-OHLCV consistency, volume/mcap sanity, 1h-move plausibility, stablecoin peg deviation (tracked stables). Measures data trustworthiness, not investment quality |
| `ask "price of bitcoin"` | Deterministic routing to the above | Supported lookup patterns only |
| `watch add BTC --above 100000` | Local write only | Add exactly one positive threshold |
| `watch add ETH --change24h 5` | Local write only | Absolute 24h percentage movement |
| `watch list`, `watch rm ID` | Local state only | Inspect or remove a rule |
| `watch run` | `/v2/cryptocurrency/quotes/latest` | One snapshot evaluation, no daemon or external delivery |

List counts must be integers from 1 to 100. Multiple input symbols are deduplicated and normalized to uppercase. Symbol resolution is a heuristic, not proof of intended identity. Check returned IDs and `map` before relying on a collision-prone ticker. OHLCV and quote selection use different heuristics.


## Trust verification (`verify`)

`verify` answers the question every other command raises: can you trust this number?
It cross-checks one symbol across three independent CMC endpoints and scores the
result 0-100 with an explainable breakdown:

- **resolution_clarity (20)** - how many active assets share the symbol, and how strong the resolved one is
- **freshness (20)** - age of the quote timestamp
- **cross_endpoint_consistency (20)** - quotes price vs OHLCV close for the same CMC ID
- **volume_mcap_sanity (15)** - volume/market-cap ratio inside plausible bounds
- **move_plausibility (10)** - |1h change| inside plausible bounds (bad-tick detection)
- **stablecoin_peg (15)** - for tracked stables (USDT, USDC, DAI, FDUSD, USDE, TUSD, PYUSD, USDD): deviation from $1; a deviation over 2% caps the verdict at CAUTION, over 5% at UNRELIABLE. Non-stables get an identity cross-check (quote ID vs top-ranked map entry) instead

Verdicts: score >= 75 TRUSTED, 45-74 CAUTION, < 45 UNRELIABLE. The score measures
data trustworthiness for automation and trading decisions; it is not financial
advice. Live example: `verify BTC` -> 96/100 TRUSTED (9 active matches resolved
to rank #1), `verify USDT` -> 90/100 TRUSTED (peg deviation 0.13%).

## Machine output and trace

`--json` emits one JSON document on stdout, with no narration. `--trace` writes request metadata to stderr, keeping stdout parseable. For example:

```sh
node cmc-agent.js price BTC,ETH --json --trace
node cmc-agent.js ask "top 5 trending" --json
```

Trace records endpoint, query parameters, request time, response time when supplied, HTTP/API status, reported credits, and success/error. It never contains the key or authentication header. A failure exits nonzero and emits a structured error plus trace on stderr. There are no automatic retries, so a failure does not silently consume more requests. Requests time out after 15 seconds and redirects are refused.

`ask` supports price, top-N, movers, trending, global-market and fear/greed patterns. It is a small pattern router, not a general language model. Unsupported questions and advice/forecast requests fail. Ask JSON carries its tool trace. Other commands use `--trace` for evidence.

## Calling cmc-agent from another program

Every command is scriptable: one JSON document on stdout, structured errors and
the tool trace on stderr, exit code 0 on success and nonzero on any failure. A
caller only needs to spawn the process and parse stdout.

```js
// Node.js: gate a trade signal on verified data
import { execFileSync } from "node:child_process";

function run(...args) {
  const out = execFileSync("node", ["cmc-agent.js", ...args, "--json"], { encoding: "utf8" });
  return JSON.parse(out); // throws (nonzero exit) on any failure - fail closed
}

const v = run("verify", "BTC");
if (v.trust_score < 75) throw new Error(`untrusted data: ${v.trust_score} (${v.verdict})`);
const p = run("price", "BTC");
console.log(`BTC $${p.assets[0].usd} verified at trust ${v.trust_score}`);
```

```python
# Python: the same pattern
import json, subprocess

def run(*args):
    out = subprocess.run(
        ["node", "cmc-agent.js", *args, "--json"],
        check=True, capture_output=True, text=True,  # check=True: nonzero exit raises
    )
    return json.loads(out.stdout)

v = run("verify", "USDT")
assert v["trust_score"] >= 75, f"untrusted data: {v['trust_score']} ({v['verdict']})"
```

There is no SDK and no hidden state between calls: the JSON shape you parse is
the same one the tests assert on.

## Scheduled watches (cron)

`watch run` is designed for an external scheduler; cmc-agent itself starts no
background process. Example: check watch rules every 5 minutes and log alerts.

```cron
*/5 * * * * cd /opt/cmc-agent && node cmc-agent.js watch run --json >> /var/log/cmc-watch.jsonl 2>>/var/log/cmc-watch.err
```

The key comes from the `CMC_API_KEY` environment variable or `~/.cmc-hack/env`
of the user cron runs as; it is never read from a command-line flag, so it does
not appear in the process list.

Rules are level-triggered, so a threshold that stays crossed alerts on every
run; deduplicate downstream if you only want crossings. Each line appended is
one JSON document, so the log stays machine-readable.

## Safety and state

- Price/compare/watch require every requested asset to have a positive finite USD price and a timestamp no older than 15 minutes or more than 5 minutes ahead. Missing, stale and partial results fail closed. Other datasets expose their own observation timestamps where available; a fresh API response does not prove every underlying field is fresh.
- Missing 24h-change fields do not become zero. Affected watch rules are listed in `unavailable`.
- Watch rules are level-triggered. Repeated runs can emit the same alert while a threshold remains crossed. No deduplication, crossing-only logic, background scheduling or webhook is claimed.
- Corrupt state is rejected, not replaced with an empty list. Writes use a private temporary file plus atomic rename. Concurrent watch writers are not supported; use one writer at a time.
- Market data can be delayed or incorrect. DEX liquidity is reported liquidity, not a sell quote. No financial advice.

## Demo and tests

`bash demo.sh` runs live lookups and an isolated temporary watchlist, then removes the temporary state. It prints no secret. It requires a valid key and consumes API credits. `mock.cjs` is only a test preload; fixtures are synthetic and are never a fallback for a failed live call. Never present fixture output as live API evidence.

Run `node --test *.test.cjs`. Set `CMC_EVIDENCE_DIR` to a private folder to save raw successful JSON responses with their endpoint and parameters, never authentication headers. Do not include personal account endpoints in evidence. Offline regression fixtures are separate from fresh live validation. The v4 demo and 16-command live sweep passed on 23 November 2026.

## What the API enabled and where it got in the way

CMC supplies centralized quotes, global metrics, sentiment, OHLCV and DEX snapshots through one authenticated host. The trace makes these lookups inspectable by another program. The prior build observed string-form success code `"0"`, multiple assets per symbol, and DEX list limits that needed client-side enforcement. Entitlements can change after the event. The CLI handles numeric/string success codes, discloses symbol selection, caps returned DEX lists, and reports plan errors without inventing data.
