const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const BSC_MAINNET_USDT = "0x55d398326f99059fF775485246999027B3197955";

function envAddress(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return hre.ethers.getAddress(value);
}

function envUint(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function txUrl(hash) {
  return hash ? `${EXPLORER_BASE_URL}/tx/${hash}` : null;
}

function addressUrl(address) {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

async function deploymentTxHash(contract) {
  const tx = contract.deploymentTransaction?.();
  return tx?.hash || null;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);
  }

  const owner = envAddress("PES_OWNER", deployer.address);
  const liquidityWallet = envAddress("PES_LIQUIDITY_WALLET", owner);
  const operationsWallet = envAddress("PES_OPERATIONS_WALLET", owner);
  const fundsWallet = envAddress("PRESALE_FUNDS_WALLET", owner);
  const paymentTokenAddress = envAddress("USDT_ADDRESS", BSC_MAINNET_USDT);
  const paymentToken = await hre.ethers.getContractAt(
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    paymentTokenAddress
  );
  const [paymentSymbol, paymentDecimals] = await Promise.all([paymentToken.symbol(), paymentToken.decimals()]);

  const paymentPerPackage = hre.ethers.parseUnits(envUint("PAYMENT_PER_PACKAGE", "300"), Number(paymentDecimals));
  const pesPerPackage = hre.ethers.parseUnits(envUint("PES_PER_PACKAGE", "3000"), 18);
  const maxPackages = BigInt(envUint("MAX_PACKAGES", "2000"));
  const publicPackageCap = BigInt(envUint("PUBLIC_PACKAGE_CAP", "2000"));
  const perWalletPackageLimit = BigInt(envUint("PER_WALLET_PACKAGE_LIMIT", "1"));
  const saleStart = BigInt(envUint("SALE_START", "0"));
  const saleEnd = BigInt(envUint("SALE_END", "0"));
  const launchTime = BigInt(envUint("LAUNCH_TIME", "0"));

  const deployerBnbBefore = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Network: bsc (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Owner: ${owner}`);
  console.log(`Deployer BNB before: ${hre.ethers.formatEther(deployerBnbBefore)}`);
  console.log(`Payment token: ${paymentTokenAddress} (${paymentSymbol}, ${paymentDecimals} decimals)`);

  const PESTokenUpgradeable = await hre.ethers.getContractFactory("PESTokenUpgradeable");
  const pes = await hre.upgrades.deployProxy(
    PESTokenUpgradeable,
    [owner, liquidityWallet, operationsWallet],
    { kind: "uups" }
  );
  await pes.waitForDeployment();
  const pesAddress = await pes.getAddress();
  const pesImplementation = await hre.upgrades.erc1967.getImplementationAddress(pesAddress);
  const pesDeploymentTx = await deploymentTxHash(pes);

  console.log(`PESTokenUpgradeable proxy: ${pesAddress}`);
  console.log(`PESTokenUpgradeable implementation: ${pesImplementation}`);
  if (pesDeploymentTx) console.log(`PESTokenUpgradeable proxy tx: ${pesDeploymentTx}`);

  const PESPresaleVestingUpgradeable = await hre.ethers.getContractFactory("PESPresaleVestingUpgradeable");
  const presale = await hre.upgrades.deployProxy(
    PESPresaleVestingUpgradeable,
    [
      [
        pesAddress,
        paymentTokenAddress,
        owner,
        fundsWallet,
        paymentPerPackage,
        pesPerPackage,
        maxPackages,
        publicPackageCap,
        perWalletPackageLimit,
        saleStart,
        saleEnd,
        launchTime,
      ],
    ],
    { kind: "uups" }
  );
  await presale.waitForDeployment();
  const presaleAddress = await presale.getAddress();
  const presaleImplementation = await hre.upgrades.erc1967.getImplementationAddress(presaleAddress);
  const presaleDeploymentTx = await deploymentTxHash(presale);

  console.log(`PESPresaleVestingUpgradeable proxy: ${presaleAddress}`);
  console.log(`PESPresaleVestingUpgradeable implementation: ${presaleImplementation}`);
  if (presaleDeploymentTx) console.log(`PESPresaleVestingUpgradeable proxy tx: ${presaleDeploymentTx}`);

  const [ownerPesBalance, totalSupply, presalePesBalance, elapsedVestingPeriods, deployerBnbAfter] = await Promise.all([
    pes.balanceOf(owner),
    pes.totalSupply(),
    pes.balanceOf(presaleAddress),
    presale.elapsedVestingPeriods(),
    hre.ethers.provider.getBalance(deployer.address),
  ]);

  const result = {
    runAt: new Date().toISOString(),
    network: "bsc",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    owner,
    proxyKind: "uups",
    contracts: {
      pesToken: {
        proxy: pesAddress,
        implementation: pesImplementation,
        explorer: addressUrl(pesAddress),
        implementationExplorer: addressUrl(pesImplementation),
        deploymentTx: pesDeploymentTx,
      },
      paymentToken: {
        address: paymentTokenAddress,
        symbol: paymentSymbol,
        decimals: paymentDecimals.toString(),
        explorer: addressUrl(paymentTokenAddress),
      },
      presaleVesting: {
        proxy: presaleAddress,
        implementation: presaleImplementation,
        explorer: addressUrl(presaleAddress),
        implementationExplorer: addressUrl(presaleImplementation),
        deploymentTx: presaleDeploymentTx,
      },
    },
    tokenState: {
      totalSupply: hre.ethers.formatUnits(totalSupply, 18),
      ownerPesBalance: hre.ethers.formatUnits(ownerPesBalance, 18),
      presalePesBalance: hre.ethers.formatUnits(presalePesBalance, 18),
      liquidityWallet,
      operationsWallet,
    },
    saleConfig: {
      fundsWallet,
      paymentPerPackage: hre.ethers.formatUnits(paymentPerPackage, Number(paymentDecimals)),
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: maxPackages.toString(),
      publicPackageCap: publicPackageCap.toString(),
      perWalletPackageLimit: perWalletPackageLimit.toString(),
      saleStart: saleStart.toString(),
      saleEnd: saleEnd.toString(),
      launchTime: launchTime.toString(),
      vestingPeriodSeconds: (await presale.vestingPeriodSeconds()).toString(),
      vestingPeriods: (await presale.vestingPeriods()).toString(),
      elapsedVestingPeriods: elapsedVestingPeriods.toString(),
    },
    deployerBnb: {
      before: hre.ethers.formatEther(deployerBnbBefore),
      after: hre.ethers.formatEther(deployerBnbAfter),
      spent: hre.ethers.formatEther(deployerBnbBefore - deployerBnbAfter),
    },
    transactions: {
      deployPesProxy: txUrl(pesDeploymentTx),
      deployPresaleProxy: txUrl(presaleDeploymentTx),
    },
  };

  const outputPath = path.join(
    __dirname,
    "..",
    "deployments",
    `bsc-mainnet-upgradeable-${new Date().toISOString().slice(0, 10)}.json`
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("BSC_MAINNET_UPGRADEABLE_DEPLOY_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_MAINNET_UPGRADEABLE_DEPLOY_RESULT_END");
  console.log(`Deployment file: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
