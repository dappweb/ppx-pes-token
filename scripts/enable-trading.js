const hre = require("hardhat");

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const pesAddress = requiredAddress("PES_ADDRESS");
  const pairAddress = requiredAddress("AMM_PAIR_ADDRESS");
  const pes = await hre.ethers.getContractAt("PESToken", pesAddress);

  const pairTx = await pes.setAutomatedMarketMakerPair(pairAddress, true);
  await pairTx.wait();

  const tradingTx = await pes.setTradingEnabled(true);
  await tradingTx.wait();

  console.log(`Enabled trading for AMM pair ${pairAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

