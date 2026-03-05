#!/usr/bin/env node
import { Command } from "commander";
import { Wallet, JsonRpcProvider, parseUnits, formatUnits, parseEther, Contract, type TransactionResponse } from "ethers";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import pkg from "../package.json";

export const API_BASE = "https://xflows.wanchain.org/api/v3";
export const VERSION = pkg.version;

// ── RPC endpoints (publicnode.com where available) ──────────────────────────
export const RPC_MAP: Record<string, string> = {
  "1":    "https://ethereum-rpc.publicnode.com",          // Ethereum
  "56":   "https://bsc-rpc.publicnode.com",               // BSC
  "137":  "https://polygon-bor-rpc.publicnode.com",       // Polygon
  "43114":"https://avalanche-c-chain-rpc.publicnode.com",  // Avalanche
  "42161":"https://arbitrum-one-rpc.publicnode.com",       // Arbitrum
  "10":   "https://optimism-rpc.publicnode.com",          // Optimism
  "250":  "https://fantom-rpc.publicnode.com",            // Fantom
  "8453": "https://base-rpc.publicnode.com",              // Base
  "59144":"https://linea-rpc.publicnode.com",             // Linea
  "324":  "https://zksync-era-rpc.publicnode.com",        // zkSync Era
  "1101": "https://polygon-zkevm-rpc.publicnode.com",     // Polygon zkEVM
  "100":  "https://gnosis-rpc.publicnode.com",            // Gnosis
  "534352":"https://scroll-rpc.publicnode.com",           // Scroll
  "5000": "https://mantle-rpc.publicnode.com",            // Mantle
  "169":  "https://manta-pacific-rpc.publicnode.com",     // Manta Pacific
  "81457":"https://blast-rpc.publicnode.com",             // Blast
  "2888": "https://boba-ethereum-rpc.publicnode.com",     // Boba
  "1088": "https://metis-rpc.publicnode.com",             // Metis
  "42220":"https://celo-rpc.publicnode.com",              // Celo
  "2222": "https://kava-evm-rpc.publicnode.com",          // Kava
  "888":  "https://gwan-ssl.wandevs.org:56891",          // Wanchain mainnet
  "999":  "https://gwan-ssl.wandevs.org:46891",          // Wanchain testnet
};

// ── Wallet encryption/decryption ────────────────────────────────────────────
export function encryptPrivateKey(privateKey: string, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(privateKey, "utf8", "hex");
  encrypted += cipher.final("hex");
  return JSON.stringify({
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    data: encrypted,
  });
}

