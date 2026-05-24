const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://testnet.bscscan.com";
const BPS_DENOMINATOR = 10_000n;
const ONE_DAY = 24n * 60n * 60n;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

function requiredAddress(name) {
  const value = process.env[name];
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
  assert.equal(network.chainId, 97n, "This script must run on BSC Testnet chainId 97");

  const pesAddress = requiredAddress("PES_ADDRESS");
  const paymentAddress = requiredAddress("USDT_ADDRESS");
  const owner = process.env.PES_OWNER && hre.ethers.isAddress(process.env.PES_OWNER)
    ? hre.ethers.getAddress(process.env.PES_OWNER)
    : deployer.address;
  const fundsWallet =
    process.env.PRESALE_FUNDS_WALLET && hre.ethers.isAddress(process.env.PRESALE_FUNDS_WALLET)
      ? hre.ethers.getAddress(process.env.PRESALE_FUNDS_WALLET)
      : owner;

  const paymentToken = new hre.ethers.Contract(paymentAddress, ERC20_ABI, deployer);
  const [paymentSymbol, paymentDecimals] = await Promise.all([
    paymentToken.symbol(),
    paymentToken.decimals(),
  ]);

  const paymentPerPackage = hre.ethers.parseUnits(envUint("PAYMENT_PER_PACKAGE", "300"), paymentDecimals);
  const pesPerPackage = hre.ethers.parseUnits(envUint("PES_PER_PACKAGE", "3000"), 18);
  const presaleFundingAmount = hre.ethers.parseUnits(envUint("PRESALE_PES_AMOUNT", "3000000"), 18);
  const maxPackages = BigInt(envUint("MAX_PACKAGES", "1000"));
  const publicPackageCap = BigInt(envUint("PUBLIC_PACKAGE_CAP", "1000"));
  const perWalletPackageLimit = BigInt(envUint("PER_WALLET_PACKAGE_LIMIT", "1"));

  const latestBlock = await provider.getBlock("latest");
  const now = BigInt(latestBlock.timestamp);
  const saleStart = BigInt(envUint("SALE_START", (now - 300n).toString()));
  const saleEnd = BigInt(envUint("SALE_END", (now + (7n * ONE_DAY)).toString()));
  const launchTime = BigInt(envUint("LAUNCH_TIME", (now - ONE_DAY).toString()));

  console.log(`Network: bscTestnet (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`PES: ${pesAddress}`);
  console.log(`Payment token: ${paymentAddress} (${paymentSymbol}, ${paymentDecimals} decimals)`);

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
  if (deploymentTx) {
    await deploymentTx.wait(confirmations);
  }
  console.log(`PESPresaleVesting deployed: ${presaleAddress}`);
  if (deploymentTx) {
    console.log(`PESPresaleVesting deployment tx: ${deploymentTx.hash}`);
  }

  const pes = await hre.ethers.getContractAt("PESToken", pesAddress);
  const fundPresaleHash = await waitForTx(
    pes.transfer(presaleAddress, presaleFundingAmount),
    "Fund new presale with PES",
    confirmations
  );

  const buyer = new hre.ethers.Wallet(`0x${randomBytes(32).toString("hex")}`, provider);
  const fundBuyerGasHash = await waitForTx(
    deployer.sendTransaction({ to: buyer.address, value: hre.ethers.parseEther("0.03") }),
    "Fund smoke-test buyer gas",
    confirmations
  );
  const transferPaymentHash = await waitForTx(
    paymentToken.transfer(buyer.address, paymentPerPackage),
    `Transfer ${envUint("PAYMENT_PER_PACKAGE", "300")} ${paymentSymbol} to buyer`,
    confirmations
  );

  const buyerPayment = paymentToken.connect(buyer);
  const approveHash = await waitForTx(
    buyerPayment.approve(presaleAddress, paymentPerPackage),
    `Buyer approve ${paymentSymbol}`,
    confirmations
  );
  const purchaseHash = await waitForTx(
    presale.connect(buyer).purchasePackages(1n),
    "Buyer purchase 1 PES package",
    confirmations
  );

  const allocation = await presale.allocations(buyer.address);
  assert.equal(allocation.packages, 1n);
  assert.equal(allocation.tokens, pesPerPackage);
  assert.equal(await paymentToken.balanceOf(buyer.address), 0n);

  await waitForTx(
    presale.setElapsedVestingPeriods(1),
    "Set elapsed vesting periods for initial claim smoke test",
    confirmations
  );

  const expectedInitialClaim = (pesPerPackage * 2000n) / BPS_DENOMINATOR;
  assert.equal(await presale.claimableAmount(buyer.address), expectedInitialClaim);

  const claimHash = await waitForTx(
    presale.connect(buyer).claim(),
    "Buyer claim first-day release",
    confirmations
  );
  assert.equal(await pes.balanceOf(buyer.address), expectedInitialClaim);

  const result = {
    network: "bscTestnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    buyer: buyer.address,
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
    saleConfig: {
      paymentPerPackage: hre.ethers.formatUnits(paymentPerPackage, paymentDecimals),
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: maxPackages.toString(),
      publicPackageCap: publicPackageCap.toString(),
      perWalletPackageLimit: perWalletPackageLimit.toString(),
      saleStart: saleStart.toString(),
      saleEnd: saleEnd.toString(),
      launchTime: launchTime.toString(),
    },
    smokeTest: {
      presaleFundedPES: hre.ethers.formatUnits(presaleFundingAmount, 18),
      buyerPaymentReceived: hre.ethers.formatUnits(paymentPerPackage, paymentDecimals),
      buyerPurchasedPackages: "1",
      buyerAllocatedPES: hre.ethers.formatUnits(pesPerPackage, 18),
      buyerInitialClaimedPES: hre.ethers.formatUnits(expectedInitialClaim, 18),
    },
    transactions: {
      deployPresale: deploymentTx ? txUrl(deploymentTx.hash) : null,
      fundPresale: txUrl(fundPresaleHash),
      fundBuyerGas: txUrl(fundBuyerGasHash),
      transferPayment: txUrl(transferPaymentHash),
      approvePayment: txUrl(approveHash),
      purchasePackage: txUrl(purchaseHash),
      claimInitialRelease: txUrl(claimHash),
    },
  };

  console.log("BSC_TESTNET_PAYMENT_PRESALE_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_TESTNET_PAYMENT_PRESALE_RESULT_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
