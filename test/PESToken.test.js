const { expect } = require("chai");
const { ethers } = require("hardhat");

const pes = (value) => ethers.parseUnits(value, 18);

describe("PESToken", function () {
  async function deployFixture() {
    const [owner, liquidityWallet, operationsWallet, pair, buyer, seller] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("PESToken");
    const token = await Token.deploy(owner.address, liquidityWallet.address, operationsWallet.address);
    await token.waitForDeployment();

    return { token, owner, liquidityWallet, operationsWallet, pair, buyer, seller };
  }

  it("mints the fixed 21,000,000 PES supply to the owner", async function () {
    const { token, owner } = await deployFixture();

    expect(await token.totalSupply()).to.equal(pes("21000000"));
    expect(await token.balanceOf(owner.address)).to.equal(pes("21000000"));
  });

  it("charges 1.5% on buys and splits it between LP, operations, and burn", async function () {
    const { token, owner, liquidityWallet, operationsWallet, pair, buyer } = await deployFixture();

    await token.setAutomatedMarketMakerPair(pair.address, true);
    await token.transfer(pair.address, pes("100000"));
    await token.setTradingEnabled(true);

    const supplyBefore = await token.totalSupply();

    await token.connect(pair).transfer(buyer.address, pes("10000"));

    expect(await token.balanceOf(buyer.address)).to.equal(pes("9850"));
    expect(await token.balanceOf(liquidityWallet.address)).to.equal(pes("50"));
    expect(await token.balanceOf(operationsWallet.address)).to.equal(pes("50"));
    expect(await token.totalSupply()).to.equal(supplyBefore - pes("50"));
    expect(await token.balanceOf(owner.address)).to.equal(pes("20900000"));
  });

  it("charges 1.5% on sells and splits it between LP, operations, and burn", async function () {
    const { token, owner, liquidityWallet, operationsWallet, pair, seller } = await deployFixture();

    await token.setAutomatedMarketMakerPair(pair.address, true);
    await token.transfer(seller.address, pes("10000"));
    await token.setTradingEnabled(true);

    const supplyBefore = await token.totalSupply();

    await token.connect(seller).transfer(pair.address, pes("10000"));

    expect(await token.balanceOf(pair.address)).to.equal(pes("9850"));
    expect(await token.balanceOf(liquidityWallet.address)).to.equal(pes("50"));
    expect(await token.balanceOf(operationsWallet.address)).to.equal(pes("50"));
    expect(await token.totalSupply()).to.equal(supplyBefore - pes("50"));
  });

  it("blocks non-exempt AMM trading until trading is enabled", async function () {
    const { token, owner, pair, buyer } = await deployFixture();

    await token.setAutomatedMarketMakerPair(pair.address, true);
    await token.transfer(buyer.address, pes("1000"));
    await token.transfer(pair.address, pes("1000"));

    await expect(token.connect(buyer).transfer(pair.address, pes("1"))).to.be.revertedWithCustomError(
      token,
      "TradingNotEnabled"
    );

    await expect(token.connect(owner).transfer(pair.address, pes("1"))).not.to.be.reverted;
  });

  it("allows the owner to update fee rates within the 10% safety cap", async function () {
    const { token } = await deployFixture();

    await token.setFeeRates(true, 100, 75, 25);
    expect(await token.totalBuyFeeBps()).to.equal(200);

    await expect(token.setFeeRates(false, 500, 400, 101)).to.be.revertedWithCustomError(token, "FeeTooHigh");
  });
});

