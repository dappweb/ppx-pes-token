/**
 * Export users who bought PES from the USDT/PES PancakeSwap V2 pool.
 * Outputs JSON; run export_dex_pool_purchases_table.py for CSV/XLSX.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const PAIR = ethers.getAddress(process.env.AMM_PAIR_ADDRESS || "0xf2c385aC7e699bf35C1d23873c2191FF7dDf9990");
const PES = ethers.getAddress(process.env.PES_ADDRESS || "0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41");
const USDT = ethers.getAddress(process.env.USDT_ADDRESS || "0x55d398326f99059fF775485246999027B3197955");
const FACTORY = "0xcA143Ce32Fe78f1f7019d46d3726Ea880D5D3b4";
const RPCS = [
  process.env.BSC_RPC_URL,
  process.env.VITE_READ_RPC_URL,
  "https://bsc-mainnet.gateway.tatum.io",
  "https://bsc.drpc.org",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc-dataseed3.binance.org",
  "https://bsc-dataseed4.binance.org",
  "https://1rpc.io/bnb",
].filter(Boolean);

const CHUNK = Number(process.env.DEX_CHUNK || "100");
const CHUNK_DELAY_MS = Number(process.env.DEX_CHUNK_DELAY_MS || "200");
const DATE = process.env.EXPORT_DATE || new Date().toISOString().slice(0, 10);

const pairIface = new ethers.Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const pesIface = new ethers.Interface([
  "event AutomatedMarketMakerPairUpdated(address indexed pair, bool indexed enabled)",
]);
const factoryIface = new ethers.Interface([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
]);

const SWAP_TOPIC = pairIface.getEvent("Swap").topicHash;
const AMM_TOPIC = pesIface.getEvent("AutomatedMarketMakerPairUpdated").topicHash;
const PAIR_CREATED_TOPIC = factoryIface.getEvent("PairCreated").topicHash;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToNumber(hex) {
  return Number(BigInt(hex));
}

function createRpc(url) {
  let id = 1;
  async function call(method, params = []) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload.result;
  }
  return { url, call };
}

async function makeRpc() {
  let lastError;
  for (const url of RPCS) {
    try {
      const rpc = createRpc(url);
      await rpc.call("eth_blockNumber");
      console.error(`RPC: ${url}`);
      return rpc;
    } catch (error) {
      lastError = error;
      console.error(`RPC failed ${url}: ${error.message}`);
    }
  }
  throw lastError || new Error("No RPC available");
}

async function getLogs(rpc, filter, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    let batch = null;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        batch = await rpc.call("eth_getLogs", [
          {
            ...filter,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          },
        ]);
        break;
      } catch (error) {
        lastError = error;
        await sleep(CHUNK_DELAY_MS * (attempt + 1));
      }
    }
    if (!batch) {
      throw lastError || new Error(`eth_getLogs failed for ${start}-${end}`);
    }
    logs.push(...batch);
    if (batch.length) {
      console.error(`  logs ${start}-${end}: ${batch.length}`);
    }
    await sleep(CHUNK_DELAY_MS);
  }
  return logs;
}

function decodeSwapLog(raw) {
  const parsed = pairIface.parseLog({
    topics: raw.topics,
    data: raw.data,
  });
  return {
    blockNumber: hexToNumber(raw.blockNumber),
    transactionHash: raw.transactionHash,
    logIndex: hexToNumber(raw.logIndex),
    sender: parsed.args.sender,
    to: parsed.args.to,
    amount0In: parsed.args.amount0In,
    amount1In: parsed.args.amount1In,
    amount0Out: parsed.args.amount0Out,
    amount1Out: parsed.args.amount1Out,
  };
}

async function findPairStartBlock(rpc, latest, fallbackFromBlock) {
  const window = 250000;
  const pairTopic = ethers.zeroPadValue(PAIR, 32);

  for (let end = latest; end >= fallbackFromBlock; end -= window) {
    const start = Math.max(fallbackFromBlock, end - window + 1);
    const logs = await getLogs(
      rpc,
      { address: PES, topics: [AMM_TOPIC, pairTopic] },
      start,
      end,
    );
    if (logs.length) {
      return hexToNumber(logs[0].blockNumber);
    }
  }

  for (let end = latest; end >= fallbackFromBlock; end -= window) {
    const start = Math.max(fallbackFromBlock, end - window + 1);
    const logs = await getLogs(rpc, { address: FACTORY, topics: [PAIR_CREATED_TOPIC] }, start, end);
    const hit = logs.find((raw) => {
      const parsed = factoryIface.parseLog({ topics: raw.topics, data: raw.data });
      return ethers.getAddress(parsed.args.pair) === PAIR;
    });
    if (hit) {
      return hexToNumber(hit.blockNumber);
    }
  }

  return fallbackFromBlock;
}

async function main() {
  const rpc = await makeRpc();
  const latest = hexToNumber(await rpc.call("eth_blockNumber"));
  const token0 = ethers.getAddress(`0x${(await rpc.call("eth_call", [{ to: PAIR, data: "0x0dfe1681" }, "latest"])).slice(-40)}`);
  const token1 = ethers.getAddress(`0x${(await rpc.call("eth_call", [{ to: PAIR, data: "0xd21220a7" }, "latest"])).slice(-40)}`);

  const pesIsToken0 = token0 === PES;
  const pesIsToken1 = token1 === PES;
  if (!pesIsToken0 && !pesIsToken1) {
    throw new Error(`Pair tokens mismatch: token0=${token0} token1=${token1}`);
  }
  const usdtIsToken0 = token0 === USDT;
  const usdtIsToken1 = token1 === USDT;
  if (!usdtIsToken0 && !usdtIsToken1) {
    throw new Error(`Pair is not PES/USDT: token0=${token0} token1=${token1}`);
  }

  const fallbackFromBlock = Number(process.env.DEX_FROM_BLOCK || String(latest - 800000));
  const fromBlock = await findPairStartBlock(rpc, latest, fallbackFromBlock);
  console.error(`Pair ${PAIR} | PES is token${pesIsToken0 ? "0" : "1"} | from block ${fromBlock} to ${latest}`);

  const rawSwapLogs = await getLogs(rpc, { address: PAIR, topics: [SWAP_TOPIC] }, fromBlock, latest);
  const swapLogs = rawSwapLogs.map(decodeSwapLog);
  console.error(`Total Swap logs: ${swapLogs.length}`);

  const blockCache = new Map();
  const txCache = new Map();
  const purchases = [];

  for (let i = 0; i < swapLogs.length; i += 1) {
    const log = swapLogs[i];
    let pesOut = 0n;
    let usdtIn = 0n;
    if (pesIsToken0) {
      pesOut = log.amount0Out;
      usdtIn = usdtIsToken1 ? log.amount1In : 0n;
    } else {
      pesOut = log.amount1Out;
      usdtIn = usdtIsToken0 ? log.amount0In : 0n;
    }

    if (pesOut <= 0n || usdtIn <= 0n) {
      continue;
    }

    const txHash = log.transactionHash;
    let tx = txCache.get(txHash);
    if (!tx) {
      tx = await rpc.call("eth_getTransactionByHash", [txHash]);
      txCache.set(txHash, tx);
    }

    const blockNumber = log.blockNumber;
    let block = blockCache.get(blockNumber);
    if (!block) {
      block = await rpc.call("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
      blockCache.set(blockNumber, block);
    }

    const buyer = tx?.from ? ethers.getAddress(tx.from) : ethers.getAddress(log.to);
    const pesAmount = ethers.formatUnits(pesOut, 18);
    const usdtAmount = ethers.formatUnits(usdtIn, 18);
    const price = Number(usdtAmount) / Number(pesAmount);
    const timestamp = block ? hexToNumber(block.timestamp) : 0;

    purchases.push({
      index: purchases.length + 1,
      buyer,
      recipient: ethers.getAddress(log.to),
      pesAmount,
      usdtAmount,
      priceUSDTPerPES: Number.isFinite(price) ? price.toFixed(12) : "",
      blockNumber,
      timeUTC: timestamp
        ? new Date(timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")
        : "",
      txHash,
      bscscanTx: `https://bscscan.com/tx/${txHash}`,
      logIndex: log.logIndex,
    });

    if (i > 0 && i % 20 === 0) {
      console.error(`  parsed ${i + 1}/${swapLogs.length} swaps, buys=${purchases.length}`);
      await sleep(50);
    }
  }

  const byBuyer = new Map();
  for (const row of purchases) {
    const key = row.buyer.toLowerCase();
    const prev = byBuyer.get(key);
    if (!prev) {
      byBuyer.set(key, {
        buyer: row.buyer,
        tradeCount: 1,
        totalPES: Number(row.pesAmount),
        totalUSDT: Number(row.usdtAmount),
        firstTime: row.timeUTC,
        lastTime: row.timeUTC,
        firstTx: row.txHash,
        lastTx: row.txHash,
      });
    } else {
      prev.tradeCount += 1;
      prev.totalPES += Number(row.pesAmount);
      prev.totalUSDT += Number(row.usdtAmount);
      if (row.timeUTC < prev.firstTime) {
        prev.firstTime = row.timeUTC;
        prev.firstTx = row.txHash;
      }
      if (row.timeUTC > prev.lastTime) {
        prev.lastTime = row.timeUTC;
        prev.lastTx = row.txHash;
      }
    }
  }

  const summary = {
    pair: PAIR,
    pes: PES,
    usdt: USDT,
    token0,
    token1,
    fromBlock,
    toBlock: latest,
    totalSwapEvents: swapLogs.length,
    buyTrades: purchases.length,
    uniqueBuyers: byBuyer.size,
    totalPESPurchased: purchases.reduce((sum, row) => sum + Number(row.pesAmount), 0).toFixed(4),
    totalUSDTPaid: purchases.reduce((sum, row) => sum + Number(row.usdtAmount), 0).toFixed(4),
    bscscanPair: `https://bscscan.com/address/${PAIR}`,
    generatedAt: new Date().toISOString(),
  };

  const payload = {
    summary,
    trades: purchases,
    buyers: [...byBuyer.values()].map((row, idx) => ({
      index: idx + 1,
      ...row,
      totalPES: row.totalPES.toFixed(4),
      totalUSDT: row.totalUSDT.toFixed(4),
      avgPriceUSDTPerPES: row.totalPES > 0 ? (row.totalUSDT / row.totalPES).toFixed(12) : "",
    })),
  };

  const jsonPath = path.join(ROOT, "output", `pes-dex-pool-purchases-${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(jsonPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
