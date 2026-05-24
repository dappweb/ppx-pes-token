const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const pes = (value) => ethers.parseUnits(value, 18);
const usdt = (value) => ethers.parseUnits(value, 18);
const DAY = 24 * 60 * 60;

describe("PESPresaleVesting", function () {
  async function deployFixture(options = {}) {
    const [owner, liquidityWallet, operationsWallet, fundsWallet, buyer, secondBuyer, strategicAccount] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("PESToken");
    const pesToken = await Token.deploy(owner.address, liquidityWallet.address, operationsWallet.address);
    await pesToken.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Mock USDT", "USDT", 18);
    await paymentToken.waitForDeployment();

    const latest = await time.latest();
    const saleStart = options.saleStart ?? latest - 10;
    const saleEnd = options.saleEnd ?? latest + 7 * DAY;
    const publicPackageCap = options.publicPackageCap ?? 2000;
    const perWalletPackageLimit = options.perWalletPackageLimit ?? 1;
    const launchTime = options.launchTime ?? 0;

    const Presale = await ethers.getContractFactory("PESPresaleVesting");
    const presale = await Presale.deploy(
      await pesToken.getAddress(),
      await paymentToken.getAddress(),
      owner.address,
      fundsWallet.address,
      usdt("300"),
      pes("3000"),
      2000,
      publicPackageCap,
      perWalletPackageLimit,
      saleStart,
      saleEnd,
      launchTime
    );
    await presale.waitForDeployment();

    await pesToken.transfer(await presale.getAddress(), pes("6000000"));
    await paymentToken.mint(buyer.address, usdt("30000"));
    await paymentToken.mint(secondBuyer.address, usdt("30000"));
    await paymentToken.connect(buyer).approve(await presale.getAddress(), usdt("30000"));
    await paymentToken.connect(secondBuyer).approve(await presale.getAddress(), usdt("30000"));

    return {
      owner,
      fundsWallet,
      buyer,
      secondBuyer,
      strategicAccount,
      pesToken,
      paymentToken,
      presale,
    };
  }

  it("sells packages for 300 USDT and records 3,000 PES per package", async function () {
    const { presale, paymentToken, fundsWallet, buyer } = await deployFixture();

    await expect(presale.connect(buyer).purchasePackages(1))
      .to.emit(presale, "PackagesPurchased")
      .withArgs(buyer.address, 1, usdt("300"), pes("3000"));

    const allocation = await presale.allocations(buyer.address);
    expect(allocation.packages).to.equal(1);
    expect(allocation.tokens).to.equal(pes("3000"));
    expect(await paymentToken.balanceOf(fundsWallet.address)).to.equal(usdt("300"));
    expect(await presale.publicPackagesSold()).to.equal(1);
  });

  it("limits each public wallet to one package", async function () {
    const { presale, buyer } = await deployFixture();

    await expect(presale.connect(buyer).purchasePackages(2)).to.be.revertedWithCustomError(
      presale,
      "PerWalletLimitExceeded"
    );

    await presale.connect(buyer).purchasePackages(1);

    await expect(presale.connect(buyer).purchasePackages(1)).to.be.revertedWithCustomError(
      presale,
      "PerWalletLimitExceeded"
    );
  });

  it("supports owner allocations while preserving the 2,000 package total cap", async function () {
    const { presale, buyer, secondBuyer, strategicAccount } = await deployFixture({ perWalletPackageLimit: 50 });

    await expect(presale.grantAllocation(strategicAccount.address, 1950))
      .to.emit(presale, "AdminAllocationGranted")
      .withArgs(strategicAccount.address, 1950, pes("5850000"));

    await presale.connect(buyer).purchasePackages(50);

    expect(await presale.totalPackagesAllocated()).to.equal(2000);
    expect(await presale.publicPackagesSold()).to.equal(50);

    await expect(presale.connect(secondBuyer).purchasePackages(1)).to.be.revertedWithCustomError(presale, "MaxPackageCapExceeded");

    await expect(presale.grantAllocation(strategicAccount.address, 1)).to.be.revertedWithCustomError(
      presale,
      "MaxPackageCapExceeded"
    );
  });

  it("vests from the configured elapsed period count", async function () {
    const { presale, pesToken, buyer } = await deployFixture();

    await presale.connect(buyer).purchasePackages(1);

    await expect(presale.connect(buyer).claim()).to.be.revertedWithCustomError(presale, "NoTokensClaimable");

    expect(await presale.claimableAmount(buyer.address)).to.equal(0);
    await expect(presale.connect(buyer).claim()).to.be.revertedWithCustomError(presale, "NoTokensClaimable");

    await expect(presale.setElapsedVestingPeriods(1))
      .to.emit(presale, "ElapsedVestingPeriodsUpdated")
      .withArgs(1);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("600"));

    await presale.connect(buyer).claim();
    expect(await pesToken.balanceOf(buyer.address)).to.equal(pes("600"));

    await presale.setElapsedVestingPeriods(2);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("60"));

    await presale.connect(buyer).claim();
    expect(await pesToken.balanceOf(buyer.address)).to.equal(pes("660"));

    await presale.setElapsedVestingPeriods(40);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("2280"));

    await presale.connect(buyer).claim();
    expect(await pesToken.balanceOf(buyer.address)).to.equal(pes("2940"));

    await presale.setElapsedVestingPeriods(41);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("60"));

    await presale.connect(buyer).claim();
    expect(await pesToken.balanceOf(buyer.address)).to.equal(pes("3000"));
    expect(await presale.claimableAmount(buyer.address)).to.equal(0);
  });

  it("lets the owner configure vesting period time, period count, and elapsed periods", async function () {
    const { presale, buyer } = await deployFixture();

    await presale.connect(buyer).purchasePackages(1);

    await expect(presale.setVestingConfigAndProgress(12 * 60 * 60, 8, 0))
      .to.emit(presale, "VestingConfigUpdated")
      .withArgs(12 * 60 * 60, 8);

    expect(await presale.claimableAmount(buyer.address)).to.equal(0);

    await presale.setElapsedVestingPeriods(1);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("600"));

    await presale.setElapsedVestingPeriods(2);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("900"));

    await presale.setElapsedVestingPeriods(8);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("2700"));

    await presale.setElapsedVestingPeriods(9);
    expect(await presale.claimableAmount(buyer.address)).to.equal(pes("3000"));
  });

  it("protects already allocated PES from owner recovery", async function () {
    const { presale, pesToken, buyer, fundsWallet } = await deployFixture();

    await presale.connect(buyer).purchasePackages(1);

    await expect(
      presale.recoverUnsupportedToken(await pesToken.getAddress(), fundsWallet.address, pes("5997001"))
    ).to.be.revertedWithCustomError(presale, "ReservedTokenRecovery");

    await expect(presale.recoverUnsupportedToken(await pesToken.getAddress(), fundsWallet.address, pes("5997000"))).not
      .to.be.reverted;
  });
});

