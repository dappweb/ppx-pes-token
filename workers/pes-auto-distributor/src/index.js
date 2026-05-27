import { ethers } from "ethers";
import { BUYERS } from "./buyers.js";

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function paused() view returns (bool)",
  "function elapsedVestingPeriods() view returns (uint16)",
  "function currentScheduledElapsedPeriods() view returns (uint16)",
  "function totalTokensClaimed() view returns (uint256)",
  "function distributeVested(address[] accounts) returns (uint256)",
];

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function numberEnv(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function privateKeyFromEnv(env) {
  const value = String(env.KEEPER_PRIVATE_KEY || "").trim();
  if (!value) throw new Error("KEEPER_PRIVATE_KEY secret is missing");
  return value.startsWith("0x") ? value : `0x${value}`;
}

function chunkArray(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

async function getDistributor(env) {
  const chainId = numberEnv(env, "CHAIN_ID", 56);
  const provider = new ethers.JsonRpcProvider(env.BSC_RPC_URL, chainId, {
    batchMaxCount: 1,
    batchStallTime: 0,
  });
  const wallet = new ethers.Wallet(privateKeyFromEnv(env), provider);
  const presale = new ethers.Contract(ethers.getAddress(env.PRESALE_ADDRESS), PRESALE_ABI, wallet);
  return { chainId, provider, wallet, presale };
}

async function readStatus(env) {
  const { chainId, provider, wallet, presale } = await getDistributor(env);
  const [network, blockNumber, owner, paused, elapsed, totalTokensClaimed] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    presale.owner(),
    presale.paused(),
    presale.elapsedVestingPeriods(),
    presale.totalTokensClaimed(),
  ]);

  let keeper = ethers.ZeroAddress;
  let scheduled = 0n;
  let v3Supported = true;
  try {
    [keeper, scheduled] = await Promise.all([presale.keeper(), presale.currentScheduledElapsedPeriods()]);
  } catch {
    v3Supported = false;
  }

  return {
    chainId,
    networkChainId: network.chainId.toString(),
    blockNumber,
    presale: ethers.getAddress(env.PRESALE_ADDRESS),
    signer: wallet.address,
    owner,
    keeper,
    v3Supported,
    signerAuthorized:
      wallet.address.toLowerCase() === owner.toLowerCase() || wallet.address.toLowerCase() === keeper.toLowerCase(),
    paused,
    elapsedVestingPeriods: elapsed.toString(),
    scheduledElapsedPeriods: scheduled.toString(),
    totalTokensClaimedPES: ethers.formatUnits(totalTokensClaimed, 18),
    buyerCount: BUYERS.length,
    batchSize: numberEnv(env, "BATCH_SIZE", 80),
  };
}

async function runDistribution(env, source = "scheduled") {
  const batchSize = numberEnv(env, "BATCH_SIZE", 80);
  const confirmations = numberEnv(env, "CONFIRMATIONS", 1);
  const { provider, wallet, presale } = await getDistributor(env);
  const status = await readStatus(env);

  if (!status.v3Supported) {
    return { ...status, source, skipped: true, reason: "Presale has not been upgraded to auto distribution" };
  }
  if (!status.signerAuthorized) {
    throw new Error(`Signer ${wallet.address} is not owner ${status.owner} or keeper ${status.keeper}`);
  }
  if (status.paused) {
    throw new Error("Presale is paused");
  }
  if (status.scheduledElapsedPeriods === "0") {
    return { ...status, source, skipped: true, reason: "Auto distribution has not started" };
  }

  const batches = chunkArray(BUYERS, batchSize);
  let nonce = await wallet.getNonce("pending");
  const transactions = [];

  for (let i = 0; i < batches.length; i++) {
    const accounts = batches[i];
    const estimatedGas = await presale.distributeVested.estimateGas(accounts);
    const gasLimit = (estimatedGas * 12n) / 10n;
    const tx = await presale.distributeVested(accounts, { gasLimit, nonce });
    nonce += 1;
    const receipt = await tx.wait(confirmations);
    transactions.push({
      batch: i + 1,
      accounts: accounts.length,
      hash: tx.hash,
      blockNumber: receipt?.blockNumber || null,
      gasUsed: receipt?.gasUsed?.toString() || null,
    });
  }

  const [elapsedAfter, totalTokensClaimedAfter, latestBlock] = await Promise.all([
    presale.elapsedVestingPeriods(),
    presale.totalTokensClaimed(),
    provider.getBlockNumber(),
  ]);

  return {
    ...status,
    source,
    blockNumberAfter: latestBlock,
    elapsedVestingPeriodsAfter: elapsedAfter.toString(),
    totalTokensClaimedAfterPES: ethers.formatUnits(totalTokensClaimedAfter, 18),
    transactions,
  };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runDistribution(env, "cron")
        .then((result) => console.log(JSON.stringify({ ok: true, scheduledTime: controller.scheduledTime, result })))
        .catch((error) =>
          console.error(JSON.stringify({ ok: false, scheduledTime: controller.scheduledTime, error: error.message }))
        )
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return json(await readStatus(env));
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const token = request.headers.get("x-run-token") || url.searchParams.get("token") || "";
      if (!env.DISTRIBUTOR_RUN_TOKEN || token !== env.DISTRIBUTOR_RUN_TOKEN) {
        return json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }
      return json({ ok: true, result: await runDistribution(env, "manual") });
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  },
};
