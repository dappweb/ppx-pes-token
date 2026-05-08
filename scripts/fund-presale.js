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
  const presaleAddress = requiredAddress("PRESALE_ADDRESS");
  const amount = hre.ethers.parseUnits(process.env.PRESALE_PES_AMOUNT || "6000000", 18);

  const pes = await hre.ethers.getContractAt("PESToken", pesAddress);
  const tx = await pes.transfer(presaleAddress, amount);
  await tx.wait();

  console.log(`Transferred ${hre.ethers.formatUnits(amount, 18)} PES to ${presaleAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

