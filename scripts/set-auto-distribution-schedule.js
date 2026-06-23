/**
 * Align auto-distribution schedule with current elapsedVestingPeriods (no catch-up).
 * Sets autoDistributionStart so currentScheduledElapsedPeriods() == elapsedVestingPeriods.
 *
 * Required when EXECUTE=true:
 *   PRIVATE_KEY, PRESALE_ADDRESS
 *
 * Optional:
 *   AUTO_DISTRIBUTION_PERIOD_SECONDS  default 86400
 *   EXECUTE=true                      otherwise dry-run
 */
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULT_PRESALE_ADDRESS = "0x38882c608F64a8dAA5fbAB9a0712361D72866B6B";

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function elapsedVestingPeriods() view returns (uint16)",
  "function currentScheduledElapsedPeriods() view returns (uint16)",
  "function autoDistributionStart() view returns (uint64)",
  "function autoDistributionPeriodSeconds() view returns (uint64)",
  "function vestingPeriods() view returns (uint16)",
  "function setAutoDistributionSchedule(uint64 firstReleaseTime, uint64 periodSeconds)",
];

function env(name) {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

function parseBool(name, fallback = false) {
  const v = env(name);
  if (v === null) return fallback;
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}

function parseUint(name, fallback) {
  const v = env(name);
  if (v === null) return BigInt(fallback);
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be an unsigned integer`);
  return BigInt(v);
}

function checkedAddress(name, value) {
  if (!hre.ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return hre.ethers.getAddress(value);
}

function txUrl(hash) {
  return hash ? `${EXPLORER_BASE_URL}/tx/${hash}` : null;
}

function timestampInfo(ts) {
  const n = Number(ts);
  return {
    timestamp: ts.toString(),
    utc: new Date(n * 1000).toISOString(),
    beijing: new Date(n * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
  };
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");
  const presaleAddress = checkedAddress("PRESALE_ADDRESS", env("PRESALE_ADDRESS") || DEFAULT_PRESALE_ADDRESS);
  const periodSeconds = parseUint("AUTO_DISTRIBUTION_PERIOD_SECONDS", 86_400n);

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);
  }

  const presale = await hre.ethers.getContractAt(PRESALE_ABI, presaleAddress);
  const block = await hre.ethers.provider.getBlock("latest");
  const now = BigInt(block.timestamp);

  const [
    owner,
    paused,
    elapsed,
    scheduledBefore,
    autoStartBefore,
    autoPeriodBefore,
    vestingPeriods,
  ] = await Promise.all([
    presale.owner(),
    presale.paused(),
    presale.elapsedVestingPeriods(),
    presale.currentScheduledElapsedPeriods(),
    presale.autoDistributionStart(),
    presale.autoDistributionPeriodSeconds(),
    presale.vestingPeriods(),
  ]);

  if (elapsed === 0n) {
    throw new Error("elapsedVestingPeriods is 0; auto distribution has not started yet");
  }

  const newAutoStart = now - (BigInt(elapsed) - 1n) * periodSeconds;
  if (newAutoStart <= 0n) {
    throw new Error(`Computed autoDistributionStart ${newAutoStart} is invalid`);
  }

  const scheduledAfter = await (async () => {
    const elapsedAfterFirst =
      now > newAutoStart ? (now - newAutoStart) / periodSeconds : 0n;
    let target = 1n + elapsedAfterFirst;
    const maxElapsed = BigInt(vestingPeriods) + 1n;
    if (target > maxElapsed) target = maxElapsed;
    return target;
  })();

  let signerAddress = null;
  let txHash = null;

  if (execute) {
    const [signer] = await hre.ethers.getSigners();
    if (!signer) throw new Error("PRIVATE_KEY is required when EXECUTE=true");
    signerAddress = signer.address;
    if (hre.ethers.getAddress(signerAddress) !== hre.ethers.getAddress(owner)) {
      throw new Error(`Signer ${signerAddress} is not presale owner ${owner}`);
    }
    if (paused) throw new Error("Presale is paused");

    const tx = await presale.connect(signer).setAutoDistributionSchedule(newAutoStart, periodSeconds);
    console.log(`setAutoDistributionSchedule tx: ${tx.hash}`);
    await tx.wait(confirmations);
    txHash = tx.hash;
  }

  const [scheduledOnChain, autoStartAfter, autoPeriodAfter] = execute
    ? await Promise.all([
        presale.currentScheduledElapsedPeriods(),
        presale.autoDistributionStart(),
        presale.autoDistributionPeriodSeconds(),
      ])
    : [scheduledAfter, newAutoStart, periodSeconds];

  const result = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    signer: signerAddress,
    presale: presaleAddress,
    block: {
      number: block.number,
      timestamp: timestampInfo(now),
    },
    stateBefore: {
      elapsedVestingPeriods: elapsed.toString(),
      scheduledElapsedPeriods: scheduledBefore.toString(),
      autoDistributionStart: timestampInfo(autoStartBefore),
      autoDistributionPeriodSeconds: autoPeriodBefore.toString(),
    },
    update: {
      newAutoDistributionStart: timestampInfo(newAutoStart),
      autoDistributionPeriodSeconds: periodSeconds.toString(),
      scheduledElapsedAfter: scheduledOnChain.toString(),
      alignedWithElapsed: scheduledOnChain === elapsed,
      periodsRemainingToFull: (BigInt(vestingPeriods) + 1n - BigInt(elapsed)).toString(),
    },
    stateAfter: execute
      ? {
          autoDistributionStart: timestampInfo(autoStartAfter),
          autoDistributionPeriodSeconds: autoPeriodAfter.toString(),
          scheduledElapsedPeriods: scheduledOnChain.toString(),
        }
      : null,
    transactions: {
      setAutoDistributionSchedule: txUrl(txHash),
    },
  };

  console.log("BSC_MAINNET_AUTO_DISTRIBUTION_SCHEDULE_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_MAINNET_AUTO_DISTRIBUTION_SCHEDULE_RESULT_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
