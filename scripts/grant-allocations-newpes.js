/**
 * Grant allocations on the NEW Vesting proxy for the 1000 historical buyers.
 * Reads buyer list from output/pes-purchase-accounts-bsc-mainnet.json.
 * Each buyer gets 1 package = 3000 PES (matches old presale 1:1).
 *
 * Required env (when EXECUTE=true):
 *   PRIVATE_KEY                owner key
 *   BSC_RPC_URL                (optional)
 *   PRESALE_ADDRESS            new vesting proxy address (required)
 *   BUYERS_FILE                default output/pes-purchase-accounts-bsc-mainnet.json
 *   CHUNK_SIZE                 default 100
 *   PACKAGES_PER_BUYER         default 1
 *   EXECUTE=true               otherwise dry-run only
 *
 * The script aggregates duplicate addresses (case-insensitive) by summing packages
 * before sending tx, so it is safe if the source JSON contains repeated entries.
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function pesToken() view returns (address)",
  "function pesPerPackage() view returns (uint256)",
  "function maxPackages() view returns (uint256)",
  "function totalPackagesAllocated() view returns (uint256)",
  "function totalTokensAllocated() view returns (uint256)",
  "function allocations(address) view returns (uint256 packages, uint256 tokens, uint256 claimed)",
  "function grantAllocations(address[] accounts, uint256[] packagesList)",
];

function env(name) {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}
function parseBool(name, fb = false) {
  const v = env(name); if (v === null) return fb;
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}
function parseUint(name, fb) {
  const v = env(name); if (v === null) return BigInt(fb);
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be uint`);
  return BigInt(v);
}
function checkedAddress(name, v) {
  if (!hre.ethers.isAddress(v)) throw new Error(`${name} must be a valid address`);
  return hre.ethers.getAddress(v);
}
function txUrl(h) { return h ? `${EXPLORER_BASE_URL}/tx/${h}` : null; }
function addressUrl(a) { return `${EXPLORER_BASE_URL}/address/${a}`; }

function loadBuyers(filePath, packagesPerBuyer) {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) throw new Error(`Buyers file not found: ${abs}`);
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  const arr = Array.isArray(data) ? data : (data.accounts || data.records || data.data || data.purchases || []);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("No buyers found in source file");
  }

  // Aggregate by address (case-insensitive) summing packages
  const agg = new Map();
  for (const entry of arr) {
    const raw = entry.account || entry.address || entry.buyer;
    if (!raw) continue;
    const addr = hre.ethers.getAddress(raw);
    const pkgs = entry.packages !== undefined
      ? BigInt(entry.packages)
      : packagesPerBuyer;
    agg.set(addr, (agg.get(addr) || 0n) + pkgs);
  }
  return [...agg.entries()].map(([account, packages]) => ({ account, packages }));
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");
  const chunkSize = Number(env("CHUNK_SIZE") || "100");
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("CHUNK_SIZE must be a positive integer");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);

  const presaleAddress = checkedAddress("PRESALE_ADDRESS", env("PRESALE_ADDRESS") || "");
  const buyersFile = env("BUYERS_FILE") || "output/pes-purchase-accounts-bsc-mainnet.json";
  const packagesPerBuyer = parseUint("PACKAGES_PER_BUYER", 1n);

  const buyers = loadBuyers(buyersFile, packagesPerBuyer);
  const totalPackages = buyers.reduce((s, b) => s + b.packages, 0n);

  const presale = await hre.ethers.getContractAt(PRESALE_ABI, presaleAddress);
  const [owner, pesToken, pesPerPackage, maxPackages, packagesAllocBefore, tokensAllocBefore] = await Promise.all([
    presale.owner(),
    presale.pesToken(),
    presale.pesPerPackage(),
    presale.maxPackages(),
    presale.totalPackagesAllocated(),
    presale.totalTokensAllocated(),
  ]);

  if (packagesAllocBefore + totalPackages > maxPackages) {
    throw new Error(
      `totalPackagesAllocated (${packagesAllocBefore}) + new (${totalPackages}) > maxPackages (${maxPackages})`
    );
  }

  const plan = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    presale: { address: presaleAddress, owner, pesToken, explorer: addressUrl(presaleAddress) },
    source: { buyersFile, uniqueBuyers: buyers.length, totalPackages: totalPackages.toString() },
    config: {
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: maxPackages.toString(),
      chunkSize,
      packagesPerBuyer: packagesPerBuyer.toString(),
    },
    stateBefore: {
      totalPackagesAllocated: packagesAllocBefore.toString(),
      totalTokensAllocated: hre.ethers.formatUnits(tokensAllocBefore, 18),
    },
    expectedTotalTokens: hre.ethers.formatUnits(totalPackages * pesPerPackage, 18),
  };

  if (!execute) {
    console.log("GRANT_ALLOCATIONS_NEWPES_PLAN_START");
    console.log(JSON.stringify(plan, null, 2));
    console.log("GRANT_ALLOCATIONS_NEWPES_PLAN_END");
    console.log(`First 3 buyers preview:`);
    buyers.slice(0, 3).forEach((b, i) => console.log(`  [${i}] ${b.account} pkg=${b.packages}`));
    console.log(`Last buyer:  ${buyers[buyers.length - 1].account} pkg=${buyers[buyers.length - 1].packages}`);
    return;
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("PRIVATE_KEY required");
  if (hre.ethers.getAddress(signer.address) !== hre.ethers.getAddress(owner)) {
    throw new Error(`Signer ${signer.address} is not owner ${owner}`);
  }

  const txHashes = [];
  for (let offset = 0; offset < buyers.length; offset += chunkSize) {
    const chunk = buyers.slice(offset, offset + chunkSize);
    const accounts = chunk.map((b) => b.account);
    const pkgs = chunk.map((b) => b.packages);
    const tx = await presale.connect(signer).grantAllocations(accounts, pkgs);
    console.log(`grantAllocations[${offset + 1}-${offset + chunk.length}] tx: ${tx.hash}`);
    await tx.wait(confirmations);
    txHashes.push({ range: `${offset + 1}-${offset + chunk.length}`, hash: tx.hash, url: txUrl(tx.hash) });
  }

  const [packagesAllocAfter, tokensAllocAfter] = await Promise.all([
    presale.totalPackagesAllocated(),
    presale.totalTokensAllocated(),
  ]);

  // Spot check
  const samples = buyers.slice(0, 3).concat(buyers.slice(-1));
  const sampleResults = [];
  for (const b of samples) {
    const a = await presale.allocations(b.account);
    sampleResults.push({
      account: b.account,
      packages: a.packages.toString(),
      tokens: hre.ethers.formatUnits(a.tokens, 18),
      claimed: hre.ethers.formatUnits(a.claimed, 18),
    });
  }

  const result = {
    ...plan,
    signer: signer.address,
    txHashes,
    stateAfter: {
      totalPackagesAllocated: packagesAllocAfter.toString(),
      totalTokensAllocated: hre.ethers.formatUnits(tokensAllocAfter, 18),
    },
    samples: sampleResults,
  };

  console.log("GRANT_ALLOCATIONS_NEWPES_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("GRANT_ALLOCATIONS_NEWPES_RESULT_END");

  const outputPath = path.join(process.cwd(), "deployments",
    `bsc-mainnet-grant-allocations-newpes-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Deployment file: ${outputPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
