#!/usr/bin/env bash
# AgentForge Bittensor submission step (placeholder): register the configured hotkey on the new subnet.
# Runs only when config/bittensor.json has enabled=true, autoSubmit=true, dryRun=false and the wallet keys are set.
# Registration burns TAO from the coldkey: check the subnet's registration cost before arming auto-submit.
# Environment (set by server/services/bittensor.js):
#   BT_NETWORK BT_ENDPOINT BT_NETUID BT_COMPETITION_ID BT_COMPETITION_NAME BT_AGENT_NAME
#   BT_WALLET_NAME BT_WALLET_HOTKEY BT_WALLET_PATH BT_COLDKEY_PATH BT_COLDKEY_MNEMONIC BT_COLDKEY_PASSWORD
# Exit 0 = submitted, anything else = failed (the output is stored with the competition, secrets redacted).
set -euo pipefail

: "${BT_NETUID:?no netuid for this competition}"
: "${BT_WALLET_NAME:?wallet name missing}"
: "${BT_WALLET_HOTKEY:?wallet hotkey missing}"

if ! command -v btcli >/dev/null 2>&1; then
  echo "btcli not found (pip install bittensor-cli)" >&2
  exit 127
fi

args=(subnets register --netuid "$BT_NETUID" --wallet-name "$BT_WALLET_NAME" --wallet-hotkey "$BT_WALLET_HOTKEY" --network "${BT_ENDPOINT:-$BT_NETWORK}" --no-prompt)
[ -n "${BT_WALLET_PATH:-}" ] && args+=(--wallet-path "$BT_WALLET_PATH")

echo "registering hotkey $BT_WALLET_HOTKEY on subnet $BT_NETUID ($BT_NETWORK)"
if [ -n "${BT_COLDKEY_PASSWORD:-}" ]; then
  printf '%s\n' "$BT_COLDKEY_PASSWORD" | btcli "${args[@]}"
else
  btcli "${args[@]}"
fi

# Serving the miner is subnet specific: start it here (e.g. pm2 start the subnet's miner with the same wallet), or let
# the Mino agent created for this competition do it from its task.
echo "registered; serve the subnet miner next"
