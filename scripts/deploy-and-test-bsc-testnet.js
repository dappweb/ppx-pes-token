const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://testnet.bscscan.com";
const BPS_DENOMINATOR = 10_000n;
const ONE_DAY = 24n * 60n * 60n;

function txUrl(hash) {
  return `${EXPLORER_BASE_URL}/tx/${hash}`;
}

function addressUrl(address) {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

async function waitForTx(txPromise, label, confirmations) {
  const tx = await txPromise;
  const receipt = await tx.wait(confirmations);
  console.log(`${label}: ${tx.hash}`);
  return { hash: tx.hash, receipt };
}

async function deployContract(name, args, confirmations) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx) {
    await deploymentTx.wait(confirmations);
  }

  console.log(`${name} deployed: ${address}`);
  if (deploymentTx) {
    console.log(`${name} deployment tx: ${deploymentTx.hash}`);
  }

  return {
    contract,
    address,
    deploymentHash: deploymentTx ? deploymentTx.hash : null,
  };
}

async function expectRevert(txPromise, label) {
  try {
    const tx = await txPromise;
    await tx.wait();
  } catch {
    console.log(`${label}: reverted as expected`);
    return;
  }

  throw new Error(`${label}: expected revert`);
}

async function main() {
  const confirmations = Number(process.env.TESTNET_CONFIRMATIONS || "1");
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  assert.equal(network.chainId, 97n, "This script must run on BSC Testnet chainId 97");

  const deployerBalance = await provider.getBalance(deployer.address);
  console.log(`Network: bscTestnet (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer balance: ${hre.ethers.formatEther(deployerBalance)} tBNB`);

  const latestBlock = await provider.getBlock("latest");
  const now = BigInt(latestBlock.timestamp);
  const saleStart = now - 300n;
  const saleEnd = now + (7n * ONE_DAY);
  const launchTime = now - 1n;

  const paymentPerPackage = hre.ethers.parseUnits("300", 18);
  const pesPerPackage = hre.ethers.parseUnits("3000", 18);
  const presaleFundingAmount = hre.ethers.parseUnits("6000000", 18);

  const mockPayment = await deployContract("MockERC20", ["Mock USDT", "mUSDT", 18], confirmations);
  const pes = await deployContract(
    "PESToken",
    [deployer.address, deployer.address, deployer.address],
    confirmations
  );
  const presale = await deployContract(
    "PESPresaleVesting",
    [
      pes.address,
      mockPayment.address,
      deployer.address,
      deployer.address,
      paymentPerPackage,
      pesPerPackage,
      2000n,
      2000n,
      1n,
      saleStart,
      saleEnd,
      launchTime,
    ],
    confirmations
  );

  const fundPresaleTx = await waitForTx(
    pes.contract.transfer(presale.address, presaleFundingAmount),
    "Fund presale with 6,000,000 PES",
    confirmations
  );
  assert.equal(await pes.contract.balanceOf(presale.address), presaleFundingAmount);

  const buyer = new hre.ethers.Wallet(`0x${randomBytes(32).toString("hex")}`, provider);
  const fundBuyerTx = await waitForTx(
    deployer.sendTransaction({ to: buyer.address, value: hre.ethers.parseEther("0.03") }),
    "Fund smoke-test buyer gas",
    confirmations
  );

  const mintPaymentTx = await waitForTx(
    mockPayment.contract.mint(buyer.address, paymentPerPackage),
    "Mint 300 MockUSDT to buyer",
    confirmations
  );
  assert.equal(await mockPayment.contract.balanceOf(buyer.address), paymentPerPackage);

  const approveTx = await waitForTx(
    mockPayment.contract.connect(buyer).approve(presale.address, paymentPerPackage),
    "Buyer approve MockUSDT",
    confirmations
  );

  const purchaseTx = await waitForTx(
    presale.contract.connect(buyer).purchasePackages(1n),
    "Buyer purchase 1 PES package",
    confirmations
  );
  const allocation = await presale.contract.allocations(buyer.address);
  assert.equal(allocation.packages, 1n);
  assert.equal(allocation.tokens, pesPerPackage);

  const expectedInitialClaim = (pesPerPackage * 2000n) / BPS_DENOMINATOR;
  assert.equal(await presale.contract.claimableAmount(buyer.address), expectedInitialClaim);

  const claimTx = await waitForTx(
    presale.contract.connect(buyer).claim(),
    "Buyer claim initial release",
    confirmations
  );
  assert.equal(await pes.contract.balanceOf(buyer.address), expectedInitialClaim);

  const pairAddress = hre.ethers.Wallet.createRandom().address;
  const setPairTx = await waitForTx(
    pes.contract.setAutomatedMarketMakerPair(pairAddress, true),
    "Configure smoke-test AMM pair",
    confirmations
  );

  await expectRevert(
    pes.contract.connect(buyer).transfer(pairAddress, hre.ethers.parseUnits("1", 18)),
    "Trading disabled guard"
  );

  const enableTradingTx = await waitForTx(
    pes.contract.setTradingEnabled(true),
    "Enable trading",
    confirmations
  );

  const sellAmount = hre.ethers.parseUnits("100", 18);
  const expectedPairAmount = (sellAmount * 9850n) / BPS_DENOMINATOR;
  const expectedBurnAmount = (sellAmount * 50n) / BPS_DENOMINATOR;
  const expectedWalletFeeAmount = (sellAmount * 100n) / BPS_DENOMINATOR;
  const totalSupplyBeforeSell = await pes.contract.totalSupply();
  const ownerBalanceBeforeSell = await pes.contract.balanceOf(deployer.address);

  const sellTx = await waitForTx(
    pes.contract.connect(buyer).transfer(pairAddress, sellAmount),
    "Buyer sell transfer with 1.5% fee",
    confirmations
  );
  assert.equal(await pes.contract.balanceOf(pairAddress), expectedPairAmount);
  assert.equal(await pes.contract.totalSupply(), totalSupplyBeforeSell - expectedBurnAmount);
  assert.equal(
    (await pes.contract.balanceOf(deployer.address)) - ownerBalanceBeforeSell,
    expectedWalletFeeAmount
  );

  const result = {
    network: "bscTestnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    buyer: buyer.address,
    contracts: {
      mockPaymentToken: {
        address: mockPayment.address,
        explorer: addressUrl(mockPayment.address),
        deploymentTx: mockPayment.deploymentHash,
      },
      pesToken: {
        address: pes.address,
        explorer: addressUrl(pes.address),
        deploymentTx: pes.deploymentHash,
      },
      presaleVesting: {
        address: presale.address,
        explorer: addressUrl(presale.address),
        deploymentTx: presale.deploymentHash,
      },
    },
    saleConfig: {
      paymentPerPackage: hre.ethers.formatUnits(paymentPerPackage, 18),
      pesPerPackage: hre.ethers.formatUnits(pesPerPackage, 18),
      maxPackages: "2000",
      publicPackageCap: "2000",
      perWalletPackageLimit: "1",
      saleStart: saleStart.toString(),
      saleEnd: saleEnd.toString(),
      launchTime: launchTime.toString(),
    },
    smokeTest: {
      presaleFundedPES: hre.ethers.formatUnits(presaleFundingAmount, 18),
      buyerMockUSDT: hre.ethers.formatUnits(paymentPerPackage, 18),
      buyerPurchasedPackages: "1",
      buyerAllocatedPES: hre.ethers.formatUnits(pesPerPackage, 18),
      buyerInitialClaimedPES: hre.ethers.formatUnits(expectedInitialClaim, 18),
      tradingDisabledGuard: "passed",
      sellFeeTransfer: {
        soldPES: hre.ethers.formatUnits(sellAmount, 18),
        pairReceivedPES: hre.ethers.formatUnits(expectedPairAmount, 18),
        walletFeesPES: hre.ethers.formatUnits(expectedWalletFeeAmount, 18),
        burnedPES: hre.ethers.formatUnits(expectedBurnAmount, 18),
      },
    },
    transactions: {
      fundPresale: txUrl(fundPresaleTx.hash),
      fundBuyerGas: txUrl(fundBuyerTx.hash),
      mintPayment: txUrl(mintPaymentTx.hash),
      approvePayment: txUrl(approveTx.hash),
      purchasePackage: txUrl(purchaseTx.hash),
      claimInitialRelease: txUrl(claimTx.hash),
      setAmmPair: txUrl(setPairTx.hash),
      enableTrading: txUrl(enableTradingTx.hash),
      sellFeeTransfer: txUrl(sellTx.hash),
    },
  };

  console.log("BSC_TESTNET_DEPLOYMENT_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_TESTNET_DEPLOYMENT_RESULT_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
