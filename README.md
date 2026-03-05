# xflows

A command-line interface for the [Wanchain XFlows](https://docs.wanchain.org/developers/xflows-api) cross-chain bridge protocol. Designed for both human operators and AI agents, every operation can be executed as a single one-liner command.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Architecture Overview](#architecture-overview)
  - [Cross-Chain Transaction Flow](#cross-chain-transaction-flow)
  - [Work Modes](#work-modes)
  - [Wallet Encryption](#wallet-encryption)
  - [Wanchain Gas Price Enforcement](#wanchain-gas-price-enforcement)
  - [RPC Endpoints](#rpc-endpoints)
- [Commands](#commands)
  - [Wallet Management](#wallet-management)
  - [Query Commands](#query-commands)
  - [Quote](#quote)
  - [Send Transaction](#send-transaction)
  - [Transfer (Native Token)](#transfer-native-token)
  - [Transfer Token (ERC20)](#transfer-token-erc20)
  - [Transaction Status](#transaction-status)
  - [RPC List](#rpc-list)
- [Complete Workflow Example](#complete-workflow-example)
- [AI Agent Integration](#ai-agent-integration)
- [Testing](#testing)
- [Project Structure](#project-structure)

## Installation

### From npm (recommended)

```bash
# Install globally via npm
npm install -g xflows

# Or via yarn
yarn global add xflows

# Or via pnpm
pnpm add -g xflows

# Then use it anywhere
xflows --help
```

**Requirements:** Node.js >= 18

### One-time use with npx

```bash
# Run without installing
npx xflows --help
npx xflows chains
npx xflows wallet create --name alice
```

### From source

```bash
git clone https://github.com/wandevs/xflows-cli.git
cd xflows-cli
bun install
bun src/index.ts --help
```

**Requirements:** [Bun](https://bun.sh) v1.0+

## Quick Start

```bash
# 1. Create a wallet
xflows wallet create --name alice

# 2. Check what chains and tokens are available
xflows chains
xflows tokens --chain-id 1

# 3. Get a cross-chain quote
xflows quote \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xYourAddress --to-address 0xYourAddress \
  --amount 0.1

# 4. Execute the cross-chain transfer
xflows send \
  --wallet alice \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xDestAddress \
  --amount 0.1

# 5. Track the transaction
xflows status \
  --hash 0xYourTxHash \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xYourAddress --to-address 0xDestAddress \
  --amount 0.1
```

## How It Works

### Architecture Overview

```
+------------------+       +---------------------+       +----------------+
|   xflows CLI     | ----> | XFlows API (v3)     | ----> | Wanchain       |
|                  |       | xflows.wanchain.org |       | Storeman Nodes |
|  - Wallet Mgmt   |       |                     |       |                |
|  - Quote         |       |  - /supported/*     |       | Cross-chain    |
|  - Build Tx      |       |  - /quote           |       | settlement     |
|  - Sign & Send   |       |  - /buildTx         |       |                |
|  - Track Status  |       |  - /status          |       +----------------+
+------------------+       +---------------------+
        |
        v
+------------------+
| EVM RPC Nodes    |
| (publicnode.com) |
|                  |
| Sign & broadcast |
| transactions     |
+------------------+
```

The CLI acts as a local orchestrator that:

1. **Manages wallets** locally on disk (`~/.xflows/wallets/`)
2. **Queries the XFlows API** for supported assets, quotes, and transaction data
3. **Signs transactions** locally using ethers.js (private keys never leave your machine)
4. **Broadcasts** signed transactions to EVM chains via public RPC endpoints
5. **Tracks** cross-chain transaction status through the XFlows API

### Cross-Chain Transaction Flow

When you run `xflows send`, the following steps happen in sequence:

```
Step 1: Quote                Step 2: Build Tx            Step 3: Approve (if ERC-20)
  POST /quote         --->     POST /buildTx      --->     Check allowance
  Get estimated output         Get raw tx data              If needed, send approve() tx
  Check fees                   Get approval addr            Wait for confirmation

Step 4: Sign & Send          Step 5: Track
  Apply gas settings  --->     POST /status
  Sign with local key          Poll until terminal
  Broadcast to RPC             statusCode
  Wait for receipt
```

**Detailed breakdown:**

1. **Quote phase** -- The CLI sends your swap parameters to `POST /quote`. The API evaluates available routes (direct bridge, swap-then-bridge, bridge-then-swap, etc.) and returns the best route with estimated output amount, fees, slippage, and the `workMode` (1-6) that describes which type of cross-chain operation will be performed.

2. **Build phase** -- The same parameters are sent to `POST /buildTx`. The API returns a ready-to-sign transaction object containing `to` (the bridge/router contract address), `data` (ABI-encoded function call), and `value` (native token amount in wei). For non-EVM chains, the API returns chain-specific formats (e.g., `serializedTx` for Solana/Cardano/Sui).

3. **Approval phase** -- If the source token is an ERC-20 (not the native token), the CLI checks whether the bridge contract already has sufficient token allowance. If not, it sends an `approve()` transaction granting unlimited allowance to the bridge contract, then waits for confirmation before proceeding.

4. **Sign & send phase** -- The CLI constructs the final transaction request, applies any gas overrides (custom gas limit, Wanchain minimum gas price), signs it with the local private key, and broadcasts it to the source chain's RPC endpoint. It then waits for the transaction receipt.

5. **Tracking phase** -- After the source chain transaction is confirmed, the cross-chain settlement is handled by Wanchain's Storeman nodes. You can query the status at any time using `xflows status`, which calls `POST /status` and returns the current state of the cross-chain transfer.

### Work Modes

The XFlows API determines the optimal route for each swap and indicates it via the `workMode` field:

| Mode | Name | Description |
|------|------|-------------|
| 1 | Direct Bridge (WanBridge) | Tokens are bridged directly from source to destination chain via WanBridge lock/mint mechanism |
| 2 | Direct Bridge (QUiX) | Same as mode 1 but uses the QUiX rapid bridge for faster settlement |
| 3 | Bridge + Swap | Tokens are first bridged to the destination chain, then swapped to the target token on a DEX |
| 4 | Bridge + Swap + Bridge | Tokens are bridged to Wanchain L1, swapped on Wanchain DEX, then bridged to the destination chain |
| 5 | Single-chain Swap | No cross-chain transfer; tokens are swapped on the same chain via a DEX aggregator |
| 6 | Swap + Bridge | Tokens are first swapped on the source chain DEX, then the resulting tokens are bridged to the destination chain |

The CLI does not choose the mode -- the XFlows API selects the best route automatically based on available liquidity, fees, and token pair availability.

### Wallet Encryption

Wallets are stored as JSON files in `~/.xflows/wallets/`. Two storage modes are supported:

**Unencrypted (default):**
```json
{
  "name": "alice",
  "address": "0x...",
  "encrypted": false,
  "privateKey": "0xabc123...",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

**Encrypted (with `--encrypt`):**
```json
{
  "name": "alice",
  "address": "0x...",
  "encrypted": true,
  "privateKey": "{\"salt\":\"...\",\"iv\":\"...\",\"data\":\"...\"}",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

The encryption scheme uses:
- **Key derivation:** scrypt (password + 16-byte random salt -> 32-byte key)
- **Cipher:** AES-256-CBC with 16-byte random IV
- **Storage:** salt, IV, and ciphertext are stored as hex strings in a JSON object

Each encryption produces different ciphertext due to random salt and IV generation. The password is never stored. When an encrypted wallet is needed for signing (`xflows send`), the `--password` flag must be provided to decrypt the private key in memory.

### Wanchain Gas Price Enforcement

Wanchain mainnet (chainId 888) has a protocol-level requirement that the base fee must be at least 1 gwei (1,000,000,000 wei), regardless of what the RPC node reports as the current gas price. The CLI enforces this automatically:

```
if (chainId == 888) {
  gasPrice = max(reported_gasPrice, 1 gwei)
}
```

This prevents transactions from failing due to an underpriced gas fee on the Wanchain network.

### RPC Endpoints

The CLI comes pre-configured with public RPC endpoints for 22 chains. Most endpoints are sourced from [publicnode.com](https://publicnode.com), which provides free, rate-limited public RPC access. Wanchain uses its own official endpoints.

| Chain | Chain ID | RPC |
|-------|----------|-----|
| Ethereum | 1 | ethereum-rpc.publicnode.com |
| BSC | 56 | bsc-rpc.publicnode.com |
| Polygon | 137 | polygon-bor-rpc.publicnode.com |
| Avalanche | 43114 | avalanche-c-chain-rpc.publicnode.com |
| Arbitrum | 42161 | arbitrum-one-rpc.publicnode.com |
| Optimism | 10 | optimism-rpc.publicnode.com |
| Fantom | 250 | fantom-rpc.publicnode.com |
| Base | 8453 | base-rpc.publicnode.com |
| Linea | 59144 | linea-rpc.publicnode.com |
| zkSync Era | 324 | zksync-era-rpc.publicnode.com |
| Polygon zkEVM | 1101 | polygon-zkevm-rpc.publicnode.com |
| Gnosis | 100 | gnosis-rpc.publicnode.com |
| Scroll | 534352 | scroll-rpc.publicnode.com |
| Mantle | 5000 | mantle-rpc.publicnode.com |
| Manta Pacific | 169 | manta-pacific-rpc.publicnode.com |
| Blast | 81457 | blast-rpc.publicnode.com |
| Boba | 2888 | boba-ethereum-rpc.publicnode.com |
| Metis | 1088 | metis-rpc.publicnode.com |
| Celo | 42220 | celo-rpc.publicnode.com |
| Kava | 2222 | kava-evm-rpc.publicnode.com |
| Wanchain | 888 | gwan-ssl.wandevs.org:56891 |
| Wanchain Testnet | 999 | gwan-ssl.wandevs.org:46891 |

You can override any RPC endpoint at runtime using the `--rpc` flag on `send` and `wallet balance` commands.

Run `xflows rpc` to see the full list at any time.

## Commands

### Wallet Management

#### `wallet create` -- Create a new wallet

```bash
# Generate a new random wallet
xflows wallet create --name alice

# Generate with encryption
xflows wallet create --name alice --encrypt --password mypassword

# Import an existing private key
xflows wallet create --name alice --private-key 0xabc123...

# Import and encrypt
xflows wallet create --name alice --private-key 0xabc123... --encrypt --password mypassword
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name <name>` | Yes | Wallet name (used as the filename) |
| `--encrypt` | No | Encrypt the private key with a password |
| `--password <pw>` | No | Encryption password (prompted interactively if omitted with `--encrypt`) |
| `--private-key <key>` | No | Import an existing private key instead of generating a new one |

#### `wallet list` -- List all saved wallets

```bash
xflows wallet list
```

Displays all wallets in `~/.xflows/wallets/` with their address, encryption status, and creation date.

#### `wallet show` -- Show wallet details

```bash
# Unencrypted wallet
xflows wallet show --name alice

# Encrypted wallet (requires password)
xflows wallet show --name alice --password mypassword
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name <name>` | Yes | Wallet name |
| `--password <pw>` | No | Password for encrypted wallets |

#### `wallet balance` -- Check native token balance

```bash
# Check ETH balance on Ethereum
xflows wallet balance --name alice --chain-id 1

# Check BNB balance on BSC
xflows wallet balance --name alice --chain-id 56

# Check WAN balance on Wanchain
xflows wallet balance --name alice --chain-id 888

# Encrypted wallet
xflows wallet balance --name alice --chain-id 1 --password mypassword

# Custom RPC
xflows wallet balance --name alice --chain-id 1 --rpc https://my-rpc.example.com
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name <name>` | Yes | Wallet name |
| `--chain-id <id>` | Yes | Chain ID to query balance on |
| `--password <pw>` | No | Password for encrypted wallets |
| `--rpc <url>` | No | Override default RPC endpoint |

#### `wallet delete` -- Delete a wallet

```bash
# Interactive confirmation
xflows wallet delete --name alice

# Skip confirmation
xflows wallet delete --name alice --force
```

### Query Commands

All query commands output raw JSON from the XFlows API, making them easy to pipe into `jq` or consume programmatically.

#### `chains` -- List supported chains

```bash
xflows chains                    # All chains
xflows chains --chain-id 1       # Filter by chain ID
xflows chains --quix             # QUiX-supported chains only
```

#### `tokens` -- List supported tokens

```bash
xflows tokens                    # All tokens across all chains
xflows tokens --chain-id 1       # Tokens on Ethereum only
xflows tokens --chain-id 56 --quix  # QUiX tokens on BSC
```

#### `pairs` -- List bridgeable token pairs

```bash
xflows pairs --from-chain 1                # All pairs from Ethereum
xflows pairs --from-chain 1 --to-chain 56  # Ethereum -> BSC pairs only
```

#### `bridges` -- List available bridges

```bash
xflows bridges
# Returns: wanbridge, quix
```

#### `dexes` -- List available DEX aggregators

```bash
xflows dexes
# Returns: wanchain, rubic
```

### Quote

Get an estimated output for a cross-chain swap without executing it.

```bash
xflows quote \
  --from-chain 1 \
  --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xYourAddress \
  --to-address 0xYourAddress \
  --amount 1.0

# With options
xflows quote \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xYourAddress --to-address 0xYourAddress \
  --amount 1.0 \
  --bridge quix \
  --slippage 0.005 \
  --dex rubic
```

| Flag | Required | Description |
|------|----------|-------------|
| `--from-chain <id>` | Yes | Source chain ID |
| `--to-chain <id>` | Yes | Destination chain ID |
| `--from-token <addr>` | Yes | Source token address (`0x0...0` for native token) |
| `--to-token <addr>` | Yes | Destination token address (`0x0...0` for native token) |
| `--from-address <addr>` | Yes | Sender wallet address |
| `--to-address <addr>` | Yes | Recipient wallet address |
| `--amount <amount>` | Yes | Human-readable amount (e.g., `1.5`, `0.001`) |
| `--bridge <name>` | No | `wanbridge` or `quix` (default: best route) |
| `--dex <name>` | No | `wanchain` or `rubic` |
| `--slippage <value>` | No | Max slippage tolerance (e.g., `0.01` = 1%) |
| `--id <id>` | No | Request identifier for tracking |

**Response fields:**

| Field | Description |
|-------|-------------|
| `amountOut` | Estimated output amount (human-readable) |
| `amountOutMin` | Minimum output after slippage |
| `workMode` | Route type (1-6, see [Work Modes](#work-modes)) |
| `nativeFees[]` | Gas/network fees in the source chain's native token |
| `tokenFees[]` | Fees deducted from the swap token |
| `approvalAddress` | Contract that needs ERC-20 approval (if applicable) |
| `priceImpact` | Estimated price impact |

### Send Transaction

Build, sign, and broadcast a cross-chain transaction.

```bash
# Basic native token transfer
xflows send \
  --wallet alice \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xRecipient \
  --amount 0.1

# With encrypted wallet
xflows send \
  --wallet alice --password mypassword \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xRecipient \
  --amount 0.1

# Dry run (preview the transaction without sending)
xflows send \
  --wallet alice \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xRecipient \
  --amount 0.1 \
  --dry-run

# With all options
xflows send \
  --wallet alice --password mypassword \
  --from-chain 1 --to-chain 56 \
  --from-token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xRecipient \
  --amount 100 \
  --bridge wanbridge \
  --slippage 0.01 \
  --gas-limit 300000 \
  --rpc https://my-private-rpc.example.com
```

| Flag | Required | Description |
|------|----------|-------------|
| `--wallet <name>` | Yes | Wallet name to use for signing |
| `--from-chain <id>` | Yes | Source chain ID |
| `--to-chain <id>` | Yes | Destination chain ID |
| `--from-token <addr>` | Yes | Source token address |
| `--to-token <addr>` | Yes | Destination token address |
| `--to-address <addr>` | Yes | Recipient wallet address |
| `--amount <amount>` | Yes | Amount to swap |
| `--password <pw>` | No | Password for encrypted wallet |
| `--bridge <name>` | No | Force a specific bridge |
| `--dex <name>` | No | Force a specific DEX |
| `--slippage <value>` | No | Max slippage tolerance |
| `--rpc <url>` | No | Override source chain RPC |
| `--gas-limit <limit>` | No | Custom gas limit |
| `--dry-run` | No | Build but do not send the transaction |

**What happens during `send`:**

1. Loads the wallet from disk (decrypts if needed)
2. Fetches a quote from the XFlows API and displays estimated output + fees
3. Calls `/buildTx` to get the raw transaction data
4. If the source token is ERC-20 and needs approval, sends an `approve()` transaction first
5. Constructs the final transaction (with Wanchain gas price enforcement if applicable)
6. Signs with the local private key and broadcasts to the source chain RPC
7. Waits for on-chain confirmation
8. Prints the transaction hash and a ready-to-use `xflows status` command for tracking

### Transfer (Native Token)

Send native tokens (ETH, BNB, WAN, etc.) on the same chain. This is a simple transfer, not a cross-chain bridge operation.

```bash
# Send 0.1 ETH on Ethereum
xflows transfer --wallet alice --chain-id 1 --to 0xRecipient --amount 0.1

# Send 1.5 BNB on BSC with encrypted wallet
xflows transfer --wallet alice --password mysecret --chain-id 56 --to 0xRecipient --amount 1.5

# Dry run (preview without sending)
xflows transfer --wallet alice --chain-id 1 --to 0xRecipient --amount 0.1 --dry-run
```

| Flag | Required | Description |
|------|----------|-------------|
| `--wallet <name>` | Yes | Wallet name to use for signing |
| `--chain-id <id>` | Yes | Chain ID to send on |
| `--to <address>` | Yes | Recipient address |
| `--amount <amount>` | Yes | Amount to send (human-readable, e.g., `0.1`) |
| `--password <pw>` | No | Password for encrypted wallet |
| `--rpc <url>` | No | Override default RPC endpoint |
| `--gas-limit <limit>` | No | Custom gas limit |
| `--dry-run` | No | Build but do not send the transaction |

### Transfer Token (ERC20)

Send ERC20 tokens on the same chain. Token decimals are auto-detected from the contract, or can be specified manually.

```bash
# Send 100 USDC on Ethereum (auto-detect decimals)
xflows transfer-token --wallet alice --chain-id 1 \
  --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to 0xRecipient --amount 100

# Send with explicit decimals
xflows transfer-token --wallet alice --chain-id 1 \
  --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to 0xRecipient --amount 100 --decimals 6

# Send 50 USDT on BSC with encrypted wallet
xflows transfer-token --wallet alice --password mysecret --chain-id 56 \
  --token 0x55d398326f99059fF775485246999027B3197955 \
  --to 0xRecipient --amount 50

# Dry run (preview without sending)
xflows transfer-token --wallet alice --chain-id 1 \
  --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to 0xRecipient --amount 100 --dry-run
```

| Flag | Required | Description |
|------|----------|-------------|
| `--wallet <name>` | Yes | Wallet name to use for signing |
| `--chain-id <id>` | Yes | Chain ID to send on |
| `--token <address>` | Yes | ERC20 token contract address |
| `--to <address>` | Yes | Recipient address |
| `--amount <amount>` | Yes | Amount to send (human-readable, e.g., `100`) |
| `--decimals <n>` | No | Token decimals (auto-detected if omitted) |
| `--password <pw>` | No | Password for encrypted wallet |
| `--rpc <url>` | No | Override default RPC endpoint |
| `--gas-limit <limit>` | No | Custom gas limit |
| `--dry-run` | No | Build but do not send the transaction |

**Features:**
- Auto-detects token decimals and symbol from the contract
- Checks token balance before sending to provide a clear error message
- Supports Wanchain gas price enforcement

### Transaction Status

Check the current state of a cross-chain transaction.

```bash
# One-time status check
xflows status \
  --hash 0xYourTxHash \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xSender --to-address 0xReceiver \
  --amount 0.1

# Poll until completion (checks every 15 seconds)
xflows status \
  --hash 0xYourTxHash \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xSender --to-address 0xReceiver \
  --amount 0.1 \
  --poll --interval 10
```

| Flag | Required | Description |
|------|----------|-------------|
| `--hash <hash>` | Yes | Source chain transaction hash |
| `--from-chain <id>` | Yes | Source chain ID |
| `--to-chain <id>` | Yes | Destination chain ID |
| `--from-token <addr>` | Yes | Source token address |
| `--to-token <addr>` | Yes | Destination token address |
| `--from-address <addr>` | Yes | Sender address |
| `--to-address <addr>` | Yes | Receiver address |
| `--amount <amount>` | Yes | Amount that was swapped |
| `--bridge <name>` | No | Bridge that was used |
| `--poll` | No | Keep polling until a terminal status is reached |
| `--interval <seconds>` | No | Polling interval in seconds (default: 15) |

**Status codes:**

| Code | Meaning | Terminal? |
|------|---------|-----------|
| 1 | Success -- tokens delivered to destination | Yes |
| 2 | Failed -- transaction failed | Yes |
| 3 | Processing -- cross-chain settlement in progress | No |
| 4 | Refunded -- tokens returned to sender | Yes |
| 5 | Refunded (alternate) | Yes |
| 6 | Trusteeship -- requires manual intervention | Yes |
| 7 | Risk transaction -- flagged by AML checks | Yes |

### RPC List

```bash
xflows rpc
```

Displays all pre-configured RPC endpoints and their associated chain IDs.

## Complete Workflow Example

A full end-to-end example bridging USDC from Ethereum to BSC:

```bash
# Step 1: Create an encrypted wallet
xflows wallet create --name bridge-wallet --encrypt --password s3cret

# Step 2: Fund the wallet with ETH (for gas) and USDC on Ethereum
# (done externally via exchange or another wallet)

# Step 3: Check balance
xflows wallet balance --name bridge-wallet --chain-id 1 --password s3cret

# Step 4: Find the USDC token addresses
xflows tokens --chain-id 1 | jq '.data[] | select(.tokenSymbol == "USDC")'
xflows tokens --chain-id 56 | jq '.data[] | select(.tokenSymbol == "USDC")'

# Step 5: Check available pairs
xflows pairs --from-chain 1 --to-chain 56

# Step 6: Get a quote
xflows quote \
  --from-chain 1 --to-chain 56 \
  --from-token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to-token 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d \
  --from-address 0xYourAddress --to-address 0xYourAddress \
  --amount 100 \
  --slippage 0.005

# Step 7: Execute (the CLI handles ERC-20 approval automatically)
xflows send \
  --wallet bridge-wallet --password s3cret \
  --from-chain 1 --to-chain 56 \
  --from-token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to-token 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d \
  --to-address 0xYourAddress \
  --amount 100 \
  --slippage 0.005

# Step 8: Track (the send command prints this command for you)
xflows status \
  --hash 0xYourTxHash \
  --from-chain 1 --to-chain 56 \
  --from-token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --to-token 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d \
  --from-address 0xYourAddress --to-address 0xYourAddress \
  --amount 100 \
  --poll
```

## AI Agent Integration

The CLI is designed for non-interactive, single-command execution so that AI agents can use it directly:

- Every command accepts all parameters via flags (no interactive prompts needed when flags are provided)
- All query commands output raw JSON to stdout for easy parsing
- The `send` command prints a ready-to-use `xflows status` command after execution
- Wallet encryption is optional -- unencrypted wallets avoid the need for password management
- The `--dry-run` flag allows previewing transactions without executing them

**Example agent workflow:**

```bash
# Agent creates wallet (no interaction needed)
xflows wallet create --name agent-wallet

# Agent queries available routes
PAIRS=$(xflows pairs --from-chain 1 --to-chain 56)

# Agent gets a quote and parses the output
QUOTE=$(xflows quote --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --from-address 0xAgentAddr --to-address 0xAgentAddr \
  --amount 0.01)

# Agent executes the transaction
xflows send --wallet agent-wallet \
  --from-chain 1 --to-chain 56 \
  --from-token 0x0000000000000000000000000000000000000000 \
  --to-token 0x0000000000000000000000000000000000000000 \
  --to-address 0xAgentAddr \
  --amount 0.01
```

## Testing

```bash
# Run all tests
bun test

# Run tests with verbose output
bun test --verbose
```

The test suite includes 135 tests covering:

- Wallet encryption/decryption (roundtrip, wrong password, security properties)
- Wallet file management (create, load, list, delete, format validation)
- API helpers (URL construction, request/response handling, error codes)
- CLI integration (subprocess tests for all commands)
- Live API smoke tests (chains, tokens, pairs, bridges, dexes)
- Live RPC balance queries (Ethereum, BSC, Polygon, Wanchain)
- Transaction status with mocked responses (all status codes 1-7)
- Quote/buildTx response parsing (all work modes 1-6)
- Wanchain gas price enforcement logic
- Error handling (missing parameters, unknown chains, encrypted wallet errors)

## Project Structure

```
xflows/
  src/
    index.ts         # CLI entry point and all core logic
    index.test.ts    # Comprehensive test suite
  package.json
  tsconfig.json
  README.md
```

**Key dependencies:**

| Package | Purpose |
|---------|---------|
| `commander` | CLI argument parsing and help generation |
| `ethers` | Wallet management, transaction signing, RPC interaction |
| Node.js `crypto` | AES-256-CBC encryption for wallet private keys |

**Data storage:**

| Path | Content |
|------|---------|
| `~/.xflows/wallets/*.json` | Wallet files (plaintext or encrypted private keys) |
