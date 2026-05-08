const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readAllocations(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const allocations = JSON.parse(raw);

  if (!Array.isArray(allocations)) {
    throw new Error("Allocations file must be a JSON array");
  }

  return allocations.map((entry, index) => {
    if (!entry.account || entry.packages === undefined) {
      throw new Error(`Invalid allocation at index ${index}`);
    }

    return {
      account: hre.ethers.getAddress(entry.account),
      packages: BigInt(entry.packages),
    };
  });
}

async function main() {
  const presaleAddress = requiredAddress("PRESALE_ADDRESS");
  const allocationsFile = process.env.ALLOCATIONS_FILE || "allocations.example.json";
  const chunkSize = Number(process.env.ALLOCATIONS_CHUNK_SIZE || "100");
  const allocations = readAllocations(allocationsFile);
  const presale = await hre.ethers.getContractAt("PESPresaleVesting", presaleAddress);

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("ALLOCATIONS_CHUNK_SIZE must be a positive integer");
  }

  for (let offset = 0; offset < allocations.length; offset += chunkSize) {
    const chunk = allocations.slice(offset, offset + chunkSize);
    const accounts = chunk.map((entry) => entry.account);
    const packagesList = chunk.map((entry) => entry.packages);
    const tx = await presale.grantAllocations(accounts, packagesList);
    await tx.wait();
    console.log(`Granted allocations ${offset + 1}-${offset + chunk.length} of ${allocations.length}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

