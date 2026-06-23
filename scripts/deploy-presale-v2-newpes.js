/**
 * Deploy a brand-new PESPresaleVestingUpgradeable proxy against the NEW PES token,
 * then call initializeV3 in the same script to wire keeper and auto-distribution schedule.
 *
 * Required env (when EXECUTE=true):
 *   PRIVATE_KEY                        owner key
 *   BSC_RPC_URL                        (optional)
 *   NEW_PES_ADDRESS                    default 0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41
 *   PAYMENT_TOKEN_ADDRESS              default BSC USDT 0x55d398326f99059fF775485246999027B3197955
 *   OWNER_ADDRESS                      default 0xAC25dA7FdEEEaDf2943EBF505Fa9739CBD111bD8
 *   FUNDS_WALLET                       default = OWNER_ADDRESS
 *   PAYMENT_PER_PACKAGE                default 300 (in USDT, 18 decimals)
 *   PES_PER_PACKAGE                    default 3000
 *   MAX_PACKAGES                       default 1000
 *   PUBLIC_PACKAGE_CAP                 default 0 (admin-grant only)
 *   PER_WALLET_PACKAGE_LIMIT           default 1
 *   KEEPER_ADDRESS                     default 0x7123A25d205190e6844712Cb18e39d6DD5316143
 *   FIRST_RELEASE_TIME                 default 2026-05-31T12:00:00+08:00
 *   AUTO_DISTRIBUTION_PERIOD_SECONDS   default 86400
 *   EXECUTE=true                       otherwise dry-run only
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULTS = {
  newPes: "0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41",
  payment: "0x55d398326f99059fF775485246999027B3197955",
  owner: "0xAC25dA7FdEEEaDf2943EBF505Fa9739CBD111bD8",
  keeper: "0x7123A25d205190e6844712Cb18e39d6DD5316143",
  firstReleaseIso: "2026-05-31T12:00:00+08:00",
};

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
function parseTimestamp(name, fbIso) {
  const v = env(name) || fbIso;
  if (/^\d+$/.test(v)) return BigInt(v);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be unix or ISO with tz`);
  return BigInt(Math.floor(ms / 1000));
}
function checkedAddress(name, v) {
  if (!hre.ethers.isAddress(v)) throw new Error(`${name} must be a valid address`);
  return hre.ethers.getAddress(v);
}
function txUrl(h) { return h ? `${EXPLORER_BASE_URL}/tx/${h}` : null; }
function addressUrl(a) { return `${EXPLORER_BASE_URL}/address/${a}`; }
function timestampInfo(value) {
  const ts = Number(value);
  if (ts === 0) return { timestamp: "0", utc: "0", beijing: "0" };
  const date = new Date(ts * 1000);
  const beijing = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
  return { timestamp: value.toString(), utc: date.toISOString(), beijing: `${beijing} +08:00` };
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);

  const newPesAddress = checkedAddress("NEW_PES_ADDRESS", env("NEW_PES_ADDRESS") || DEFAULTS.newPes);
  const paymentAddress = checkedAddress("PAYMENT_TOKEN_ADDRESS", env("PAYMENT_TOKEN_ADDRESS") || DEFAULTS.payment);
  const ownerAddress = checkedAddress("OWNER_ADDRESS", env("OWNER_ADDRESS") || DEFAULTS.owner);
  const fundsWallet = checkedAddress("FUNDS_WALLET", env("FUNDS_WALLET") || ownerAddress);
  const keeperAddress = checkedAddress("KEEPER_ADDRESS", env("KEEPER_ADDRESS") || DEFAULTS.keeper);

  const paymentPerPackage = hre.ethers.parseUnits(env("PAYMENT_PER_PACKAGE") || "300", 18);
  const pesPerPackage = hre.ethers.parseUnits(env("PES_PER_PACKAGE") || "3000", 18);
  const maxPackages = parseUint("MAX_PACKAGES", 1000n);
  const publicPackageCap = parseUint("PUBLIC_PACKAGE_CAP", 0n);
  const perWalletPackageLimit = parseUint("PER_WALLET_PACKAGE_LIMIT", 1n);

  const firstReleaseTime = parseTimestamp("FIRST_RELEASE_TIME", DEFAULTS.firstReleaseIso);
  const autoDistributionPeriodSeconds = parseUint("AUTO_DISTRIBUTION_PERIOD_SECONDS", 86_400n);

  const initParams = [
    newPesAddress,
    paymentAddress,
    ownerAddress,
    fundsWallet,
    paymentPerPackage,
    pesPerPackage,
    maxPackages,
    publicPackageCap,
    perWalletPackageLimit,
    0n, // saleStart  - admin-grant only
    0n, // saleEnd
    0n, // launchTime
  ];

  const plan = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    initParams: {
      pesToken: newPesAddress,
      paymentToken: paymentAddress,
      initialOwner: ownerAddress,
      fundsWallet,
      paymentPerPackage: hre.ethers.formatUnits(paymentPerPackage, 18),
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: maxPackages.toString(),
      publicPackageCap: publicPackageCap.toString(),
      perWalletPackageLimit: perWalletPackageLimit.toString(),
      saleStart: "0",
      saleEnd: "0",
      launchTime: "0",
    },
    initializeV3Params: {
      keeper: keeperAddress,
      manualClaimEnabled: false,
      firstReleaseTime: timestampInfo(firstReleaseTime),
      autoDistributionPeriodSeconds: autoDistributionPeriodSeconds.toString(),
    },
  };

  if (!execute) {
    console.log("DEPLOY_PRESALE_V2_NEWPES_PLAN_START");
    console.log(JSON.stringify(plan, null, 2));
    console.log("DEPLOY_PRESALE_V2_NEWPES_PLAN_END");
    return;
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("PRIVATE_KEY required");
  if (hre.ethers.getAddress(signer.address) !== ownerAddress) {
    throw new Error(`Signer ${signer.address} is not owner ${ownerAddress}`);
  }

  const Factory = await hre.ethers.getContractFactory("PESPresaleVestingUpgradeable");
  console.log("Deploying proxy...");
  const presale = await hre.upgrades.deployProxy(Factory, [initParams], {
    kind: "uups",
    redeployImplementation: "onchange",
  });
  await presale.waitForDeployment();
  const proxyAddress = await presale.getAddress();
  const implAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
  const deployTx = presale.deploymentTransaction();
  if (deployTx) await deployTx.wait(confirmations);
  console.log(`Proxy:          ${proxyAddress}`);
  console.log(`Implementation: ${implAddress}`);

  console.log("Calling initializeV3...");
  const tx = await presale.initializeV3(keeperAddress, false, firstReleaseTime, autoDistributionPeriodSeconds);
  console.log(`initializeV3 tx: ${tx.hash}`);
  await tx.wait(confirmations);

  const [
    ownerOnChain, pesToken, paymentToken, keeperOnChain, manualEnabled,
    autoStart, autoPeriod, vestingPeriods, totalAllocated, totalClaimed,
    elapsed, paused,
  ] = await Promise.all([
    presale.owner(), presale.pesToken(), presale.paymentToken(), presale.keeper(),
    presale.manualClaimEnabled(), presale.autoDistributionStart(),
    presale.autoDistributionPeriodSeconds(), presale.vestingPeriods(),
    presale.totalTokensAllocated(), presale.totalTokensClaimed(),
    presale.elapsedVestingPeriods(), presale.paused(),
  ]);

  const result = {
    ...plan,
    signer: signer.address,
    presaleVesting: {
      proxy: proxyAddress,
      implementation: implAddress,
      explorer: addressUrl(proxyAddress),
      implementationExplorer: addressUrl(implAddress),
      deploymentTx: deployTx ? txUrl(deployTx.hash) : null,
      initializeV3Tx: txUrl(tx.hash),
    },
    postDeployState: {
      owner: ownerOnChain,
      pesToken,
      paymentToken,
      keeper: keeperOnChain,
      manualClaimEnabled: manualEnabled,
      autoDistributionStart: timestampInfo(autoStart),
      autoDistributionPeriodSeconds: autoPeriod.toString(),
      vestingPeriods: vestingPeriods.toString(),
      totalTokensAllocated: hre.ethers.formatUnits(totalAllocated, 18),
      totalTokensClaimed: hre.ethers.formatUnits(totalClaimed, 18),
      elapsedVestingPeriods: elapsed.toString(),
      paused,
    },
    nextSteps: [
      `Run scripts/grant-allocations-newpes.js with PRESALE_ADDRESS=${proxyAddress}`,
      `Fund presale: PES_ADDRESS=${newPesAddress} PRESALE_ADDRESS=${proxyAddress} EXECUTE=true npx hardhat run scripts/fund-presale.js --network bsc`,
      `Update workers/pes-auto-distributor presale address to ${proxyAddress}`,
    ],
  };

  console.log("DEPLOY_PRESALE_V2_NEWPES_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("DEPLOY_PRESALE_V2_NEWPES_RESULT_END");

  const outputPath = path.join(process.cwd(), "deployments",
    `bsc-mainnet-presale-v2-newpes-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Deployment file: ${outputPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
