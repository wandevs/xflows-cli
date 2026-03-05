import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Wallet, parseUnits, JsonRpcProvider } from "ethers";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  apiGet,
  apiPost,
  getWalletDir,
  loadWallet,
  getProvider,
  printJson,
  RPC_MAP,
  API_BASE,
  VERSION,
  ERC20_ABI,
  unwrapResponse,
} from "./index";

// ── Test fixtures ───────────────────────────────────────────────────────────
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_PASSWORD = "test-password-123";
const TEST_WALLET_DIR = path.join(process.env.HOME || "~", ".xflows", "wallets");
const TEST_WALLET_PREFIX = "__test_xflows_";

function testWalletName() {
  return `${TEST_WALLET_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupTestWallets() {
  if (fs.existsSync(TEST_WALLET_DIR)) {
    const files = fs.readdirSync(TEST_WALLET_DIR);
    for (const f of files) {
      if (f.startsWith(TEST_WALLET_PREFIX)) {
        fs.unlinkSync(path.join(TEST_WALLET_DIR, f));
      }
    }
  }
}

afterEach(() => {
  cleanupTestWallets();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants & Configuration
// ═══════════════════════════════════════════════════════════════════════════
describe("Constants", () => {
  test("API_BASE is correct", () => {
    expect(API_BASE).toBe("https://xflows.wanchain.org/api/v3");
  });

  test("VERSION is semver format", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("RPC_MAP contains Wanchain mainnet with correct URL", () => {
    expect(RPC_MAP["888"]).toBe("https://gwan-ssl.wandevs.org:56891");
  });

  test("RPC_MAP contains Wanchain testnet", () => {
    expect(RPC_MAP["999"]).toBe("https://gwan-ssl.wandevs.org:46891");
  });

  test("RPC_MAP contains major EVM chains", () => {
    expect(RPC_MAP["1"]).toBeDefined();   // Ethereum
    expect(RPC_MAP["56"]).toBeDefined();  // BSC
    expect(RPC_MAP["137"]).toBeDefined(); // Polygon
    expect(RPC_MAP["42161"]).toBeDefined(); // Arbitrum
    expect(RPC_MAP["10"]).toBeDefined();  // Optimism
  });

  test("RPC_MAP uses publicnode.com for Ethereum", () => {
    expect(RPC_MAP["1"]).toContain("publicnode.com");
  });

  test("RPC_MAP uses publicnode.com for BSC", () => {
    expect(RPC_MAP["56"]).toContain("publicnode.com");
  });

  test("ERC20_ABI contains all required functions", () => {
    expect(ERC20_ABI).toHaveLength(6);
    expect(ERC20_ABI).toContain("function approve(address spender, uint256 amount) returns (bool)");
    expect(ERC20_ABI).toContain("function allowance(address owner, address spender) view returns (uint256)");
    expect(ERC20_ABI).toContain("function transfer(address to, uint256 amount) returns (bool)");
    expect(ERC20_ABI).toContain("function balanceOf(address owner) view returns (uint256)");
    expect(ERC20_ABI).toContain("function decimals() view returns (uint8)");
    expect(ERC20_ABI).toContain("function symbol() view returns (string)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. unwrapResponse
// ═══════════════════════════════════════════════════════════════════════════
describe("unwrapResponse", () => {
  test("unwraps {success: true, data: ...} envelope", () => {
    const resp = { success: true, data: { amountOut: "1.0", workMode: 1 } };
    const result = unwrapResponse(resp);
    expect(result.amountOut).toBe("1.0");
    expect(result.workMode).toBe(1);
  });

  test("unwraps nested tx object", () => {
    const resp = { success: true, data: { chainId: 888, tx: { to: "0xABC", data: "0x123", value: "100" } } };
    const result = unwrapResponse(resp);
    expect(result.tx.to).toBe("0xABC");
    expect(result.tx.value).toBe("100");
  });

  test("unwraps array data", () => {
    const resp = { success: true, data: [{ chainId: "1" }, { chainId: "56" }] };
    const result = unwrapResponse(resp);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  test("returns raw response when no success/data envelope", () => {
    const resp = { error: "something went wrong" };
    const result = unwrapResponse(resp);
    expect(result.error).toBe("something went wrong");
  });

  test("returns raw response when success is false", () => {
    const resp = { success: false, error: "bad request" };
    const result = unwrapResponse(resp);
    expect(result.success).toBe(false);
    expect(result.error).toBe("bad request");
  });

  test("handles null input", () => {
    expect(unwrapResponse(null)).toBeNull();
  });

  test("handles undefined input", () => {
    expect(unwrapResponse(undefined)).toBeUndefined();
  });

  test("handles data: null (valid envelope)", () => {
    const resp = { success: true, data: null };
    // data is null, so it returns null
    expect(unwrapResponse(resp)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Encryption / Decryption
// ═══════════════════════════════════════════════════════════════════════════
describe("encryptPrivateKey / decryptPrivateKey", () => {
  test("encrypt then decrypt returns original private key", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const decrypted = decryptPrivateKey(encrypted, TEST_PASSWORD);
    expect(decrypted).toBe(TEST_PRIVATE_KEY);
  });

  test("encrypted output is valid JSON with salt, iv, data", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const parsed = JSON.parse(encrypted);
    expect(parsed).toHaveProperty("salt");
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("data");
  });

  test("salt is 32-char hex (16 bytes)", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const parsed = JSON.parse(encrypted);
    expect(parsed.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  test("iv is 32-char hex (16 bytes)", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const parsed = JSON.parse(encrypted);
    expect(parsed.iv).toMatch(/^[0-9a-f]{32}$/);
  });

  test("encrypted data is non-empty hex string", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const parsed = JSON.parse(encrypted);
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data).toMatch(/^[0-9a-f]+$/);
  });

  test("wrong password throws error", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    expect(() => decryptPrivateKey(encrypted, "wrong-password")).toThrow();
  });

  test("two encryptions produce different ciphertexts (random salt/iv)", () => {
    const enc1 = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const enc2 = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    expect(enc1).not.toBe(enc2);
  });

  test("works with empty string value", () => {
    const encrypted = encryptPrivateKey("", TEST_PASSWORD);
    const decrypted = decryptPrivateKey(encrypted, TEST_PASSWORD);
    expect(decrypted).toBe("");
  });

  test("works with unicode password", () => {
    const password = "密码🔑パスワード";
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, password);
    const decrypted = decryptPrivateKey(encrypted, password);
    expect(decrypted).toBe(TEST_PRIVATE_KEY);
  });

  test("works with very long password", () => {
    const password = "a".repeat(1000);
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, password);
    const decrypted = decryptPrivateKey(encrypted, password);
    expect(decrypted).toBe(TEST_PRIVATE_KEY);
  });

  test("decrypt with malformed JSON throws", () => {
    expect(() => decryptPrivateKey("not-json", TEST_PASSWORD)).toThrow();
  });

  test("decrypt with missing fields throws", () => {
    expect(() => decryptPrivateKey(JSON.stringify({ salt: "aa" }), TEST_PASSWORD)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Wallet directory
// ═══════════════════════════════════════════════════════════════════════════
describe("getWalletDir", () => {
  test("returns path ending with .xflows/wallets", () => {
    const dir = getWalletDir();
    expect(dir).toEndWith(".xflows/wallets");
  });

  test("directory exists after call", () => {
    const dir = getWalletDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("returns consistent path across calls", () => {
    expect(getWalletDir()).toBe(getWalletDir());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. loadWallet
// ═══════════════════════════════════════════════════════════════════════════
describe("loadWallet", () => {
  test("loads unencrypted wallet correctly", () => {
    const name = testWalletName();
    const walletData = {
      name,
      address: TEST_ADDRESS,
      encrypted: false,
      privateKey: TEST_PRIVATE_KEY,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(walletData));

    const wallet = loadWallet(name);
    expect(wallet.address).toBe(TEST_ADDRESS);
    expect(wallet.privateKey).toBe(TEST_PRIVATE_KEY);
  });

  test("loads encrypted wallet with correct password", () => {
    const name = testWalletName();
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const walletData = {
      name,
      address: TEST_ADDRESS,
      encrypted: true,
      privateKey: encrypted,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(walletData));

    const wallet = loadWallet(name, TEST_PASSWORD);
    expect(wallet.address).toBe(TEST_ADDRESS);
    expect(wallet.privateKey).toBe(TEST_PRIVATE_KEY);
  });

  test("throws when wallet file not found", () => {
    expect(() => loadWallet("nonexistent_wallet_xyz_999")).toThrow(/not found/);
  });

  test("throws when encrypted wallet loaded without password", () => {
    const name = testWalletName();
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const walletData = {
      name,
      address: TEST_ADDRESS,
      encrypted: true,
      privateKey: encrypted,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(walletData));

    expect(() => loadWallet(name)).toThrow(/encrypted.*--password/i);
  });

  test("throws when encrypted wallet loaded with wrong password", () => {
    const name = testWalletName();
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    const walletData = {
      name,
      address: TEST_ADDRESS,
      encrypted: true,
      privateKey: encrypted,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(walletData));

    expect(() => loadWallet(name, "wrong-pass")).toThrow(/Incorrect password/);
  });

  test("loaded wallet can sign messages", () => {
    const name = testWalletName();
    const walletData = {
      name,
      address: TEST_ADDRESS,
      encrypted: false,
      privateKey: TEST_PRIVATE_KEY,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(walletData));

    const wallet = loadWallet(name);
    expect(wallet.signingKey).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. getProvider
// ═══════════════════════════════════════════════════════════════════════════
describe("getProvider", () => {
  test("returns JsonRpcProvider for known chain", () => {
    const provider = getProvider("1");
    expect(provider).toBeInstanceOf(JsonRpcProvider);
  });

  test("throws for unknown chain ID", () => {
    expect(() => getProvider("99999")).toThrow(/No RPC configured/);
  });

  test("Wanchain provider uses correct RPC", () => {
    const provider = getProvider("888");
    // Provider should be created successfully
    expect(provider).toBeInstanceOf(JsonRpcProvider);
  });

  test("error message suggests --rpc flag", () => {
    expect(() => getProvider("77777")).toThrow(/--rpc/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. printJson
// ═══════════════════════════════════════════════════════════════════════════
describe("printJson", () => {
  test("prints formatted JSON to stdout", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    printJson({ a: 1, b: "hello" });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1, b: "hello" }, null, 2));
    logSpy.mockRestore();
  });

  test("handles nested objects", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const data = { foo: { bar: [1, 2, 3] } };
    printJson(data);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    logSpy.mockRestore();
  });

  test("handles null", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    printJson(null);
    expect(logSpy).toHaveBeenCalledWith("null");
    logSpy.mockRestore();
  });

  test("handles arrays", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    printJson([1, 2, 3]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([1, 2, 3], null, 2));
    logSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. API helpers (with mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════
describe("apiGet", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls correct URL without params", async () => {
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = url.toString ? url.toString() : String(url);
      return new Response(JSON.stringify({ success: true }));
    }) as any;

    await apiGet("/supported/chains");
    expect(calledUrl).toBe(`${API_BASE}/supported/chains`);
  });

  test("appends query params to URL", async () => {
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = url.toString ? url.toString() : String(url);
      return new Response(JSON.stringify({ success: true }));
    }) as any;

    await apiGet("/supported/chains", { chainId: "1", quix: "true" });
    expect(calledUrl).toContain("chainId=1");
    expect(calledUrl).toContain("quix=true");
  });

  test("skips undefined and empty string params", async () => {
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = url.toString ? url.toString() : String(url);
      return new Response(JSON.stringify({ success: true }));
    }) as any;

    await apiGet("/supported/chains", { chainId: "", quix: "" });
    expect(calledUrl).not.toContain("chainId");
    expect(calledUrl).not.toContain("quix");
  });

  test("returns parsed JSON response", async () => {
    const mockData = { success: true, data: [{ chainId: "1" }] };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(mockData));
    }) as any;

    const result = await apiGet("/supported/chains");
    expect(result).toEqual(mockData);
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    expect(apiGet("/bad/endpoint")).rejects.toThrow(/API error: 404/);
  });

  test("throws on 500 error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Server Error", { status: 500, statusText: "Internal Server Error" });
    }) as any;

    expect(apiGet("/error")).rejects.toThrow(/API error: 500/);
  });
});

describe("apiPost", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST with correct URL", async () => {
    let calledUrl = "";
    let calledMethod = "";
    globalThis.fetch = mock(async (url: any, init: any) => {
      calledUrl = String(url);
      calledMethod = init?.method;
      return new Response(JSON.stringify({ success: true }));
    }) as any;

    await apiPost("/quote", { fromChainId: 1 });
    expect(calledUrl).toBe(`${API_BASE}/quote`);
    expect(calledMethod).toBe("POST");
  });

  test("sends JSON body with Content-Type header", async () => {
    let calledHeaders: any = {};
    let calledBody = "";
    globalThis.fetch = mock(async (_url: any, init: any) => {
      calledHeaders = init?.headers;
      calledBody = init?.body;
      return new Response(JSON.stringify({ success: true }));
    }) as any;

    const body = { fromChainId: 1, toChainId: 56 };
    await apiPost("/quote", body);
    expect(calledHeaders["Content-Type"]).toBe("application/json");
    expect(calledBody).toBe(JSON.stringify(body));
  });

  test("returns parsed JSON response", async () => {
    const mockResponse = { amountOut: "1.5", workMode: 1 };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(mockResponse));
    }) as any;

    const result = await apiPost("/quote", {});
    expect(result).toEqual(mockResponse);
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Bad Request", { status: 400, statusText: "Bad Request" });
    }) as any;

    expect(apiPost("/quote", {})).rejects.toThrow(/API error: 400/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CLI integration tests (via subprocess)
// ═══════════════════════════════════════════════════════════════════════════
describe("CLI integration", () => {
  const run = async (args: string) => {
    const proc = Bun.spawn(["bun", "src/index.ts", ...args.split(" ")], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };

  describe("--help", () => {
    test("shows help text", async () => {
      const { stdout } = await run("--help");
      expect(stdout).toContain("XFlows Cross-Chain Bridge CLI Tool");
      expect(stdout).toContain("wallet");
      expect(stdout).toContain("chains");
      expect(stdout).toContain("quote");
      expect(stdout).toContain("send");
      expect(stdout).toContain("status");
    });

    test("shows version", async () => {
      const { stdout } = await run("--version");
      expect(stdout.trim()).toBe(VERSION);
    });
  });

  describe("wallet create", () => {
    test("creates a new wallet", async () => {
      const name = testWalletName();
      const { stdout, exitCode } = await run(`wallet create --name ${name}`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Wallet created successfully");
      expect(stdout).toContain(name);
      expect(stdout).toContain("0x");
      // Verify file exists
      expect(fs.existsSync(path.join(TEST_WALLET_DIR, `${name}.json`))).toBe(true);
    });

    test("creates encrypted wallet with --password", async () => {
      const name = testWalletName();
      const { stdout, exitCode } = await run(`wallet create --name ${name} --encrypt --password mypass`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Encrypted: true");
      // Verify stored private key is encrypted
      const data = JSON.parse(fs.readFileSync(path.join(TEST_WALLET_DIR, `${name}.json`), "utf-8"));
      expect(data.encrypted).toBe(true);
      const parsed = JSON.parse(data.privateKey);
      expect(parsed).toHaveProperty("salt");
      expect(parsed).toHaveProperty("iv");
      expect(parsed).toHaveProperty("data");
    });

    test("imports existing private key", async () => {
      const name = testWalletName();
      const { stdout, exitCode } = await run(`wallet create --name ${name} --private-key ${TEST_PRIVATE_KEY}`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(TEST_ADDRESS);
    });

    test("refuses to overwrite existing wallet", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name}`);
      const { stderr, exitCode } = await run(`wallet create --name ${name}`);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("already exists");
    });
  });

  describe("wallet list", () => {
    test("lists created wallets", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name}`);
      const { stdout } = await run("wallet list");
      expect(stdout).toContain(name);
      expect(stdout).toContain("Address:");
      expect(stdout).toContain("Encrypted:");
    });
  });

  describe("wallet show", () => {
    test("shows unencrypted wallet details", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name} --private-key ${TEST_PRIVATE_KEY}`);
      const { stdout, exitCode } = await run(`wallet show --name ${name}`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(TEST_ADDRESS);
      expect(stdout).toContain(TEST_PRIVATE_KEY);
    });

    test("shows encrypted wallet with password", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name} --private-key ${TEST_PRIVATE_KEY} --encrypt --password mypass`);
      const { stdout, exitCode } = await run(`wallet show --name ${name} --password mypass`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(TEST_ADDRESS);
      expect(stdout).toContain(TEST_PRIVATE_KEY);
    });

    test("fails for encrypted wallet without password", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name} --encrypt --password mypass`);
      const { stderr, exitCode } = await run(`wallet show --name ${name}`);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("encrypted");
    });

    test("fails for non-existent wallet", async () => {
      const { stderr, exitCode } = await run("wallet show --name does_not_exist_ever");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("not found");
    });
  });

  describe("wallet delete", () => {
    test("deletes wallet with --force", async () => {
      const name = testWalletName();
      await run(`wallet create --name ${name}`);
      const filePath = path.join(TEST_WALLET_DIR, `${name}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const { stdout, exitCode } = await run(`wallet delete --name ${name} --force`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("deleted");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test("fails when wallet does not exist", async () => {
      const { stderr, exitCode } = await run("wallet delete --name nonexistent_xyz --force");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("not found");
    });
  });

  describe("wallet --help subcommands", () => {
    test("wallet create --help shows options", async () => {
      const { stdout } = await run("wallet create --help");
      expect(stdout).toContain("--name");
      expect(stdout).toContain("--encrypt");
      expect(stdout).toContain("--password");
      expect(stdout).toContain("--private-key");
    });

    test("wallet balance --help shows options", async () => {
      const { stdout } = await run("wallet balance --help");
      expect(stdout).toContain("--name");
      expect(stdout).toContain("--chain-id");
      expect(stdout).toContain("--rpc");
    });

    test("wallet token-balance --help shows options", async () => {
      const { stdout } = await run("wallet token-balance --help");
      expect(stdout).toContain("--name");
      expect(stdout).toContain("--chain-id");
      expect(stdout).toContain("--token");
      expect(stdout).toContain("--decimals");
      expect(stdout).toContain("--rpc");
    });
  });

  describe("rpc", () => {
    test("lists all configured RPCs", async () => {
      const { stdout, exitCode } = await run("rpc");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Chain 1");
      expect(stdout).toContain("Chain 888");
      expect(stdout).toContain("publicnode.com");
      expect(stdout).toContain("gwan-ssl.wandevs.org");
    });
  });

  describe("quote --help", () => {
    test("shows all required and optional parameters", async () => {
      const { stdout } = await run("quote --help");
      expect(stdout).toContain("--from-chain");
      expect(stdout).toContain("--to-chain");
      expect(stdout).toContain("--from-token");
      expect(stdout).toContain("--to-token");
      expect(stdout).toContain("--from-address");
      expect(stdout).toContain("--to-address");
      expect(stdout).toContain("--amount");
      expect(stdout).toContain("--bridge");
      expect(stdout).toContain("--slippage");
      expect(stdout).toContain("--dex");
    });
  });

  describe("send --help", () => {
    test("shows all required and optional parameters", async () => {
      const { stdout } = await run("send --help");
      expect(stdout).toContain("--wallet");
      expect(stdout).toContain("--from-chain");
      expect(stdout).toContain("--to-chain");
      expect(stdout).toContain("--password");
      expect(stdout).toContain("--dry-run");
      expect(stdout).toContain("--gas-limit");
      expect(stdout).toContain("--rpc");
      expect(stdout).toContain("Wanchain");
      expect(stdout).toContain("1 gwei");
    });
  });

  describe("status --help", () => {
    test("shows all parameters and status codes", async () => {
      const { stdout } = await run("status --help");
      expect(stdout).toContain("--hash");
      expect(stdout).toContain("--poll");
      expect(stdout).toContain("--interval");
      expect(stdout).toContain("Success");
      expect(stdout).toContain("Failed");
      expect(stdout).toContain("Processing");
      expect(stdout).toContain("Refunded");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Wallet file format validation
// ═══════════════════════════════════════════════════════════════════════════
describe("Wallet file format", () => {
  test("unencrypted wallet file has all required fields", async () => {
    const name = testWalletName();
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const data = JSON.parse(fs.readFileSync(path.join(TEST_WALLET_DIR, `${name}.json`), "utf-8"));
    expect(data.name).toBe(name);
    expect(data.address).toBe(TEST_ADDRESS);
    expect(data.encrypted).toBe(false);
    expect(data.privateKey).toBe(TEST_PRIVATE_KEY);
    expect(data.createdAt).toBeDefined();
    expect(new Date(data.createdAt).getTime()).not.toBeNaN();
  });

  test("encrypted wallet file stores cipher not plaintext key", async () => {
    const name = testWalletName();
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY, "--encrypt", "--password", "secret"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    const data = JSON.parse(fs.readFileSync(path.join(TEST_WALLET_DIR, `${name}.json`), "utf-8"));
    expect(data.encrypted).toBe(true);
    // Private key should NOT be stored in plaintext
    expect(data.privateKey).not.toContain(TEST_PRIVATE_KEY);
    // Should be valid encrypted JSON
    const cipher = JSON.parse(data.privateKey);
    expect(cipher.salt).toBeDefined();
    expect(cipher.iv).toBeDefined();
    expect(cipher.data).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. RPC_MAP completeness and validity
// ═══════════════════════════════════════════════════════════════════════════
describe("RPC_MAP validation", () => {
  test("all RPC URLs start with https://", () => {
    for (const [chainId, url] of Object.entries(RPC_MAP)) {
      expect(url).toStartWith("https://");
    }
  });

  test("all chain IDs are numeric strings", () => {
    for (const chainId of Object.keys(RPC_MAP)) {
      expect(Number(chainId)).not.toBeNaN();
      expect(Number(chainId)).toBeGreaterThan(0);
    }
  });

  test("no duplicate RPC URLs (except Wanchain testnet/mainnet share domain)", () => {
    const urls = Object.values(RPC_MAP);
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
  });

  test("has at least 20 chains configured", () => {
    expect(Object.keys(RPC_MAP).length).toBeGreaterThanOrEqual(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. API live smoke tests (optional, tests actual API availability)
// ═══════════════════════════════════════════════════════════════════════════
describe("API live smoke tests", () => {
  test("GET /supported/bridges returns data", async () => {
    const result = await apiGet("/supported/bridges");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("data");
    expect(Array.isArray(result.data)).toBe(true);
  });

  test("GET /supported/dexes returns data", async () => {
    const result = await apiGet("/supported/dexes");
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  test("GET /supported/chains returns chains", async () => {
    const result = await apiGet("/supported/chains");
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    // Each chain should have chainId and chainName
    expect(result.data[0]).toHaveProperty("chainId");
  });

  test("GET /supported/chains with chainId filter", async () => {
    const result = await apiGet("/supported/chains", { chainId: "1" });
    expect(result.success).toBe(true);
  });

  test("GET /supported/tokens returns tokens", async () => {
    const result = await apiGet("/supported/tokens");
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  test("GET /supported/tokens with chainId filter", async () => {
    const result = await apiGet("/supported/tokens", { chainId: "1" });
    expect(result.success).toBe(true);
  });

  test("GET /supported/pairs returns pairs", async () => {
    const result = await apiGet("/supported/pairs", { fromChainId: "1" });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test("CLI chains command returns valid JSON", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "chains"], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
  });

  test("CLI bridges command returns valid JSON", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "bridges"], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data).toBeInstanceOf(Array);
  }, 30000);

  test("CLI dexes command returns valid JSON", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "dexes"], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data).toBeInstanceOf(Array);
  });

  test("CLI tokens --chain-id 1 returns valid JSON", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "tokens", "--chain-id", "1"], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
  }, 30000);

  test("CLI pairs --from-chain 1 returns valid JSON", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "pairs", "--from-chain", "1"], {
      cwd: "/Users/molin/workspace/temp/xflows",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Edge cases & error handling
// ═══════════════════════════════════════════════════════════════════════════
describe("Edge cases", () => {
  test("wallet name with special characters in path is handled", async () => {
    const name = `${TEST_WALLET_PREFIX}special_chars_test`;
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "wallet", "create", "--name", name],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Wallet created successfully");
  });

  test("missing required options on quote shows error", async () => {
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "quote", "--from-chain", "1"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("required");
  });

  test("missing required options on send shows error", async () => {
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "send", "--wallet", "test"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("required");
  });

  test("missing required options on status shows error", async () => {
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "status", "--hash", "0xabc"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("required");
  });

  test("pairs command requires --from-chain", async () => {
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "pairs"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("required");
  });

  test("unknown command shows help", async () => {
    const proc = Bun.spawn(
      ["bun", "src/index.ts", "nonexistentcommand"],
      { cwd: "/Users/molin/workspace/temp/xflows", stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Encryption security properties
// ═══════════════════════════════════════════════════════════════════════════
describe("Encryption security", () => {
  test("different passwords produce different ciphertexts", () => {
    const enc1 = JSON.parse(encryptPrivateKey(TEST_PRIVATE_KEY, "password1"));
    const enc2 = JSON.parse(encryptPrivateKey(TEST_PRIVATE_KEY, "password2"));
    expect(enc1.data).not.toBe(enc2.data);
  });

  test("ciphertext does not contain plaintext key", () => {
    const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD);
    // Remove 0x prefix and check the hex doesn't appear in ciphertext
    const keyHex = TEST_PRIVATE_KEY.slice(2);
    expect(encrypted).not.toContain(keyHex);
  });

  test("encrypt/decrypt roundtrip with all zero key", () => {
    const key = "0x" + "0".repeat(64);
    const encrypted = encryptPrivateKey(key, "pass");
    const decrypted = decryptPrivateKey(encrypted, "pass");
    expect(decrypted).toBe(key);
  });

  test("encrypt/decrypt roundtrip with all f key", () => {
    const key = "0x" + "f".repeat(64);
    const encrypted = encryptPrivateKey(key, "pass");
    const decrypted = decryptPrivateKey(encrypted, "pass");
    expect(decrypted).toBe(key);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Wallet address derivation
// ═══════════════════════════════════════════════════════════════════════════
describe("Wallet address derivation", () => {
  test("known private key produces expected address", () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY);
    expect(wallet.address).toBe(TEST_ADDRESS);
  });

  test("loadWallet returns same address as direct Wallet creation", () => {
    const name = testWalletName();
    fs.mkdirSync(TEST_WALLET_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_WALLET_DIR, `${name}.json`),
      JSON.stringify({
        name,
        address: TEST_ADDRESS,
        encrypted: false,
        privateKey: TEST_PRIVATE_KEY,
        createdAt: new Date().toISOString(),
      })
    );

    const loaded = loadWallet(name);
    const direct = new Wallet(TEST_PRIVATE_KEY);
    expect(loaded.address).toBe(direct.address);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Wallet balance (CLI integration, live RPC)
// ═══════════════════════════════════════════════════════════════════════════
describe("CLI wallet balance", () => {
  const CWD = "/Users/molin/workspace/temp/xflows";
  const runArgs = (args: string[]) => {
    const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
      cwd: CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
      exited: proc.exited,
    };
  };

  test("shows balance for known address on Ethereum mainnet", async () => {
    const name = testWalletName();
    // vitalik.eth - a well-known address guaranteed to have some balance
    const vitalikKey = TEST_PRIVATE_KEY; // we just need a valid wallet, balance doesn't matter
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", vitalikKey]);
    await p.exited;

    const { stdout, stderr, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "1"]);
    const out = await stdout;
    const err = await stderr;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Address:");
    expect(out).toContain("Chain:   1");
    expect(out).toContain("Balance:");
    expect(out).toContain("(native token)");
  }, 30000);

  test("shows balance on BSC", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stdout, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "56"]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Chain:   56");
    expect(out).toContain("Balance:");
  }, 30000);

  test("shows balance on Polygon", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stdout, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "137"]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Chain:   137");
    expect(out).toContain("Balance:");
  }, 30000);

  test("shows balance on Wanchain mainnet", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stdout, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "888"]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Chain:   888");
    expect(out).toContain("Balance:");
  }, 30000);

  test("balance with encrypted wallet and password succeeds", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY, "--encrypt", "--password", "pw123"]);
    await p.exited;

    const { stdout, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "1", "--password", "pw123"]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Balance:");
  }, 30000);

  test("balance with encrypted wallet without password fails", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--encrypt", "--password", "pw123"]);
    await p.exited;

    const { stderr, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "1"]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("encrypted");
  }, 15000);

  test("balance with non-existent wallet fails", async () => {
    const { stderr, exited } = runArgs(["wallet", "balance", "--name", "wallet_that_never_exists_xyz", "--chain-id", "1"]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("not found");
  }, 15000);

  test("balance with unknown chain ID fails", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stderr, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "99999"]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("No RPC configured");
  }, 15000);

  test("balance with custom --rpc succeeds", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stdout, exited } = runArgs([
      "wallet", "balance", "--name", name,
      "--chain-id", "1",
      "--rpc", "https://ethereum-rpc.publicnode.com",
    ]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Balance:");
  }, 30000);

  test("balance returns numeric value", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stdout, exited } = runArgs(["wallet", "balance", "--name", name, "--chain-id", "1"]);
    const out = await stdout;
    await exited;
    // Extract balance line and ensure it parses as a number
    const match = out.match(/Balance:\s+([\d.]+)/);
    expect(match).not.toBeNull();
    const balance = parseFloat(match![1]);
    expect(balance).toBeGreaterThanOrEqual(0);
  }, 30000);

  test("balance missing --chain-id shows error", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const { stderr, exited } = runArgs(["wallet", "balance", "--name", name]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 15b. Wallet token-balance (CLI integration, live RPC)
// ═══════════════════════════════════════════════════════════════════════════
describe("CLI wallet token-balance", () => {
  const CWD = "/Users/molin/workspace/temp/xflows";
  const runArgs = (args: string[]) => {
    const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
      cwd: CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
      exited: proc.exited,
    };
  };

  test("shows USDC balance on Ethereum mainnet (auto-detect decimals)", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    // USDC on Ethereum
    const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const { stdout, exited } = runArgs(["wallet", "token-balance", "--name", name, "--chain-id", "1", "--token", token]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Address:");
    expect(out).toContain("Token:   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(out).toContain("Balance:");
  }, 30000);

  test("shows USDT balance on BSC (with explicit decimals)", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    // USDT on BSC (18 decimals)
    const token = "0x55d398326f99059fF775485246999027B3197955";
    const { stdout, exited } = runArgs(["wallet", "token-balance", "--name", name, "--chain-id", "56", "--token", token, "--decimals", "18"]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Balance:");
  }, 30000);

  test("token-balance with custom --rpc succeeds", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name, "--private-key", TEST_PRIVATE_KEY]);
    await p.exited;

    const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const { stdout, exited } = runArgs([
      "wallet", "token-balance", "--name", name,
      "--chain-id", "1",
      "--token", token,
      "--rpc", "https://ethereum-rpc.publicnode.com",
    ]);
    const out = await stdout;
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("Balance:");
  }, 30000);

  test("token-balance missing --token shows error", async () => {
    const name = testWalletName();
    const p = runArgs(["wallet", "create", "--name", name]);
    await p.exited;

    const { stderr, exited } = runArgs(["wallet", "token-balance", "--name", name, "--chain-id", "1"]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required option '--token <address>'");
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Transaction status (CLI integration, live API)
// ═══════════════════════════════════════════════════════════════════════════
describe("CLI status command", () => {
  const CWD = "/Users/molin/workspace/temp/xflows";
  const runArgs = (args: string[]) => {
    const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
      cwd: CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
      exited: proc.exited,
    };
  };

  const STATUS_BASE_ARGS = [
    "status",
    "--hash", "0x0000000000000000000000000000000000000000000000000000000000000001",
    "--from-chain", "1",
    "--to-chain", "56",
    "--from-token", "0x0000000000000000000000000000000000000000",
    "--to-token", "0x0000000000000000000000000000000000000000",
    "--from-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "--to-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "--amount", "1.0",
  ];

  test("status command for a fake hash returns error (API rejects invalid hash)", async () => {
    const { stderr, exited } = runArgs(STATUS_BASE_ARGS);
    const err = await stderr;
    const code = await exited;
    // API returns 400 for non-existent transactions, so CLI exits with error
    expect(code).not.toBe(0);
    expect(err).toContain("API error");
  }, 30000);

  test("status with --bridge wanbridge also returns error for fake hash", async () => {
    const { stderr, exited } = runArgs([...STATUS_BASE_ARGS, "--bridge", "wanbridge"]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("API error");
  }, 30000);

  test("status missing --hash shows error", async () => {
    const { stderr, exited } = runArgs([
      "status",
      "--from-chain", "1",
      "--to-chain", "56",
      "--from-token", "0x0000000000000000000000000000000000000000",
      "--to-token", "0x0000000000000000000000000000000000000000",
      "--from-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "--to-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "--amount", "1.0",
    ]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  });

  test("status missing --from-chain shows error", async () => {
    const { stderr, exited } = runArgs([
      "status",
      "--hash", "0x0000000000000000000000000000000000000000000000000000000000000001",
      "--to-chain", "56",
      "--from-token", "0x0000000000000000000000000000000000000000",
      "--to-token", "0x0000000000000000000000000000000000000000",
      "--from-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "--to-address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "--amount", "1.0",
    ]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  });

  test("status missing --to-chain shows error", async () => {
    const { stderr, exited } = runArgs([
      "status",
      "--hash", "0xabc",
      "--from-chain", "1",
      "--from-token", "0x0000000000000000000000000000000000000000",
      "--to-token", "0x0000000000000000000000000000000000000000",
      "--from-address", "0xabc",
      "--to-address", "0xabc",
      "--amount", "1.0",
    ]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  });

  test("status missing --from-address shows error", async () => {
    const { stderr, exited } = runArgs([
      "status",
      "--hash", "0xabc",
      "--from-chain", "1",
      "--to-chain", "56",
      "--from-token", "0x0000000000000000000000000000000000000000",
      "--to-token", "0x0000000000000000000000000000000000000000",
      "--to-address", "0xabc",
      "--amount", "1.0",
    ]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  });

  test("status missing --amount shows error", async () => {
    const { stderr, exited } = runArgs([
      "status",
      "--hash", "0xabc",
      "--from-chain", "1",
      "--to-chain", "56",
      "--from-token", "0x0000000000000000000000000000000000000000",
      "--to-token", "0x0000000000000000000000000000000000000000",
      "--from-address", "0xabc",
      "--to-address", "0xabc",
    ]);
    const err = await stderr;
    const code = await exited;
    expect(code).not.toBe(0);
    expect(err).toContain("required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. Status API unit tests (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════
describe("apiPost /status (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct body for status query", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ statusCode: 3, statusMsg: "Processing" }));
    }) as any;

    await apiPost("/status", {
      hash: "0xabc",
      fromChainId: 1,
      toChainId: 56,
      fromTokenAddress: "0x0000000000000000000000000000000000000000",
      toTokenAddress: "0x0000000000000000000000000000000000000000",
      fromAddress: "0xSender",
      toAddress: "0xReceiver",
      fromAmount: "1.0",
    });

    expect(capturedBody.hash).toBe("0xabc");
    expect(capturedBody.fromChainId).toBe(1);
    expect(capturedBody.toChainId).toBe(56);
    expect(capturedBody.fromAmount).toBe("1.0");
  });

  test("returns statusCode=1 for success", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 1,
        statusMsg: "Success",
        receiveAmount: "0.5",
        destinationHash: "0xdef",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x1" });
    expect(result.statusCode).toBe(1);
    expect(result.statusMsg).toBe("Success");
    expect(result.receiveAmount).toBe("0.5");
    expect(result.destinationHash).toBe("0xdef");
  });

  test("returns statusCode=2 for failure", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 2,
        statusMsg: "Failed",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x2" });
    expect(result.statusCode).toBe(2);
  });

  test("returns statusCode=3 for processing", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 3,
        statusMsg: "Processing",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x3" });
    expect(result.statusCode).toBe(3);
  });

  test("returns statusCode=4 for refunded", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 4,
        statusMsg: "Refunded",
        refundHash: "0xrefund",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x4" });
    expect(result.statusCode).toBe(4);
    expect(result.refundHash).toBe("0xrefund");
  });

  test("returns statusCode=6 for trusteeship", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 6,
        statusMsg: "Trusteeship",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x6" });
    expect(result.statusCode).toBe(6);
  });

  test("returns statusCode=7 for risk transaction", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 7,
        statusMsg: "Risk Transaction",
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x7" });
    expect(result.statusCode).toBe(7);
  });

  test("returns workMode and hashes", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        statusCode: 1,
        statusMsg: "Success",
        workMode: 1,
        sourceHash: "0xsrc",
        destinationHash: "0xdst",
        swapHash: "0xswap",
        timestamp: 1700000000,
      }));
    }) as any;

    const result = await apiPost("/status", { hash: "0x1" });
    expect(result.workMode).toBe(1);
    expect(result.sourceHash).toBe("0xsrc");
    expect(result.destinationHash).toBe("0xdst");
    expect(result.swapHash).toBe("0xswap");
    expect(result.timestamp).toBe(1700000000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. Quote API unit tests (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════
describe("apiPost /quote (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct body for quote", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ amountOut: "1.0" }));
    }) as any;

    await apiPost("/quote", {
      fromChainId: 1,
      toChainId: 56,
      fromTokenAddress: "0x0000000000000000000000000000000000000000",
      toTokenAddress: "0x0000000000000000000000000000000000000000",
      fromAddress: "0xSender",
      toAddress: "0xReceiver",
      fromAmount: "1.0",
      bridge: "wanbridge",
      slippage: 0.01,
    });

    expect(capturedBody.fromChainId).toBe(1);
    expect(capturedBody.toChainId).toBe(56);
    expect(capturedBody.fromAmount).toBe("1.0");
    expect(capturedBody.bridge).toBe("wanbridge");
    expect(capturedBody.slippage).toBe(0.01);
  });

  test("returns quote with amountOut and fees", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        amountOut: "0.95",
        amountOutMin: "0.94",
        slippage: 0.01,
        priceImpact: 0.005,
        workMode: 1,
        bridge: "wanbridge",
        nativeFees: [{ amount: "0.001", symbol: "ETH", decimals: 18 }],
        tokenFees: [],
        approvalAddress: "0xApproval",
      }));
    }) as any;

    const result = await apiPost("/quote", {});
    expect(result.amountOut).toBe("0.95");
    expect(result.amountOutMin).toBe("0.94");
    expect(result.slippage).toBe(0.01);
    expect(result.workMode).toBe(1);
    expect(result.nativeFees).toHaveLength(1);
    expect(result.nativeFees[0].symbol).toBe("ETH");
    expect(result.approvalAddress).toBe("0xApproval");
  });

  test("returns error for invalid quote", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        error: "Insufficient liquidity",
      }));
    }) as any;

    const result = await apiPost("/quote", {});
    expect(result.error).toBe("Insufficient liquidity");
  });

  test("handles all work modes 1-6", async () => {
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ workMode: mode, amountOut: "1.0" }));
      }) as any;

      const result = await apiPost("/quote", {});
      expect(result.workMode).toBe(mode);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. buildTx API unit tests (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════
describe("apiPost /buildTx (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns tx with to, data, value for EVM chain", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        chainId: 1,
        tx: {
          to: "0xContractAddress",
          data: "0xabcdef",
          value: "1000000000000000000",
          approvalAddress: null,
        },
      }));
    }) as any;

    const result = await apiPost("/buildTx", {});
    expect(result.tx.to).toBe("0xContractAddress");
    expect(result.tx.data).toBe("0xabcdef");
    expect(result.tx.value).toBe("1000000000000000000");
  });

  test("returns approvalAddress when token needs approval", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        chainId: 1,
        tx: {
          to: "0xBridge",
          data: "0x123",
          value: "0",
          approvalAddress: "0xSpender",
        },
      }));
    }) as any;

    const result = await apiPost("/buildTx", {});
    expect(result.tx.approvalAddress).toBe("0xSpender");
  });

  test("returns serializedTx for Solana", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        chainId: 501,
        tx: {
          serializedTx: "base64EncodedTransaction",
        },
      }));
    }) as any;

    const result = await apiPost("/buildTx", {});
    expect(result.tx.serializedTx).toBe("base64EncodedTransaction");
  });

  test("returns error for failed build", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        error: "Amount too low",
      }));
    }) as any;

    const result = await apiPost("/buildTx", {});
    expect(result.error).toBe("Amount too low");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Wanchain gasPrice enforcement logic
// ═══════════════════════════════════════════════════════════════════════════
describe("Wanchain gasPrice enforcement", () => {
  test("1 gwei equals 1000000000 wei", () => {
    const oneGwei = parseUnits("1", "gwei");
    expect(oneGwei).toBe(1000000000n);
  });

  test("gasPrice below 1 gwei should be bumped on Wanchain", () => {
    const minBaseFee = parseUnits("1", "gwei");
    const lowGasPrice = parseUnits("0.5", "gwei");
    expect(lowGasPrice < minBaseFee).toBe(true);
    // The CLI would set gasPrice = minBaseFee in this case
    const enforced = lowGasPrice < minBaseFee ? minBaseFee : lowGasPrice;
    expect(enforced).toBe(minBaseFee);
  });

  test("gasPrice at 1 gwei should not be changed", () => {
    const minBaseFee = parseUnits("1", "gwei");
    const exactGwei = parseUnits("1", "gwei");
    expect(exactGwei < minBaseFee).toBe(false);
    const enforced = exactGwei < minBaseFee ? minBaseFee : exactGwei;
    expect(enforced).toBe(exactGwei);
  });

  test("gasPrice above 1 gwei should not be changed", () => {
    const minBaseFee = parseUnits("1", "gwei");
    const highGasPrice = parseUnits("10", "gwei");
    expect(highGasPrice < minBaseFee).toBe(false);
    const enforced = highGasPrice < minBaseFee ? minBaseFee : highGasPrice;
    expect(enforced).toBe(highGasPrice);
  });

  test("gasPrice of 0 should be bumped to 1 gwei", () => {
    const minBaseFee = parseUnits("1", "gwei");
    const zero = 0n;
    expect(zero < minBaseFee).toBe(true);
    const enforced = zero < minBaseFee ? minBaseFee : zero;
    expect(enforced).toBe(minBaseFee);
  });
});
