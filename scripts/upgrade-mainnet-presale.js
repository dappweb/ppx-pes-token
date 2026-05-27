const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULT_DEPLOYMENT_FILE = "deployments/bsc-mainnet-presale-config-2026-05-24.json";
const FALLBACK_PRESALE_ADDRESS = "0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd";
const DEFAULT_KEEPER_ADDRESS = "0x7123A25d205190e6844712Cb18e39d6DD5316143";
const DEFAULT_FIRST_RELEASE_TIME = "2026-05-29T00:10:00+08:00";
const DEFAULT_AUTO_DISTRIBUTION_PERIOD_SECONDS = 86_400n;

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function pesToken() view returns (address)",
  "function paymentToken() view returns (address)",
  "function maxPackages() view returns (uint256)",
  "function pesPerPackage() view returns (uint256)",
  "function totalTokensAllocated() view returns (uint256)",
  "function totalTokensClaimed() view returns (uint256)",
  "function unclaimedAllocatedTokens() view returns (uint256)",
  "function keeper() view returns (address)",
  "function manualClaimEnabled() view returns (bool)",
  "function autoDistributionStart() view returns (uint64)",
  "function autoDistributionPeriodSeconds() view returns (uint64)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
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

function parseTimestamp(name, fallbackIso) {
  const value = env(name) || fallbackIso;
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a Unix timestamp or ISO datetime with timezone`);
  }

  return BigInt(Math.floor(parsed / 1000));
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
  if (!hre.ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return hre.ethers.getAddress(value);
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
  return hre.ethers.formatUnits(amount, 18);
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error("CONFIRMATIONS must be a positive integer");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);
  }

  const deployment = readDeployment();
  const presaleAddress = checkedAddress(
    "PRESALE_ADDRESS",
    env("PRESALE_ADDRESS") || addressFromDeployment(deployment, "presaleVesting", FALLBACK_PRESALE_ADDRESS)
  );
  const keeperAddress = checkedAddress("KEEPER_ADDRESS", env("KEEPER_ADDRESS") || DEFAULT_KEEPER_ADDRESS);
  const manualClaimEnabled = parseBool("MANUAL_CLAIM_ENABLED", false);
  const firstReleaseTime = parseTimestamp("FIRST_RELEASE_TIME", DEFAULT_FIRST_RELEASE_TIME);
  const autoDistributionPeriodSeconds = parseUint(
    "AUTO_DISTRIBUTION_PERIOD_SECONDS",
    DEFAULT_AUTO_DISTRIBUTION_PERIOD_SECONDS
  );

  const PresaleV2 = await hre.ethers.getContractFactory("PESPresaleVestingUpgradeable");
  await hre.upgrades.validateUpgrade(presaleAddress, PresaleV2, { kind: "uups" });

  const presale = await hre.ethers.getContractAt(PRESALE_ABI, presaleAddress);
  const [
    owner,
    pesToken,
    paymentToken,
    maxPackages,
    pesPerPackage,
    totalTokensAllocated,
    totalTokensClaimed,
    unclaimedAllocatedTokens,
    currentImplementation,
  ] = await Promise.all([
    presale.owner(),
    presale.pesToken(),
    presale.paymentToken(),
    presale.maxPackages(),
    presale.pesPerPackage(),
    presale.totalTokensAllocated(),
    presale.totalTokensClaimed(),
    presale.unclaimedAllocatedTokens(),
    hre.upgrades.erc1967.getImplementationAddress(presaleAddress),
  ]);

  const currentV3State = {
    supported: false,
    keeper: null,
    manualClaimEnabled: null,
    autoDistributionStart: null,
    autoDistributionPeriodSeconds: null,
  };

  try {
    const [currentKeeper, currentManualClaimEnabled, currentAutoDistributionStart, currentAutoDistributionPeriodSeconds] =
      await Promise.all([
        presale.keeper(),
        presale.manualClaimEnabled(),
        presale.autoDistributionStart(),
        presale.autoDistributionPeriodSeconds(),
      ]);
    currentV3State.supported = true;
    currentV3State.keeper = currentKeeper;
    currentV3State.manualClaimEnabled = currentManualClaimEnabled;
    currentV3State.autoDistributionStart = currentAutoDistributionStart.toString();
    currentV3State.autoDistributionPeriodSeconds = currentAutoDistributionPeriodSeconds.toString();
  } catch {
    // Pre-V3 implementation does not expose auto-distribution state yet.
  }

  let signerAddress = null;
  let newImplementation = null;
  let txHash = null;

  if (execute) {
    const [signer] = await hre.ethers.getSigners();
    if (!signer) {
      throw new Error("PRIVATE_KEY is required when EXECUTE=true");
    }

    signerAddress = signer.address;
    if (hre.ethers.getAddress(signerAddress) !== hre.ethers.getAddress(owner)) {
      throw new Error(`Signer ${signerAddress} is not presale owner ${owner}`);
    }

    newImplementation = await hre.upgrades.prepareUpgrade(presaleAddress, PresaleV2, { kind: "uups" });
    const initData = PresaleV2.interface.encodeFunctionData("initializeV3", [
      keeperAddress,
      manualClaimEnabled,
      firstReleaseTime,
      autoDistributionPeriodSeconds,
    ]);
    const tx = await presale.connect(signer).upgradeToAndCall(newImplementation, initData);
    console.log(`upgradePresale tx: ${tx.hash}`);
    await tx.wait(confirmations);
    txHash = tx.hash;
  }

  const implementationAfter = await hre.upgrades.erc1967.getImplementationAddress(presaleAddress);
  const result = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    signer: signerAddress,
    storageValidation: "passed",
    presaleVesting: {
      proxy: presaleAddress,
      owner,
      explorer: addressUrl(presaleAddress),
      implementationBefore: currentImplementation,
      implementationAfter,
      newImplementation,
      newImplementationExplorer: newImplementation ? addressUrl(newImplementation) : null,
    },
    linkedContracts: {
      pesToken,
      paymentToken,
    },
    saleState: {
      maxPackages: maxPackages.toString(),
      pesPerPackage: formatPes(pesPerPackage),
      requiredFunding: formatPes(maxPackages * pesPerPackage),
      totalTokensAllocated: formatPes(totalTokensAllocated),
      totalTokensClaimed: formatPes(totalTokensClaimed),
      unclaimedAllocatedTokens: formatPes(unclaimedAllocatedTokens),
    },
    autoDistribution: {
      current: currentV3State,
      target: {
        keeper: keeperAddress,
        manualClaimEnabled,
        firstReleaseTime: timestampInfo(firstReleaseTime),
        periodSeconds: autoDistributionPeriodSeconds.toString(),
      },
    },
    transactions: {
      upgradePresale: txUrl(txHash),
    },
  };

  console.log("BSC_MAINNET_PRESALE_UPGRADE_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_MAINNET_PRESALE_UPGRADE_RESULT_END");

  if (execute) {
    const outputPath = path.join(
      process.cwd(),
      "deployments",
      `bsc-mainnet-presale-upgrade-${new Date().toISOString().slice(0, 10)}.json`
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
