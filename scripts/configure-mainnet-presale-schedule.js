const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
require("dotenv").config();

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULT_RPC_URL = "https://bsc-rpc.publicnode.com";
const DEFAULT_DEPLOYMENT_FILE = "deployments/bsc-mainnet-presale-config-2026-05-24.json";
const FALLBACK_PES_ADDRESS = "0xe83e750feEbe231c870DdF30165CbFE64F400Ebc";
const FALLBACK_PRESALE_ADDRESS = "0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd";

const DEFAULT_SALE_START = "2026-05-26T00:00:00+08:00";
const DEFAULT_SALE_END = "2026-05-28T15:00:00+08:00";
const DEFAULT_LAUNCH_TIME = DEFAULT_SALE_END;
const DEFAULT_FIRST_RELEASE_TIME = "2026-05-29T00:10:00+08:00";
const DEFAULT_VESTING_PERIOD_SECONDS = 86_400n;
const DEFAULT_VESTING_PERIODS = 40n;

const BPS_DENOMINATOR = 10_000n;
const INITIAL_RELEASE_BPS = 2_000n;

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function pesToken() view returns (address)",
  "function paymentToken() view returns (address)",
  "function fundsWallet() view returns (address)",
  "function paymentPerPackage() view returns (uint256)",
  "function pesPerPackage() view returns (uint256)",
  "function maxPackages() view returns (uint256)",
  "function publicPackageCap() view returns (uint256)",
  "function perWalletPackageLimit() view returns (uint256)",
  "function saleStart() view returns (uint64)",
  "function saleEnd() view returns (uint64)",
  "function launchTime() view returns (uint64)",
  "function vestingPeriodSeconds() view returns (uint64)",
  "function vestingPeriods() view returns (uint16)",
  "function elapsedVestingPeriods() view returns (uint16)",
  "function publicPackagesSold() view returns (uint256)",
  "function totalPackagesAllocated() view returns (uint256)",
  "function totalTokensAllocated() view returns (uint256)",
  "function totalTokensClaimed() view returns (uint256)",
  "function unclaimedAllocatedTokens() view returns (uint256)",
  "function setSaleWindow(uint64 newSaleStart, uint64 newSaleEnd)",
  "function setLaunchTime(uint64 newLaunchTime)",
  "function setVestingConfig(uint64 newVestingPeriodSeconds, uint16 newVestingPeriods)",
  "function setVestingConfigAndProgress(uint64 newVestingPeriodSeconds, uint16 newVestingPeriods, uint16 newElapsedVestingPeriods)",
];

const PES_ABI = [
  "function owner() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function tradingEnabled() view returns (bool)",
];

