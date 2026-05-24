const hre = require("hardhat");

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envUint(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const owner = process.env.PES_OWNER || deployer.address;
  const liquidityWallet = process.env.PES_LIQUIDITY_WALLET || owner;
  const operationsWallet = process.env.PES_OPERATIONS_WALLET || owner;
  const fundsWallet = process.env.PRESALE_FUNDS_WALLET || owner;

  const PESToken = await hre.ethers.getContractFactory("PESToken");
  const pes = await PESToken.deploy(owner, liquidityWallet, operationsWallet);
  await pes.waitForDeployment();

  console.log(`PESToken deployed: ${await pes.getAddress()}`);
  console.log(`Owner: ${owner}`);

  const usdtAddress = process.env.USDT_ADDRESS;
  if (!usdtAddress) {
    console.log("USDT_ADDRESS not set; skipping PESPresaleVesting deployment.");
    return;
  }

  const paymentDecimals = Number(envUint("PAYMENT_TOKEN_DECIMALS", "18"));
  const paymentPerPackage = hre.ethers.parseUnits(envUint("PAYMENT_PER_PACKAGE", "300"), paymentDecimals);
  const pesPerPackage = hre.ethers.parseUnits(envUint("PES_PER_PACKAGE", "3000"), 18);
  const maxPackages = BigInt(envUint("MAX_PACKAGES", "1000"));
  const publicPackageCap = BigInt(envUint("PUBLIC_PACKAGE_CAP", "1000"));
  const perWalletPackageLimit = BigInt(envUint("PER_WALLET_PACKAGE_LIMIT", "1"));
  const saleStart = BigInt(envUint("SALE_START", "0"));
  const saleEnd = BigInt(envUint("SALE_END", "0"));
  const launchTime = BigInt(envUint("LAUNCH_TIME", "0"));

  const Presale = await hre.ethers.getContractFactory("PESPresaleVesting");
  const presale = await Presale.deploy(
    await pes.getAddress(),
    requiredAddress("USDT_ADDRESS"),
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

  console.log(`PESPresaleVesting deployed: ${await presale.getAddress()}`);
  console.log("Transfer 3,000,000 PES to the presale contract before users claim.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

