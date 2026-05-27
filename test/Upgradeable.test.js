const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Upgradeable PES contracts", function () {
  const DAY = 24 * 60 * 60;

  async function deployPaymentToken(owner) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Mock USDT", "USDT", 18);
    await paymentToken.waitForDeployment();
    await paymentToken.mint(owner.address, ethers.parseUnits("1000000", 18));
    return paymentToken;
  }

  it("deploys PES behind a UUPS proxy and keeps supply in owner", async function () {
    const [owner] = await ethers.getSigners();
    const PESTokenUpgradeable = await ethers.getContractFactory("PESTokenUpgradeable");

    const pes = await upgrades.deployProxy(PESTokenUpgradeable, [owner.address, owner.address, owner.address], {
      kind: "uups",
    });
    await pes.waitForDeployment();

    expect(await pes.owner()).to.equal(owner.address);
    expect(await pes.balanceOf(owner.address)).to.equal(ethers.parseUnits("21000000", 18));

    const implementation = await upgrades.erc1967.getImplementationAddress(await pes.getAddress());
    expect(implementation).to.not.equal(ethers.ZeroAddress);

    const PESTokenUpgradeableV2Mock = await ethers.getContractFactory("PESTokenUpgradeableV2Mock");
    const upgraded = await upgrades.upgradeProxy(await pes.getAddress(), PESTokenUpgradeableV2Mock);
    expect(await upgraded.version()).to.equal("v2");
    expect(await upgraded.balanceOf(owner.address)).to.equal(ethers.parseUnits("21000000", 18));
  });

  it("deploys presale behind a UUPS proxy with elapsed-period vesting", async function () {
    const [owner, buyer] = await ethers.getSigners();
    const paymentToken = await deployPaymentToken(owner);

    const PESTokenUpgradeable = await ethers.getContractFactory("PESTokenUpgradeable");
    const pes = await upgrades.deployProxy(PESTokenUpgradeable, [owner.address, owner.address, owner.address], {
      kind: "uups",
    });
    await pes.waitForDeployment();

    const PESPresaleVestingUpgradeable = await ethers.getContractFactory("PESPresaleVestingUpgradeable");
    const presale = await upgrades.deployProxy(
      PESPresaleVestingUpgradeable,
      [
        [
          await pes.getAddress(),
          await paymentToken.getAddress(),
          owner.address,
          owner.address,
          ethers.parseUnits("300", 18),
          ethers.parseUnits("3000", 18),
          1000n,
          1000n,
          1n,
          0n,
          0n,
          0n,
        ],
      ],
      { kind: "uups" }
    );
    await presale.waitForDeployment();

    await pes.transfer(await presale.getAddress(), ethers.parseUnits("3000000", 18));
    await presale.grantAllocation(buyer.address, 1);
    await presale.setVestingConfigAndProgress(86_400, 40, 2);

    expect(await presale.owner()).to.equal(owner.address);
    expect(await presale.elapsedVestingPeriods()).to.equal(2);
    expect(await presale.claimableAmount(buyer.address)).to.equal(ethers.parseUnits("660", 18));

    const implementation = await upgrades.erc1967.getImplementationAddress(await presale.getAddress());
    expect(implementation).to.not.equal(ethers.ZeroAddress);
  });

  it("supports keeper-driven scheduled vesting distribution after V3 initialization", async function () {
    const [owner, buyer, secondBuyer, keeper] = await ethers.getSigners();
    const paymentToken = await deployPaymentToken(owner);

    const PESTokenUpgradeable = await ethers.getContractFactory("PESTokenUpgradeable");
    const pes = await upgrades.deployProxy(PESTokenUpgradeable, [owner.address, owner.address, owner.address], {
      kind: "uups",
    });
    await pes.waitForDeployment();

    const PESPresaleVestingUpgradeable = await ethers.getContractFactory("PESPresaleVestingUpgradeable");
    const firstReleaseTime = BigInt((await ethers.provider.getBlock("latest")).timestamp + DAY);
    const presale = await upgrades.deployProxy(
      PESPresaleVestingUpgradeable,
      [
        [
          await pes.getAddress(),
          await paymentToken.getAddress(),
          owner.address,
          owner.address,
          ethers.parseUnits("300", 18),
          ethers.parseUnits("3000", 18),
          1000n,
          1000n,
          1n,
          0n,
          0n,
          0n,
        ],
      ],
      { kind: "uups" }
    );
    await presale.waitForDeployment();

    await presale.initializeV3(keeper.address, false, firstReleaseTime, DAY);
    await pes.transfer(await presale.getAddress(), ethers.parseUnits("3000000", 18));
    await presale.grantAllocations([buyer.address, secondBuyer.address], [1, 1]);

    await expect(presale.connect(buyer).claim()).to.be.revertedWithCustomError(presale, "ManualClaimDisabled");
    await expect(presale.connect(keeper).distributeVested([buyer.address, secondBuyer.address])).to.be.revertedWithCustomError(
      presale,
      "AutoDistributionNotStarted"
    );

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(firstReleaseTime)]);
    await expect(presale.connect(keeper).distributeVested([buyer.address, secondBuyer.address]))
      .to.emit(presale, "AutoDistributionBatch")
      .withArgs(keeper.address, 1, 2, ethers.parseUnits("1200", 18));

    expect(await presale.elapsedVestingPeriods()).to.equal(1);
    expect(await pes.balanceOf(buyer.address)).to.equal(ethers.parseUnits("600", 18));
    expect(await pes.balanceOf(secondBuyer.address)).to.equal(ethers.parseUnits("600", 18));
    expect(await presale.totalTokensClaimed()).to.equal(ethers.parseUnits("1200", 18));

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(firstReleaseTime) + DAY]);
    await presale.connect(keeper).distributeVested([buyer.address, secondBuyer.address]);

    expect(await presale.elapsedVestingPeriods()).to.equal(2);
    expect(await pes.balanceOf(buyer.address)).to.equal(ethers.parseUnits("660", 18));
    expect(await pes.balanceOf(secondBuyer.address)).to.equal(ethers.parseUnits("660", 18));
  });

  it("preserves state when upgrading an existing presale to V3 auto distribution", async function () {
    const [owner, buyer, keeper] = await ethers.getSigners();
    const paymentToken = await deployPaymentToken(owner);

    const PESTokenUpgradeable = await ethers.getContractFactory("PESTokenUpgradeable");
    const pes = await upgrades.deployProxy(PESTokenUpgradeable, [owner.address, owner.address, owner.address], {
      kind: "uups",
    });
    await pes.waitForDeployment();

    const PESPresaleVestingUpgradeable = await ethers.getContractFactory("PESPresaleVestingUpgradeable");
    const presale = await upgrades.deployProxy(
      PESPresaleVestingUpgradeable,
      [
        [
          await pes.getAddress(),
          await paymentToken.getAddress(),
          owner.address,
          owner.address,
          ethers.parseUnits("300", 18),
          ethers.parseUnits("3000", 18),
          1000n,
          1000n,
          1n,
          0n,
          0n,
          0n,
        ],
      ],
      { kind: "uups" }
    );
    await presale.waitForDeployment();
    await pes.transfer(await presale.getAddress(), ethers.parseUnits("3000000", 18));
    await presale.grantAllocation(buyer.address, 1);

    const firstReleaseTime = BigInt((await ethers.provider.getBlock("latest")).timestamp + DAY);
    const initData = presale.interface.encodeFunctionData("initializeV3", [
      keeper.address,
      false,
      firstReleaseTime,
      DAY,
    ]);

    const upgraded = await upgrades.upgradeProxy(await presale.getAddress(), PESPresaleVestingUpgradeable, {
      call: { fn: "initializeV3", args: [keeper.address, false, firstReleaseTime, DAY] },
    });

    expect(await upgraded.keeper()).to.equal(keeper.address);
    expect(await upgraded.manualClaimEnabled()).to.equal(false);
    expect(await upgraded.autoDistributionStart()).to.equal(firstReleaseTime);
    expect(await upgraded.autoDistributionPeriodSeconds()).to.equal(DAY);

    const allocation = await upgraded.allocations(buyer.address);
    expect(allocation.packages).to.equal(1);
    expect(allocation.tokens).to.equal(ethers.parseUnits("3000", 18));
    expect(initData).to.match(/^0x/);
  });
});