function env(name) {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function parseBool(name, fallback = false) {
  const value = env(name);
  if (value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function parseUint(name, fallback) {
  const value = env(name);
  if (value === null) return BigInt(fallback);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  return BigInt(value);
}

function parseOptionalUint(name) {
  const value = env(name);
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  return BigInt(value);
}

function parseTimestampValue(name, value) {
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a Unix timestamp or ISO datetime with timezone`);
  }
  return BigInt(Math.floor(parsed / 1000));
}

function parseScheduleTimestamp(scheduleName, legacyName, fallbackIso) {
  const scheduleValue = env(scheduleName);
  if (scheduleValue !== null) {
    return parseTimestampValue(scheduleName, scheduleValue);
  }

  const legacyValue = env(legacyName);
  if (legacyValue !== null && legacyValue !== "0") {
    return parseTimestampValue(legacyName, legacyValue);
  }

  return parseTimestampValue(scheduleName, fallbackIso);
}

function readDeployment() {
  const deploymentFile = env("DEPLOYMENT_FILE") || DEFAULT_DEPLOYMENT_FILE;
  const deploymentPath = path.resolve(process.cwd(), deploymentFile);
  if (!fs.existsSync(deploymentPath)) return null;
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
}

function addressFromDeployment(deployment, section, fallback) {
  return deployment?.contracts?.[section]?.proxy || deployment?.contracts?.[section]?.address || fallback;
}

function checkedAddress(name, value) {
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return ethers.getAddress(value);
}

function txUrl(hash) {
  return hash ? `${EXPLORER_BASE_URL}/tx/${hash}` : null;
}

function addressUrl(address) {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

function timestampInfo(value) {
  const timestamp = Number(value);
  if (timestamp === 0) {
    return { timestamp: "0", utc: "0", beijing: "0" };
  }

  const date = new Date(timestamp * 1000);
  const beijing = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  return {
    timestamp: value.toString(),
    utc: date.toISOString(),
    beijing: `${beijing} +08:00`,
  };
}

function formatPes(amount) {
  return ethers.formatUnits(amount, 18);
}

function plannedElapsedPeriods(blockTimestamp, firstReleaseTime, periodSeconds, vestingPeriods) {
  if (blockTimestamp < firstReleaseTime) return 0n;
  const elapsedAfterFirst = (blockTimestamp - firstReleaseTime) / periodSeconds;
  const elapsed = 1n + elapsedAfterFirst;
  const maxElapsed = vestingPeriods + 1n;
  return elapsed > maxElapsed ? maxElapsed : elapsed;
}

function bigintMin(a, b) {
  return a < b ? a : b;
}

async function maybeSend({ execute, confirmations, label, current, target, txs, send }) {
  if (current === target) return;

  console.log(`${label}: ${current.toString()} -> ${target.toString()}`);
  if (!execute) return;

  const tx = await send();
  console.log(`${label} tx: ${tx.hash}`);
  await tx.wait(confirmations);
  txs[label] = tx.hash;
}

async function main() {
  const deployment = readDeployment();
  const rpcUrl = env("BSC_RPC_URL") || env("VITE_READ_RPC_URL") || DEFAULT_RPC_URL;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);
  }

  const block = await provider.getBlock("latest");
  const blockTimestamp = BigInt(block.timestamp);
  const pesAddress = checkedAddress(
    "PES_ADDRESS",
    env("PES_ADDRESS") || addressFromDeployment(deployment, "pesToken", FALLBACK_PES_ADDRESS)
  );
  const presaleAddress = checkedAddress(
    "PRESALE_ADDRESS",
    env("PRESALE_ADDRESS") || addressFromDeployment(deployment, "presaleVesting", FALLBACK_PRESALE_ADDRESS)
  );

  const saleStart = parseScheduleTimestamp("SCHEDULE_SALE_START", "SALE_START", DEFAULT_SALE_START);
  const saleEnd = parseScheduleTimestamp("SCHEDULE_SALE_END", "SALE_END", DEFAULT_SALE_END);
  const launchTime = parseScheduleTimestamp("SCHEDULE_LAUNCH_TIME", "LAUNCH_TIME", DEFAULT_LAUNCH_TIME);
  const firstReleaseTime = parseScheduleTimestamp(
    "FIRST_RELEASE_TIME",
    "FIRST_RELEASE_AT",
    DEFAULT_FIRST_RELEASE_TIME
  );
  const vestingPeriodSeconds = parseUint("VESTING_PERIOD_SECONDS", DEFAULT_VESTING_PERIOD_SECONDS);
  const vestingPeriods = parseUint("VESTING_PERIODS", DEFAULT_VESTING_PERIODS);
  const elapsedOverride = parseOptionalUint("ELAPSED_VESTING_PERIODS");
  const allowElapsedDecrease = parseBool("ALLOW_ELAPSED_DECREASE", false);
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");

  if (saleStart === 0n || saleEnd <= saleStart) {
    throw new Error("Sale window is invalid");
  }
  if (firstReleaseTime < launchTime) {
    throw new Error("FIRST_RELEASE_TIME must be greater than or equal to SCHEDULE_LAUNCH_TIME");
  }
  if (vestingPeriodSeconds === 0n || vestingPeriods === 0n) {
    throw new Error("Vesting period values must be nonzero");
  }
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error("CONFIRMATIONS must be a positive integer");
  }
  if (vestingPeriods > BigInt(Number.MAX_SAFE_INTEGER - 1)) {
    throw new Error("VESTING_PERIODS is too large");
  }

  const presaleReader = new ethers.Contract(presaleAddress, PRESALE_ABI, provider);
  const pesReader = new ethers.Contract(pesAddress, PES_ABI, provider);

  const [
    owner,
    tokenOwner,
    paused,
    tradingEnabled,
    currentPesToken,
    paymentToken,
    fundsWallet,
    paymentPerPackage,
    pesPerPackage,
    maxPackages,
    publicPackageCap,
    perWalletPackageLimit,
    currentSaleStart,
    currentSaleEnd,
    currentLaunchTime,
    currentVestingPeriodSeconds,
    currentVestingPeriods,
    currentElapsedVestingPeriods,
    publicPackagesSold,
    totalPackagesAllocated,
    totalTokensAllocated,
    totalTokensClaimed,
    unclaimedAllocatedTokens,
    presalePesBalance,
  ] = await Promise.all([
    presaleReader.owner(),
    pesReader.owner(),
    presaleReader.paused(),
    pesReader.tradingEnabled(),
    presaleReader.pesToken(),
    presaleReader.paymentToken(),
    presaleReader.fundsWallet(),
    presaleReader.paymentPerPackage(),
    presaleReader.pesPerPackage(),
    presaleReader.maxPackages(),
    presaleReader.publicPackageCap(),
    presaleReader.perWalletPackageLimit(),
    presaleReader.saleStart(),
    presaleReader.saleEnd(),
    presaleReader.launchTime(),
    presaleReader.vestingPeriodSeconds(),
    presaleReader.vestingPeriods(),
    presaleReader.elapsedVestingPeriods(),
    presaleReader.publicPackagesSold(),
    presaleReader.totalPackagesAllocated(),
    presaleReader.totalTokensAllocated(),
    presaleReader.totalTokensClaimed(),
    presaleReader.unclaimedAllocatedTokens(),
    pesReader.balanceOf(presaleAddress),
  ]);

  if (ethers.getAddress(currentPesToken) !== pesAddress) {
    throw new Error(`Presale pesToken ${currentPesToken} does not match PES_ADDRESS ${pesAddress}`);
  }

  const plannedElapsed = elapsedOverride ?? plannedElapsedPeriods(
    blockTimestamp,
    firstReleaseTime,
    vestingPeriodSeconds,
    vestingPeriods
  );
  const maxElapsed = vestingPeriods + 1n;
  let targetElapsed = bigintMin(plannedElapsed, maxElapsed);

  if (targetElapsed < currentElapsedVestingPeriods) {
    if (!allowElapsedDecrease) {
      targetElapsed = currentElapsedVestingPeriods;
    }
  }

  if (currentLaunchTime !== 0n && blockTimestamp >= currentLaunchTime && currentLaunchTime !== launchTime) {
    throw new Error("Current launchTime is already in the past and cannot be changed by the contract");
  }

  const firstReleasePerPackage = (pesPerPackage * INITIAL_RELEASE_BPS) / BPS_DENOMINATOR;
  const dailyReleasePerPackage =
    (pesPerPackage * (BPS_DENOMINATOR - INITIAL_RELEASE_BPS)) / BPS_DENOMINATOR / vestingPeriods;
  const fullReleaseTime = firstReleaseTime + vestingPeriodSeconds * vestingPeriods;

  let signer = null;
  let presaleWriter = null;
  if (execute) {
    const privateKey = env("PRIVATE_KEY");
    if (!privateKey) {
      throw new Error("PRIVATE_KEY is required when EXECUTE=true");
    }

    signer = new ethers.Wallet(privateKey, provider);
    if (ethers.getAddress(signer.address) !== ethers.getAddress(owner)) {
      throw new Error(`Signer ${signer.address} is not presale owner ${owner}`);
    }
    presaleWriter = presaleReader.connect(signer);
  }

  const txs = {};
  console.log(`Mode: ${execute ? "execute" : "dry-run"}`);
  console.log(`Network: bsc (${network.chainId}) block ${block.number} ${timestampInfo(blockTimestamp).beijing}`);
  console.log(`Presale: ${presaleAddress}`);
  console.log(`PES: ${pesAddress}`);
  console.log(`Owner: ${owner}`);
  if (signer) console.log(`Signer: ${signer.address}`);

  if (currentSaleStart !== saleStart || currentSaleEnd !== saleEnd) {
    console.log(
      `setSaleWindow: ${currentSaleStart.toString()}/${currentSaleEnd.toString()} -> ${saleStart.toString()}/${saleEnd.toString()}`
    );
    if (execute) {
      const tx = await presaleWriter.setSaleWindow(saleStart, saleEnd);
      console.log(`setSaleWindow tx: ${tx.hash}`);
      await tx.wait(confirmations);
      txs.setSaleWindow = tx.hash;
    }
  }

  await maybeSend({
    execute,
    confirmations,
    label: "setLaunchTime",
    current: currentLaunchTime,
    target: launchTime,
    txs,
    send: () => presaleWriter.setLaunchTime(launchTime),
  });

  const needsVestingConfig =
    currentVestingPeriodSeconds !== vestingPeriodSeconds ||
    BigInt(currentVestingPeriods) !== vestingPeriods ||
    BigInt(currentElapsedVestingPeriods) !== targetElapsed;

  if (needsVestingConfig) {
    console.log(
      `setVestingConfigAndProgress: ${currentVestingPeriodSeconds.toString()}/${currentVestingPeriods.toString()}/${currentElapsedVestingPeriods.toString()} -> ${vestingPeriodSeconds.toString()}/${vestingPeriods.toString()}/${targetElapsed.toString()}`
    );
    if (execute) {
      const tx = await presaleWriter.setVestingConfigAndProgress(
        vestingPeriodSeconds,
        Number(vestingPeriods),
        Number(targetElapsed)
      );
      console.log(`setVestingConfigAndProgress tx: ${tx.hash}`);
      await tx.wait(confirmations);
      txs.setVestingConfigAndProgress = tx.hash;
    }
  }

  const result = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    blockNumber: block.number,
    blockTime: timestampInfo(blockTimestamp),
    contracts: {
      pesToken: {
        proxy: pesAddress,
        owner: tokenOwner,
        explorer: addressUrl(pesAddress),
      },
      presaleVesting: {
        proxy: presaleAddress,
        owner,
        explorer: addressUrl(presaleAddress),
      },
      paymentToken,
    },
    currentState: {
      paused,
      tradingEnabled,
      fundsWallet,
      paymentPerPackage: ethers.formatUnits(paymentPerPackage, 18),
      pesPerPackage: formatPes(pesPerPackage),
      maxPackages: maxPackages.toString(),
      publicPackageCap: publicPackageCap.toString(),
      perWalletPackageLimit: perWalletPackageLimit.toString(),
      saleStart: timestampInfo(currentSaleStart),
      saleEnd: timestampInfo(currentSaleEnd),
      launchTime: timestampInfo(currentLaunchTime),
      vestingPeriodSeconds: currentVestingPeriodSeconds.toString(),
      vestingPeriods: currentVestingPeriods.toString(),
      elapsedVestingPeriods: currentElapsedVestingPeriods.toString(),
      publicPackagesSold: publicPackagesSold.toString(),
      totalPackagesAllocated: totalPackagesAllocated.toString(),
      totalTokensAllocated: formatPes(totalTokensAllocated),
      totalTokensClaimed: formatPes(totalTokensClaimed),
      unclaimedAllocatedTokens: formatPes(unclaimedAllocatedTokens),
      presalePesBalance: formatPes(presalePesBalance),
    },
    targetSchedule: {
      saleStart: timestampInfo(saleStart),
      saleEnd: timestampInfo(saleEnd),
      launchTime: timestampInfo(launchTime),
      firstReleaseTime: timestampInfo(firstReleaseTime),
      fullReleaseTime: timestampInfo(fullReleaseTime),
      vestingPeriodSeconds: vestingPeriodSeconds.toString(),
      vestingPeriods: vestingPeriods.toString(),
      elapsedVestingPeriods: targetElapsed.toString(),
      firstReleasePerPackagePES: formatPes(firstReleasePerPackage),
      dailyReleaseAfterFirstPerPackagePES: formatPes(dailyReleasePerPackage),
    },
    transactions: {
      setSaleWindow: txUrl(txs.setSaleWindow),
      setLaunchTime: txUrl(txs.setLaunchTime),
      setVestingConfigAndProgress: txUrl(txs.setVestingConfigAndProgress),
    },
  };

  console.log("BSC_MAINNET_PRESALE_SCHEDULE_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_MAINNET_PRESALE_SCHEDULE_RESULT_END");

  if (execute) {
    const outputPath = path.join(
      process.cwd(),
      "deployments",
      `bsc-mainnet-presale-schedule-${new Date().toISOString().slice(0, 10)}.json`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Deployment file: ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
