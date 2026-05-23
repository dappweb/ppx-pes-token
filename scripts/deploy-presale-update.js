const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://testnet.bscscan.com";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
];

const OLD_PRESALE_ABI = [
  "function owner() view returns (address)",
  "function fundsWallet() view returns (address)",
  "function paymentPerPackage() view returns (uint256)",
  "function pesPerPackage() view returns (uint256)",
  "function maxPackages() view returns (uint256)",
  "function publicPackageCap() view returns (uint256)",
  "function perWalletPackageLimit() view returns (uint256)",
  "function saleStart() view returns (uint64)",
  "function saleEnd() view returns (uint64)",
  "function totalPackagesAllocated() view returns (uint256)",
];

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return hre.ethers.getAddress(value);
}

function optionalAddress(name, fallback) {
  const value = process.env[name];
  return value && hre.ethers.isAddress(value) ? hre.ethers.getAddress(value) : fallback;
}

function envBigInt(name, fallback) {
  const value = process.env[name];
  return BigInt(value === undefined || value === "" ? fallback : value);
}

function txUrl(hash) {
  return `${EXPLORER_BASE_URL}/tx/${hash}`;
}

function addressUrl(address) {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

async function waitForTx(txPromise, label, confirmations) {
  const tx = await txPromise;
  await tx.wait(confirmations);
  console.log(`${label}: ${tx.hash}`);
  return tx.hash;
}

async function main() {
  const confirmations = Number(process.env.TESTNET_CONFIRMATIONS || "1");
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== 97n) {
    throw new Error(`Expected BSC Testnet chainId 97, got ${network.chainId}`);
  }

  const pesAddress = requiredAddress("PES_ADDRESS");
  const paymentAddress = requiredAddress("USDT_ADDRESS");
  const oldPresaleAddress = optionalAddress("OLD_PRESALE_ADDRESS", null);
  const oldPresale = oldPresaleAddress
    ? new hre.ethers.Contract(oldPresaleAddress, OLD_PRESALE_ABI, provider)
    : null;

  const pes = new hre.ethers.Contract(pesAddress, ERC20_ABI, deployer);
  const paymentToken = new hre.ethers.Contract(paymentAddress, ERC20_ABI, provider);
  const [paymentSymbol, paymentDecimals] = await Promise.all([
    paymentToken.symbol(),
    paymentToken.decimals(),
  ]);

  const oldConfig = oldPresale
    ? await Promise.all([
        oldPresale.owner(),
        oldPresale.fundsWallet(),
        oldPresale.paymentPerPackage(),
        oldPresale.pesPerPackage(),
        oldPresale.maxPackages(),
        oldPresale.publicPackageCap(),
        oldPresale.perWalletPackageLimit(),
        oldPresale.saleStart(),
        oldPresale.saleEnd(),
        oldPresale.totalPackagesAllocated(),
      ])
    : null;

  const owner = optionalAddress("PES_OWNER", oldConfig?.[0] || deployer.address);
  const fundsWallet = optionalAddress("PRESALE_FUNDS_WALLET", oldConfig?.[1] || owner);
  const paymentPerPackage = envBigInt("PAYMENT_PER_PACKAGE_RAW", oldConfig?.[2] || hre.ethers.parseUnits("300", paymentDecimals));
  const pesPerPackage = envBigInt("PES_PER_PACKAGE_RAW", oldConfig?.[3] || hre.ethers.parseUnits("3000", 18));
  const maxPackages = envBigInt("MAX_PACKAGES", oldConfig?.[4] || 2000n);
  const publicPackageCap = envBigInt("PUBLIC_PACKAGE_CAP", oldConfig?.[5] || 2000n);
  const perWalletPackageLimit = envBigInt("PER_WALLET_PACKAGE_LIMIT", oldConfig?.[6] || 1n);
  const saleStart = envBigInt("SALE_START", oldConfig?.[7] || 0n);
  const saleEnd = envBigInt("SALE_END", oldConfig?.[8] || 0n);
  const launchTime = envBigInt("LAUNCH_TIME", "0");
  const presaleFundingAmount = hre.ethers.parseUnits(process.env.PRESALE_PES_AMOUNT || "6000000", 18);

  const deployerBnb = await provider.getBalance(deployer.address);
  const deployerPes = await pes.balanceOf(deployer.address);
  if (deployerPes < presaleFundingAmount) {
    throw new Error(
      `Deployer PES balance ${hre.ethers.formatUnits(deployerPes, 18)} is below funding amount ${hre.ethers.formatUnits(
        presaleFundingAmount,
        18
      )}`
    );
  }

  console.log(`Network: bscTestnet (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer BNB: ${hre.ethers.formatEther(deployerBnb)}`);
  console.log(`Deployer PES: ${hre.ethers.formatUnits(deployerPes, 18)}`);
  console.log(`PES: ${pesAddress}`);
  console.log(`Payment token: ${paymentAddress} (${paymentSymbol}, ${paymentDecimals} decimals)`);
  console.log(`Old presale: ${oldPresaleAddress || "none"}`);
  console.log(`New owner: ${owner}`);
  console.log(`Funds wallet: ${fundsWallet}`);
  console.log(`Launch time: ${launchTime}`);

  const Presale = await hre.ethers.getContractFactory("PESPresaleVesting");
  const presale = await Presale.deploy(
    pesAddress,
    paymentAddress,
    owner,
    fundsWallet,
    paymentPerPackage,
    pesPerPackage,
    maxPackages,
    publicPackageCap,
    perWalletPackageLimit,
    saleStart,
    saleEnd,
    launchTime
  );
  await presale.waitForDeployment();
  const presaleAddress = await presale.getAddress();
  const deploymentTx = presale.deploymentTransaction();
  if (deploymentTx) await deploymentTx.wait(confirmations);

  console.log(`PESPresaleVesting deployed: ${presaleAddress}`);
  if (deploymentTx) console.log(`PESPresaleVesting deployment tx: ${deploymentTx.hash}`);

  const fundPresaleHash = await waitForTx(
    pes.transfer(presaleAddress, presaleFundingAmount),
    "Fund new presale with PES",
    confirmations
  );

  const [vestingPeriodSeconds, vestingPeriods, fundedBalance] = await Promise.all([
    presale.vestingPeriodSeconds(),
    presale.vestingPeriods(),
    pes.balanceOf(presaleAddress),
  ]);

  const result = {
    runAt: new Date().toISOString(),
    network: "bscTestnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    oldPresale: oldPresaleAddress,
    contracts: {
      pesToken: {
        address: pesAddress,
        explorer: addressUrl(pesAddress),
      },
      paymentToken: {
        address: paymentAddress,
        symbol: paymentSymbol,
        decimals: paymentDecimals.toString(),
        explorer: addressUrl(paymentAddress),
      },
      presaleVesting: {
        address: presaleAddress,
        explorer: addressUrl(presaleAddress),
        deploymentTx: deploymentTx ? deploymentTx.hash : null,
      },
    },
    saleConfig: {
      paymentPerPackage: hre.ethers.formatUnits(paymentPerPackage, paymentDecimals),
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: maxPackages.toString(),
      publicPackageCap: publicPackageCap.toString(),
      perWalletPackageLimit: perWalletPackageLimit.toString(),
      saleStart: saleStart.toString(),
      saleEnd: saleEnd.toString(),
      launchTime: launchTime.toString(),
      vestingPeriodSeconds: vestingPeriodSeconds.toString(),
      vestingPeriods: vestingPeriods.toString(),
    },
    oldState: oldConfig
      ? {
          totalPackagesAllocated: oldConfig[9].toString(),
        }
      : null,
    postRunChainState: {
      presalePESBalance: hre.ethers.formatUnits(fundedBalance, 18),
    },
    transactions: {
      deployPresale: deploymentTx ? txUrl(deploymentTx.hash) : null,
      fundPresale: txUrl(fundPresaleHash),
    },
  };

  const outputPath = path.join(
    __dirname,
    "..",
    "deployments",
    `bsc-testnet-presale-update-${new Date().toISOString().slice(0, 10)}.json`
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("BSC_TESTNET_PRESALE_UPDATE_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_TESTNET_PRESALE_UPDATE_RESULT_END");
  console.log(`Deployment file: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
