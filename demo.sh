#!/usr/bin/env bash
# Live demonstration only. Synthetic fixtures are never used here.
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ -z "${CMC_API_KEY:-}" ]]; then
  printf '%s\n' 'Set CMC_API_KEY securely in the environment before this demo.' >&2
  exit 1
fi
export CMC_CONFIG_DIR
CMC_CONFIG_DIR=$(mktemp -d)
trap 'rm -rf -- "$CMC_CONFIG_DIR"' EXIT
run() { printf '\n$ node cmc-agent.js'; printf ' %q' "$@"; printf '\n'; node cmc-agent.js "$@"; }
printf '%s\n' 'LIVE CMC lookup demo. Each call consumes plan credits. No trading or delivery.'
run ask 'price of bitcoin' --json
run losers 3 --json --trace
run dex pairs uniswap-v3 ethereum 3 --json --trace
run watch add BTC --change24h 5 --json
run watch run --json --trace
run price BTC,ETH,SOL --json --trace
printf '\n%s\n' 'Temporary watch state removed on exit. No external alert was sent.'