export function decryptPrivateKey(encryptedJson: string, password: string): string {
  const { salt, iv, data } = JSON.parse(encryptedJson);
  const key = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(iv, "hex"));
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── API helper ──────────────────────────────────────────────────────────────
export async function apiGet(endpoint: string, params?: Record<string, string>) {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function apiPost(endpoint: string, body: Record<string, any>) {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── Response unwrapper ──────────────────────────────────────────────────────
// The XFlows API wraps all responses in {success, data}. This extracts .data
// when present, so callers can access fields directly.
export function unwrapResponse(resp: any): any {
  if (resp && resp.success === true && resp.data !== undefined) {
    return resp.data;
  }
  return resp;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function getWalletDir(): string {
  const dir = path.join(process.env.HOME || "~", ".xflows", "wallets");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadWallet(name: string, password?: string): Wallet {
  const walletDir = getWalletDir();
  const filePath = path.join(walletDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Wallet "${name}" not found at ${filePath}`);
  }
  const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  let privateKey: string;
  if (content.encrypted) {
    if (!password) {
      throw new Error("This wallet is encrypted. Please provide --password to decrypt.");
    }
    try {
      privateKey = decryptPrivateKey(content.privateKey, password);
    } catch {
      throw new Error("Incorrect password or corrupted wallet file.");
    }
  } else {
    privateKey = content.privateKey;
  }
  return new Wallet(privateKey);
}

export function getProvider(chainId: string): JsonRpcProvider {
  const rpc = RPC_MAP[chainId];
  if (!rpc) throw new Error(`No RPC configured for chainId ${chainId}. Use --rpc to specify one.`);
  return new JsonRpcProvider(rpc);
}

export function printJson(data: any) {
  console.log(JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2));
}

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// ── CLI definition ──────────────────────────────────────────────────────────
const program = new Command();

program
  .name("xflows")
  .version(VERSION)
  .description(
    "XFlows Cross-Chain Bridge CLI Tool\n\n" +
    "A command-line interface for Wanchain XFlows cross-chain bridge.\n" +
    "Supports wallet management, quote queries, cross-chain transactions,\n" +
    "and all XFlows API query endpoints.\n\n" +
    "Wallet files are stored in ~/.xflows/wallets/\n\n" +
    "Examples:\n" +
    '  xflows wallet create --name myWallet\n' +
    '  xflows wallet create --name secureWallet --encrypt\n' +
    '  xflows chains\n' +
    '  xflows tokens --chain-id 1\n' +
    '  xflows quote --from-chain 1 --to-chain 56 --from-token 0x0...0 --to-token 0x0...0 --from-address 0x... --to-address 0x... --amount 1.0\n' +
    '  xflows send --wallet myWallet --from-chain 1 --to-chain 56 --from-token 0x0...0 --to-token 0x0...0 --to-address 0x... --amount 1.0\n' +
    '  xflows status --hash 0x... --from-chain 1 --to-chain 56 --from-token 0x0...0 --to-token 0x0...0 --from-address 0x... --to-address 0x... --amount 1.0'
  );

// ── Wallet commands ─────────────────────────────────────────────────────────
const walletCmd = program
  .command("wallet")
  .description("Wallet management commands");

walletCmd
  .command("create")
  .description(
    "Create a new EVM wallet\n\n" +
    "Generates a new random wallet and saves it to ~/.xflows/wallets/<name>.json.\n" +
    "Use --encrypt to encrypt the private key with a password.\n" +
    "Use --private-key to import an existing private key.\n\n" +
    "Examples:\n" +
    "  xflows wallet create --name myWallet\n" +
    "  xflows wallet create --name secureWallet --encrypt --password mysecret\n" +
    "  xflows wallet create --name imported --private-key 0xabc..."
  )
  .requiredOption("--name <name>", "Wallet name (used as filename)")
  .option("--encrypt", "Encrypt the private key with a password", false)
  .option("--password <password>", "Password for encryption (prompted if --encrypt is set but --password is omitted)")
  .option("--private-key <key>", "Import an existing private key instead of generating a new one")
  .action(async (opts) => {
    const walletDir = getWalletDir();
    const filePath = path.join(walletDir, `${opts.name}.json`);

    if (fs.existsSync(filePath)) {
      console.error(`Error: Wallet "${opts.name}" already exists at ${filePath}`);
      process.exit(1);
    }

    let wallet: Wallet;
    if (opts.privateKey) {
      wallet = new Wallet(opts.privateKey);
    } else {
      wallet = Wallet.createRandom();
    }

    let password = opts.password;
    if (opts.encrypt && !password) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      password = await new Promise<string>((resolve) => {
        rl.question("Enter encryption password: ", (ans) => {
          rl.close();
          resolve(ans);
        });
      });
    }

    const walletData: any = {
      name: opts.name,
      address: wallet.address,
      encrypted: opts.encrypt,
      createdAt: new Date().toISOString(),
    };

    if (opts.encrypt) {
      walletData.privateKey = encryptPrivateKey(wallet.privateKey, password);
    } else {
      walletData.privateKey = wallet.privateKey;
    }

    fs.writeFileSync(filePath, JSON.stringify(walletData, null, 2));

    console.log("Wallet created successfully!");
    console.log(`  Name:      ${opts.name}`);
    console.log(`  Address:   ${wallet.address}`);
    console.log(`  Encrypted: ${opts.encrypt}`);
    console.log(`  File:      ${filePath}`);
    if (!opts.encrypt && !opts.privateKey) {
      console.log(`  Private Key: ${wallet.privateKey}`);
    }
  });

walletCmd
  .command("list")
  .description("List all saved wallets")
  .action(() => {
    const walletDir = getWalletDir();
    const files = fs.readdirSync(walletDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.log("No wallets found. Use 'xflows wallet create' to create one.");
      return;
    }
    console.log("Saved wallets:\n");
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(walletDir, f), "utf-8"));
      console.log(`  ${data.name}`);
      console.log(`    Address:   ${data.address}`);
      console.log(`    Encrypted: ${data.encrypted}`);
      console.log(`    Created:   ${data.createdAt}`);
      console.log();
    }
  });

walletCmd
  .command("show")
  .description(
    "Show wallet details including address and private key\n\n" +
    "Examples:\n" +
    "  xflows wallet show --name myWallet\n" +
    "  xflows wallet show --name secureWallet --password mysecret"
  )
  .requiredOption("--name <name>", "Wallet name")
  .option("--password <password>", "Password to decrypt encrypted wallet")
  .action((opts) => {
    try {
      const wallet = loadWallet(opts.name, opts.password);
      console.log(`Name:        ${opts.name}`);
      console.log(`Address:     ${wallet.address}`);
      console.log(`Private Key: ${wallet.privateKey}`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

walletCmd
  .command("balance")
  .description(
    "Check native token balance on a specific chain\n\n" +
    "Examples:\n" +
    "  xflows wallet balance --name myWallet --chain-id 1\n" +
    "  xflows wallet balance --name myWallet --chain-id 56 --password mysecret"
  )
  .requiredOption("--name <name>", "Wallet name")
  .requiredOption("--chain-id <chainId>", "Chain ID to check balance on")
  .option("--password <password>", "Password to decrypt encrypted wallet")
  .option("--rpc <url>", "Custom RPC URL (overrides default)")
  .action(async (opts) => {
    try {
      const wallet = loadWallet(opts.name, opts.password);
      const provider = opts.rpc ? new JsonRpcProvider(opts.rpc) : getProvider(opts.chainId);
      const balance = await provider.getBalance(wallet.address);
      console.log(`Address: ${wallet.address}`);
      console.log(`Chain:   ${opts.chainId}`);
      console.log(`Balance: ${formatUnits(balance, 18)} (native token)`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

walletCmd
  .command("delete")
  .description("Delete a saved wallet")
  .requiredOption("--name <name>", "Wallet name to delete")
  .option("--force", "Skip confirmation", false)
  .action(async (opts) => {
    const walletDir = getWalletDir();
    const filePath = path.join(walletDir, `${opts.name}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: Wallet "${opts.name}" not found.`);
      process.exit(1);
    }
    if (!opts.force) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Are you sure you want to delete wallet "${opts.name}"? (yes/no): `, (ans) => {
          rl.close();
          resolve(ans);
        });
      });
      if (answer.toLowerCase() !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }
    fs.unlinkSync(filePath);
    console.log(`Wallet "${opts.name}" deleted.`);
  });

// ── Query commands ──────────────────────────────────────────────────────────
program
  .command("chains")
  .description(
    "List supported chains\n\n" +
    "Examples:\n" +
    "  xflows chains\n" +
    "  xflows chains --chain-id 1\n" +
    "  xflows chains --quix"
  )
  .option("--chain-id <chainId>", "Filter by specific chain ID")
  .option("--quix", "Show only QUiX-supported chains")
  .action(async (opts) => {
    const params: Record<string, string> = {};
    if (opts.chainId) params.chainId = opts.chainId;
    if (opts.quix) params.quix = "true";
    const data = await apiGet("/supported/chains", params);
    printJson(data);
  });

program
  .command("tokens")
  .description(
    "List supported tokens\n\n" +
    "Examples:\n" +
    "  xflows tokens\n" +
    "  xflows tokens --chain-id 1\n" +
    "  xflows tokens --chain-id 56 --quix"
  )
  .option("--chain-id <chainId>", "Filter tokens by chain ID")
  .option("--quix", "Show only QUiX-compatible tokens")
  .action(async (opts) => {
    const params: Record<string, string> = {};
    if (opts.chainId) params.chainId = opts.chainId;
    if (opts.quix) params.quix = "true";
    const data = await apiGet("/supported/tokens", params);
    printJson(data);
  });

program
  .command("pairs")
  .description(
    "List supported token pairs for cross-chain bridging\n\n" +
    "Examples:\n" +
    "  xflows pairs --from-chain 1\n" +
    "  xflows pairs --from-chain 1 --to-chain 56"
  )
  .requiredOption("--from-chain <chainId>", "Source chain ID")
  .option("--to-chain <chainId>", "Destination chain ID")
  .action(async (opts) => {
    const params: Record<string, string> = { fromChainId: opts.fromChain };
    if (opts.toChain) params.toChainId = opts.toChain;
    const data = await apiGet("/supported/pairs", params);
    printJson(data);
  });

program
  .command("bridges")
  .description("List supported bridges (e.g., wanbridge, quix)")
  .action(async () => {
    const data = await apiGet("/supported/bridges");
    printJson(data);
  });

program
  .command("dexes")
  .description("List supported DEX aggregators")
  .action(async () => {
    const data = await apiGet("/supported/dexes");
    printJson(data);
  });

// ── Quote command ───────────────────────────────────────────────────────────
program
  .command("quote")
  .description(
    "Get a cross-chain swap quote\n\n" +
    "Query the estimated output amount, fees, and route for a cross-chain swap.\n" +
    "Use native token address 0x0000000000000000000000000000000000000000 for ETH/BNB/etc.\n\n" +
    "Examples:\n" +
    "  # ETH (Ethereum) -> BNB (BSC) quote\n" +
    "  xflows quote \\\n" +
    "    --from-chain 1 --to-chain 56 \\\n" +
    "    --from-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --from-address 0xYourAddress --to-address 0xYourAddress \\\n" +
    "    --amount 1.0\n\n" +
    "  # With bridge and slippage options\n" +
    "  xflows quote \\\n" +
    "    --from-chain 1 --to-chain 56 \\\n" +
    "    --from-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --from-address 0xYourAddress --to-address 0xYourAddress \\\n" +
    "    --amount 1.0 --bridge quix --slippage 0.005"
  )
  .requiredOption("--from-chain <chainId>", "Source chain ID")
  .requiredOption("--to-chain <chainId>", "Destination chain ID")
  .requiredOption("--from-token <address>", "Source token contract address (0x0...0 for native)")
  .requiredOption("--to-token <address>", "Destination token contract address (0x0...0 for native)")
  .requiredOption("--from-address <address>", "Source wallet address")
  .requiredOption("--to-address <address>", "Destination wallet address")
  .requiredOption("--amount <amount>", "Amount to swap (human-readable, e.g., 1.5)")
  .option("--bridge <bridge>", "Bridge to use: wanbridge | quix")
  .option("--dex <dex>", "DEX aggregator: wanchain | rubic")
  .option("--slippage <slippage>", "Max slippage (e.g., 0.01 for 1%)")
  .option("--id <id>", "Request identifier for tracking")
  .action(async (opts) => {
    const body: Record<string, any> = {
      fromChainId: Number(opts.fromChain),
      toChainId: Number(opts.toChain),
      fromTokenAddress: opts.fromToken,
      toTokenAddress: opts.toToken,
      fromAddress: opts.fromAddress,
      toAddress: opts.toAddress,
      fromAmount: opts.amount,
    };
    if (opts.bridge) body.bridge = opts.bridge;
    if (opts.dex) body.dex = opts.dex;
    if (opts.slippage) body.slippage = Number(opts.slippage);
    if (opts.id) body.id = opts.id;

    const data = await apiPost("/quote", body);
    printJson(data);
  });

// ── Send (build & execute transaction) ──────────────────────────────────────
program
  .command("send")
  .description(
    "Build and send a cross-chain transaction\n\n" +
    "This command builds the transaction via the XFlows API, handles ERC20 token\n" +
    "approvals if needed, and signs + broadcasts the transaction on-chain.\n\n" +
    "IMPORTANT: For encrypted wallets, provide --password to decrypt the private key.\n" +
    "The Wanchain (chainId 888) baseFee is enforced to be at least 1 gwei.\n\n" +
    "Examples:\n" +
    "  # Send 1 ETH from Ethereum to BSC (native to native)\n" +
    "  xflows send \\\n" +
    "    --wallet myWallet \\\n" +
    "    --from-chain 1 --to-chain 56 \\\n" +
    "    --from-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-address 0xDestAddress \\\n" +
    "    --amount 1.0\n\n" +
    "  # With encrypted wallet\n" +
    "  xflows send \\\n" +
    "    --wallet secureWallet --password mysecret \\\n" +
    "    --from-chain 1 --to-chain 56 \\\n" +
    "    --from-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-address 0xDestAddress \\\n" +
    "    --amount 0.5 --bridge quix --slippage 0.005"
  )
  .requiredOption("--wallet <name>", "Wallet name to use for signing")
  .requiredOption("--from-chain <chainId>", "Source chain ID")
  .requiredOption("--to-chain <chainId>", "Destination chain ID")
  .requiredOption("--from-token <address>", "Source token contract address (0x0...0 for native)")
  .requiredOption("--to-token <address>", "Destination token contract address (0x0...0 for native)")
  .requiredOption("--to-address <address>", "Destination wallet address")
  .requiredOption("--amount <amount>", "Amount to swap (human-readable, e.g., 1.5)")
  .option("--password <password>", "Password to decrypt encrypted wallet")
  .option("--bridge <bridge>", "Bridge to use: wanbridge | quix")
  .option("--dex <dex>", "DEX aggregator: wanchain | rubic")
  .option("--slippage <slippage>", "Max slippage (e.g., 0.01 for 1%)")
  .option("--rpc <url>", "Custom RPC URL (overrides default for source chain)")
  .option("--gas-limit <limit>", "Custom gas limit")
  .option("--dry-run", "Only build the transaction, don't send it", false)
  .action(async (opts) => {
    try {
      // Load wallet
      const wallet = loadWallet(opts.wallet, opts.password);
      const provider = opts.rpc ? new JsonRpcProvider(opts.rpc) : getProvider(opts.fromChain);
      const signer = wallet.connect(provider);

      const body: Record<string, any> = {
        fromChainId: Number(opts.fromChain),
        toChainId: Number(opts.toChain),
        fromTokenAddress: opts.fromToken,
        toTokenAddress: opts.toToken,
        fromAddress: wallet.address,
        toAddress: opts.toAddress,
        fromAmount: opts.amount,
      };
      if (opts.bridge) body.bridge = opts.bridge;
      if (opts.dex) body.dex = opts.dex;
      if (opts.slippage) body.slippage = Number(opts.slippage);

      // Step 1: Get quote first to check for errors and show estimate
      console.log("Fetching quote...");
      const quoteResp = await apiPost("/quote", body);
      const quote = unwrapResponse(quoteResp);
      if (quote.error) {
        console.error(`Quote error: ${quote.error}`);
        process.exit(1);
      }
      console.log(`Estimated output: ${quote.amountOut}`);
      console.log(`Minimum output:   ${quote.amountOutMin}`);
      console.log(`Work mode:        ${quote.workMode}`);
      if (quote.nativeFees?.length) {
        console.log(`Native fees:`);
        for (const f of quote.nativeFees) {
          console.log(`  ${f.amount} ${f.symbol}`);
        }
      }
      if (quote.tokenFees?.length) {
        console.log(`Token fees:`);
        for (const f of quote.tokenFees) {
          console.log(`  ${f.amount} ${f.symbol}`);
        }
      }

      // Step 2: Build transaction
      console.log("\nBuilding transaction...");
      const buildResp = await apiPost("/buildTx", body);
      const buildResult = unwrapResponse(buildResp);

      if (buildResult.error) {
        console.error(`Build error: ${buildResult.error}`);
        process.exit(1);
      }

      const tx = buildResult.tx;
      if (!tx) {
        console.error("No transaction data returned from API.");
        console.log("Full response:");
        printJson(buildResp);
        process.exit(1);
      }

      // Step 3: Handle ERC20 approval if needed
      const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
      if (
        opts.fromToken.toLowerCase() !== NATIVE_ADDRESS &&
        tx.approvalAddress
      ) {
        console.log(`\nChecking token approval for ${tx.approvalAddress}...`);
        const tokenContract = new Contract(opts.fromToken, ERC20_ABI, signer);
        const currentAllowance = await tokenContract.allowance(wallet.address, tx.approvalAddress);
        const requiredAmount = BigInt(tx.value || 0) > 0n ? BigInt(tx.value) : parseUnits(opts.amount, 18);

        if (currentAllowance < requiredAmount) {
          console.log("Approving token spend...");
          const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
          const approveTx = await tokenContract.approve(tx.approvalAddress, maxApproval);
          console.log(`Approval tx: ${approveTx.hash}`);
          await approveTx.wait();
          console.log("Approval confirmed.");
        } else {
          console.log("Token already approved.");
        }
      }

      // Step 4: Prepare and send the transaction
      const txRequest: any = {
        to: tx.to,
        data: tx.data,
        value: tx.value || "0",
      };

      if (opts.gasLimit) {
        txRequest.gasLimit = BigInt(opts.gasLimit);
      }

      // Wanchain special handling: baseFee must be at least 1 gwei
      const isWanchain = opts.fromChain === "888";
      if (isWanchain) {
        const feeData = await provider.getFeeData();
        const minBaseFee = parseUnits("1", "gwei");
        if (feeData.gasPrice && feeData.gasPrice < minBaseFee) {
          txRequest.gasPrice = minBaseFee;
          console.log("Wanchain: enforcing minimum gasPrice of 1 gwei");
        } else if (feeData.maxFeePerGas) {
          // EIP-1559 style, but ensure baseFee is at least 1 gwei
          const maxFee = feeData.maxFeePerGas < minBaseFee ? minBaseFee : feeData.maxFeePerGas;
          txRequest.gasPrice = maxFee;
          console.log(`Wanchain: using gasPrice ${formatUnits(maxFee, "gwei")} gwei`);
        }
      }

      if (opts.dryRun) {
        console.log("\n[Dry Run] Transaction details:");
        printJson(txRequest);
        return;
      }

      console.log("\nSending transaction...");
      const sentTx: TransactionResponse = await signer.sendTransaction(txRequest);
      console.log(`Transaction hash: ${sentTx.hash}`);
      console.log("Waiting for confirmation...");
      const receipt = await sentTx.wait();
      console.log(`Transaction confirmed in block ${receipt?.blockNumber}`);
      console.log(`Gas used: ${receipt?.gasUsed.toString()}`);

      console.log("\nYou can track the cross-chain status with:");
      console.log(`  xflows status --hash ${sentTx.hash} --from-chain ${opts.fromChain} --to-chain ${opts.toChain} --from-token ${opts.fromToken} --to-token ${opts.toToken} --from-address ${wallet.address} --to-address ${opts.toAddress} --amount ${opts.amount}`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

// ── Status command ──────────────────────────────────────────────────────────
program
  .command("status")
  .description(
    "Check cross-chain transaction status\n\n" +
    "Status codes:\n" +
    "  1 = Success\n" +
    "  2 = Failed\n" +
    "  3 = Processing\n" +
    "  4/5 = Refunded\n" +
    "  6 = Trusteeship (manual intervention needed)\n" +
    "  7 = Risk transaction (AML flagged)\n\n" +
    "Examples:\n" +
    "  xflows status \\\n" +
    "    --hash 0xTxHash \\\n" +
    "    --from-chain 1 --to-chain 56 \\\n" +
    "    --from-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --to-token 0x0000000000000000000000000000000000000000 \\\n" +
    "    --from-address 0xYourAddress --to-address 0xYourAddress \\\n" +
    "    --amount 1.0"
  )
  .requiredOption("--hash <hash>", "Source chain transaction hash")
  .requiredOption("--from-chain <chainId>", "Source chain ID")
  .requiredOption("--to-chain <chainId>", "Destination chain ID")
  .requiredOption("--from-token <address>", "Source token contract address")
  .requiredOption("--to-token <address>", "Destination token contract address")
  .requiredOption("--from-address <address>", "Source wallet address")
  .requiredOption("--to-address <address>", "Destination wallet address")
  .requiredOption("--amount <amount>", "Amount that was swapped")
  .option("--bridge <bridge>", "Bridge used: wanbridge | quix")
  .option("--poll", "Keep polling until terminal status (success/failed/refunded)", false)
  .option("--interval <seconds>", "Polling interval in seconds", "15")
  .action(async (opts) => {
    const body: Record<string, any> = {
      hash: opts.hash,
      fromChainId: Number(opts.fromChain),
      toChainId: Number(opts.toChain),
      fromTokenAddress: opts.fromToken,
      toTokenAddress: opts.toToken,
      fromAddress: opts.fromAddress,
      toAddress: opts.toAddress,
      fromAmount: opts.amount,
    };
    if (opts.bridge) body.bridge = opts.bridge;

    const queryStatus = async () => {
      const resp = await apiPost("/status", body);
      return unwrapResponse(resp);
    };

    if (!opts.poll) {
      const data = await queryStatus();
      printJson(data);
      return;
    }

    // Polling mode
    const interval = Number(opts.interval) * 1000;
    const terminalCodes = [1, 2, 4, 5, 6, 7];
    console.log(`Polling every ${opts.interval}s until terminal status...`);

    while (true) {
      const data = await queryStatus();
      const code = data.statusCode;
      const msg = data.statusMsg || "Unknown";
      console.log(`[${new Date().toISOString()}] Status: ${code} - ${msg}`);

      if (terminalCodes.includes(code)) {
        console.log("\nFinal status:");
        printJson(data);
        break;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  });

// ── RPC list command ────────────────────────────────────────────────────────
program
  .command("rpc")
  .description("List configured RPC endpoints for all chains")
  .action(() => {
    console.log("Configured RPC endpoints:\n");
    for (const [chainId, rpc] of Object.entries(RPC_MAP).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  Chain ${chainId.padEnd(8)} ${rpc}`);
    }
  });

if (import.meta.main) {
  program.parse();
}
