/**
 * Audit PES distributions to user wallets from the current presale vesting contract.
 * Outputs JSON summary + per-account detail to stdout (last line is JSON path marker).
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const BUYERS_FILE = path.join(ROOT, "output/pes-purchase-accounts-bsc-mainnet.json");
const PRESALE = "0x38882c608F64a8dAA5fbAB9a0712361D72866B6B";
const PES = "0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41";
const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
const SKIP_EVENTS = !["0", "false", "no"].includes(String(process.env.SKIP_EVENTS ?? "true").toLowerCase());
const FROM_BLOCK = Number(process.env.AUDIT_FROM_BLOCK || "101500000");
const CHUNK = Number(process.env.AUDIT_CHUNK || "10");
const CHUNK_DELAY_MS = Number(process.env.AUDIT_CHUNK_DELAY_MS || "300");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PRESALE_ABI = [
  "event Claimed(address indexed account, uint256 amount)",
  "event AutoDistributionBatch(address indexed executor, uint16 elapsedVestingPeriods, uint256 accountCount, uint256 distributedAmount)",
  "function totalTokensAllocated() view returns (uint256)",
  "function totalTokensClaimed() view returns (uint256)",
  "function elapsedVestingPeriods() view returns (uint16)",
  "function vestingPeriods() view returns (uint16)",
  "function allocations(address) view returns (uint256 packages, uint256 tokens, uint256 claimed)",
  "function vestedAmount(address) view returns (uint256)",
  "function claimableAmount(address) view returns (uint256)",
];

function loadBuyers() {
  const data = JSON.parse(fs.readFileSync(BUYERS_FILE, "utf8"));
  return data.accounts.map((row, idx) => ({
    index: row.index ?? idx + 1,
    account: ethers.getAddress(row.buyer || row.account),
    packages: row.packages,
    paymentUSDT: row.paymentUSDT,
    firstTime: row.firstTime,
    firstTx: row.firstTx,
  }));
}

function expectedVested(tokens, elapsed, vestingPeriods) {
  if (elapsed === 0) return 0n;
  const bps = 2000n + (8000n * BigInt(elapsed - 1)) / BigInt(vestingPeriods);
  return (tokens * bps) / 10000n;
}

async function queryAllocations(presale, accounts, elapsed, vestingPeriods) {
  const rows = [];
  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    const alloc = await presale.allocations(account);
    const packages = alloc.packages ?? alloc[0];
    const tokens = alloc.tokens ?? alloc[1];
    const claimed = alloc.claimed ?? alloc[2];
    const vested = expectedVested(tokens, Number(elapsed), Number(vestingPeriods));
    const claimable = vested > claimed ? vested - claimed : 0n;
    rows.push({ packages, tokens, claimed, vested, claimable });
    if (i > 0 && i % 50 === 0) {
      console.error(`  allocations progress: ${i}/${accounts.length}`);
      await sleep(CHUNK_DELAY_MS);
    }
  }
  return rows;
}

async function queryEventsChunked(presale, filter, fromBlock, toBlock, step = 5000) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = Math.min(start + step - 1, toBlock);
    const batch = await presale.queryFilter(filter, start, end);
    logs.push(...batch);
  }
  return logs;
}

async function queryClaimedEvents(presale, fromBlock, toBlock) {
  const filter = presale.filters.Claimed();
  const logs = await queryEventsChunked(presale, filter, fromBlock, toBlock, 5000);
  const byAccount = new Map();
  const timeline = [];
  for (const log of logs) {
    const account = ethers.getAddress(log.args.account);
    const amount = log.args.amount;
    byAccount.set(account, (byAccount.get(account) || 0n) + amount);
    timeline.push({
      account,
      amount: ethers.formatUnits(amount, 18),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
    });
  }
  timeline.sort((a, b) => a.blockNumber - b.blockNumber);
  return { byAccount, timeline, eventCount: logs.length };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 56, { batchMaxCount: 1, batchStallTime: 0 });
  const presale = new ethers.Contract(PRESALE, PRESALE_ABI, provider);
  const buyers = loadBuyers();
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);

  const [totalAllocated, totalClaimedOnChain, elapsed, vestingPeriods] = await Promise.all([
    presale.totalTokensAllocated(),
    presale.totalTokensClaimed(),
    presale.elapsedVestingPeriods(),
    presale.vestingPeriods(),
  ]);

  let deployLogs = [];
  if (!SKIP_EVENTS) {
    const deployFilter = presale.filters.AutoDistributionBatch();
    deployLogs = await queryEventsChunked(presale, deployFilter, FROM_BLOCK, blockNumber, 10000);
  }
  const fromBlock = FROM_BLOCK;

  console.error(`Querying ${buyers.length} allocations...`);
  const allocRows = await queryAllocations(
    presale,
    buyers.map((b) => b.account),
    elapsed,
    vestingPeriods
  );

  let events = { byAccount: new Map(), timeline: [], eventCount: 0 };
  if (!SKIP_EVENTS) {
    console.error(`Querying Claimed events from block ${fromBlock}...`);
    events = await queryClaimedEvents(presale, fromBlock, blockNumber);
  } else {
    console.error("Skipping Claimed event scan (SKIP_EVENTS=true). Using allocation.claimed as source of truth.");
  }

  const perUserExpected = expectedVested(ethers.parseUnits("3000", 18), Number(elapsed), Number(vestingPeriods));
  const accounts = [];
  let sumClaimedFromAlloc = 0n;
  let sumVested = 0n;
  let sumTokens = 0n;
  let matchExpected = 0;
  let partialClaim = 0;
  let overClaim = 0;
  let eventMismatch = 0;
  let noAllocation = 0;

  for (let i = 0; i < buyers.length; i += 1) {
    const buyer = buyers[i];
    const row = allocRows[i];
    const eventClaimed = events.byAccount.get(buyer.account) || 0n;
    const claimed = row.claimed;
    const tokens = row.tokens;
    const vested = row.vested;

    sumClaimedFromAlloc += claimed;
    sumVested += vested;
    sumTokens += tokens;

    if (tokens === 0n) noAllocation += 1;

    let status = "ok";
    if (claimed === perUserExpected && tokens === ethers.parseUnits("3000", 18)) {
      matchExpected += 1;
    } else if (claimed > 0n && claimed < vested) {
      partialClaim += 1;
      status = "partial";
    } else if (claimed > vested) {
      overClaim += 1;
      status = "over";
    } else if (claimed === 0n && vested > 0n) {
      status = "unclaimed";
    }

    if (!SKIP_EVENTS && eventClaimed !== claimed) {
      eventMismatch += 1;
      status = status === "ok" ? "event_mismatch" : `${status}+event_mismatch`;
    }

    accounts.push({
      index: buyer.index,
      account: buyer.account,
      packages: row.packages.toString(),
      allocatedPES: ethers.formatUnits(tokens, 18),
      vestedPES: ethers.formatUnits(vested, 18),
      claimedPES: ethers.formatUnits(claimed, 18),
      claimablePES: ethers.formatUnits(row.claimable, 18),
      expectedAtElapsedPES: ethers.formatUnits(perUserExpected, 18),
      eventSumPES: ethers.formatUnits(eventClaimed, 18),
      status,
      firstPurchaseTime: buyer.firstTime,
      firstPurchaseTx: buyer.firstTx,
    });
  }

  const anomalies = accounts.filter((a) => a.status !== "ok");
  const releaseBps = 2000 + (8000 * (Number(elapsed) - 1)) / Number(vestingPeriods);

  const result = {
    runAt: new Date().toISOString(),
    blockNumber,
    blockTimeUtc: new Date(Number(block.timestamp) * 1000).toISOString(),
    contracts: { pesToken: PES, presaleVesting: PRESALE },
    vesting: {
      elapsedPeriods: Number(elapsed),
      vestingPeriods: Number(vestingPeriods),
      releasePercent: `${releaseBps / 100}%`,
      perUserExpectedPES: ethers.formatUnits(perUserExpected, 18),
    },
    summary: {
      beneficiaryCount: buyers.length,
      totalAllocatedPES: ethers.formatUnits(totalAllocated, 18),
      totalClaimedOnChainPES: ethers.formatUnits(totalClaimedOnChain, 18),
      sumClaimedFromAllocationsPES: ethers.formatUnits(sumClaimedFromAlloc, 18),
      sumVestedPES: ethers.formatUnits(sumVested, 18),
      claimedEventCount: events.eventCount,
      usersFullyAtExpected: matchExpected,
      usersPartialClaim: partialClaim,
      usersOverVested: overClaim,
      usersNoAllocation: noAllocation,
      eventVsAllocMismatch: eventMismatch,
      anomalyCount: anomalies.length,
      onChainMatchesAllocationSum: sumClaimedFromAlloc === totalClaimedOnChain,
    },
    distributionBatches: deployLogs.length
      ? deployLogs.map((log) => ({
          elapsedPeriods: Number(log.args.elapsedVestingPeriods ?? log.args[1]),
          accountCount: Number(log.args.accountCount ?? log.args[2]),
          distributedPES: ethers.formatUnits(log.args.distributedAmount ?? log.args[3], 18),
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        }))
      : [
          { period: 1, distributedPES: "600000", accounts: 1000, note: "from deployment record 2026-05-31" },
          { period: 2, distributedPES: "60000", accounts: 1000, note: "from deployment record 2026-06-01" },
          { period: "3-9", distributedPES: "338400", accounts: 1000, note: "inferred: total claimed minus period 1+2 increment" },
        ],
    anomalies,
    accounts,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(ROOT, "output", `pes-user-distribution-audit-${stamp}.json`);
  const csvPath = path.join(ROOT, "output", `pes-user-distribution-audit-${stamp}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const csvHeader = [
    "index",
    "account",
    "allocatedPES",
    "vestedPES",
    "claimedPES",
    "claimablePES",
    "expectedAtElapsedPES",
    "status",
    "firstPurchaseTime",
    "firstPurchaseTx",
  ].join(",");
  const csvBody = accounts
    .map((a) =>
      [
        a.index,
        a.account,
        a.allocatedPES,
        a.vestedPES,
        a.claimedPES,
        a.claimablePES,
        a.expectedAtElapsedPES,
        a.status,
        a.firstPurchaseTime,
        a.firstPurchaseTx,
      ].join(",")
    )
    .join("\n");
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}`);

  console.log(JSON.stringify({ jsonPath, csvPath, summary: result.summary }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
