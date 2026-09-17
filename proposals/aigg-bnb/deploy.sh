#!/usr/bin/env bash
# Deploy the mesh with BNB parameters. Usage: NETWORK=opbnb-testnet PK=0x... ./deploy.sh [extra forge args]
#   NETWORK: opbnb-testnet (5611) | bsc-testnet (97) | opbnb (204) | bsc (56) | anvil (31337)
set -euo pipefail
cd "$(dirname "$0")/contracts"
case "${NETWORK:-anvil}" in
  opbnb-testnet) RPC="${RPC:-https://opbnb-testnet-rpc.bnbchain.org}"; CHAIN=5611 ;;
  bsc-testnet)   RPC="${RPC:-https://data-seed-prebsc-1-s1.bnbchain.org:8545}"; CHAIN=97 ;;
  opbnb)         RPC="${RPC:-https://opbnb-mainnet-rpc.bnbchain.org}"; CHAIN=204 ;;
  bsc)           RPC="${RPC:-https://bsc-dataseed.bnbchain.org}"; CHAIN=56 ;;
  anvil)         RPC="${RPC:-http://127.0.0.1:8545}"; CHAIN=31337; PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" ;;
  *) echo "unknown NETWORK"; exit 2 ;;
esac
: "${PK:?set PK (deployer private key)}"
# block-time-dependent parameters: DESIGN.md §4 assumes ~1 s blocks; override EPOCH_BLOCKS etc. via env for BSC (0.75 s) or others
forge script script/DeployBNB.s.sol --rpc-url "$RPC" --chain-id "$CHAIN" --private-key "$PK" --broadcast "$@"
