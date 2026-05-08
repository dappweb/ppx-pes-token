const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const DEFAULT_RPC_URL = "https://bsc-testnet-rpc.publicnode.com";
const DEFAULT_DEPLOYMENT_FILE = "deployments/bsc-testnet-usdx5-presale-2026-05-08.json";

const PRESALE_ABI = [
  "error InvalidAddress()",
  "error InvalidAmount()",
  "error MaxPackageCapExceeded()",
  "error OwnableUnauthorizedAccount(address account)",
  "event AdminAllocationGranted(address indexed account, uint256 packages, uint256 tokenAmount)",
  "function owner() view returns (address)",
  "function maxPackages() view returns (uint256)",
  "function publicPackagesSold() view returns (uint256)",
  "function totalPackagesAllocated() view returns (uint256)",
  "function totalTokensAllocated() view returns (uint256)",
  "function pesPerPackage() view returns (uint256)",
  "function grantAllocations(address[] accounts, uint256[] packagesList)",
];

function loadEnvFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (fs.existsSync(absolutePath)) {
    require("dotenv").config({ path: absolutePath, override: false });
  }
}

function loadDeployment() {
  const deploymentFile = process.env.DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE;
  const absolutePath = path.resolve(process.cwd(), deploymentFile);
  if (!fs.existsSync(absolutePath)) return {};
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
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
      account: ethers.getAddress(entry.account),
      packages: BigInt(entry.packages),
    };
  });
}

function generatedAllocations() {
  const batchSize = Number(process.env.SIM_BATCH_SIZE || "0");
  if (!batchSize) return null;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("SIM_BATCH_SIZE must be a positive integer");
  }

  const packages = BigInt(process.env.SIM_PACKAGES_PER_ADDRESS || "1");
  if (packages <= 0n) {
    throw new Error("SIM_PACKAGES_PER_ADDRESS must be greater than 0");
  }

  const offset = BigInt(process.env.SIM_ADDRESS_OFFSET || "1000");
  return Array.from({ length: batchSize }, (_, index) => {
    const value = offset + BigInt(index + 1);
    return {
      account: ethers.getAddress(`0x${value.toString(16).padStart(40, "0")}`),
      packages,
    };
  });
}

function formatUnits(value) {
  return ethers.formatUnits(value, 18).replace(/\.0+$/, "");
}

function chunkAllocations(allocations, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < allocations.length; offset += chunkSize) {
    chunks.push({
      index: chunks.length + 1,
      start: offset + 1,
      end: Math.min(offset + chunkSize, allocations.length),
      allocations: allocations.slice(offset, offset + chunkSize),
    });
  }
  return chunks;
}

function decodeError(iface, error) {
  const data = error?.data || error?.info?.error?.data || error?.error?.data;
  if (!data) return error?.shortMessage || error?.message || String(error);

  try {
    const decoded = iface.parseError(data);
    return decoded.args?.length ? `${decoded.name}(${decoded.args.join(", ")})` : decoded.name;
  } catch {
    return error?.shortMessage || error?.message || String(error);
  }
}

async function main() {
  loadEnvFile(".env.production");

  const deployment = loadDeployment();
  const rpcUrl = process.env.SIM_RPC_URL || process.env.BSC_TESTNET_RPC_URL || process.env.VITE_READ_RPC_URL || DEFAULT_RPC_URL;
  const presaleAddress = ethers.getAddress(
    process.env.PRESALE_ADDRESS ||
      process.env.VITE_PRESALE_ADDRESS ||
      deployment.contracts?.presaleVesting?.address
  );
  const allocations =
    generatedAllocations() || readAllocations(process.env.ALLOCATIONS_FILE || "allocations.example.json");
  const chunkSize = Number(process.env.SIM_CHUNK_SIZE || process.env.ALLOCATIONS_CHUNK_SIZE || "100");

  if (!allocations.length) {
    throw new Error("No allocations to simulate");
  }

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("SIM_CHUNK_SIZE / ALLOCATIONS_CHUNK_SIZE must be a positive integer");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const iface = new ethers.Interface(PRESALE_ABI);
  const presale = new ethers.Contract(presaleAddress, PRESALE_ABI, provider);
  const [network, owner, maxPackages, publicPackagesSold, totalPackagesAllocated, totalTokensAllocated, pesPerPackage] =
    await Promise.all([
      provider.getNetwork(),
      presale.owner(),
      presale.maxPackages(),
      presale.publicPackagesSold(),
      presale.totalPackagesAllocated(),
      presale.totalTokensAllocated(),
      presale.pesPerPackage(),
    ]);

  const from = ethers.getAddress(process.env.SIM_FROM || owner);
  const packagesList = allocations.map((entry) => entry.packages);
  const simulatedPackages = packagesList.reduce((sum, value) => sum + value, 0n);
  const simulatedTokens = simulatedPackages * pesPerPackage;
  const remainingBefore = maxPackages > totalPackagesAllocated ? maxPackages - totalPackagesAllocated : 0n;
  const wouldFit = simulatedPackages <= remainingBefore;
  const chunks = chunkAllocations(allocations, chunkSize);
  const chunkResults = [];

  for (const chunk of chunks) {
    const chunkAccounts = chunk.allocations.map((entry) => entry.account);
    const chunkPackagesList = chunk.allocations.map((entry) => entry.packages);
    const chunkPackages = chunkPackagesList.reduce((sum, value) => sum + value, 0n);
    const data = iface.encodeFunctionData("grantAllocations", [chunkAccounts, chunkPackagesList]);
    const chunkResult = {
      index: chunk.index,
      range: `${chunk.start}-${chunk.end}`,
      allocationCount: chunk.allocations.length,
      totalPackages: chunkPackages.toString(),
      status: "success",
      revertReason: null,
      estimatedGas: null,
    };

    try {
      await provider.call({ to: presaleAddress, from, data });
      const estimatedGas = await provider.estimateGas({ to: presaleAddress, from, data });
      chunkResult.estimatedGas = estimatedGas.toString();
    } catch (error) {
      chunkResult.status = "reverted";
      chunkResult.revertReason = decodeError(iface, error);
    }

    chunkResults.push(chunkResult);
  }

  const failedChunks = chunkResults.filter((entry) => entry.status !== "success");
  const totalEstimatedGas = chunkResults.reduce((sum, entry) => {
    return typeof entry.estimatedGas === "string" && /^\d+$/.test(entry.estimatedGas)
      ? sum + BigInt(entry.estimatedGas)
      : sum;
  }, 0n);

  const visibleEvents = allocations.slice(-16).reverse().map((entry) => ({
    activityLabel: "用户购买",
    account: entry.account,
    packages: entry.packages.toString(),
    tokenAmountPES: formatUnits(entry.packages * pesPerPackage),
  }));

  const result = {
    mode: "read-only eth_call simulation; no transaction was sent",
    network: {
      name: network.name,
      chainId: network.chainId.toString(),
      rpcUrl,
    },
    presale: {
      address: presaleAddress,
      owner,
      simulatedFrom: from,
      ownerMatched: from.toLowerCase() === owner.toLowerCase(),
    },
    currentState: {
      publicPackagesSold: publicPackagesSold.toString(),
      totalPackagesAllocated: totalPackagesAllocated.toString(),
      maxPackages: maxPackages.toString(),
      remainingPackages: remainingBefore.toString(),
      totalTokensAllocatedPES: formatUnits(totalTokensAllocated),
      pesPerPackagePES: formatUnits(pesPerPackage),
    },
    simulatedBatch: {
      allocationCount: allocations.length,
      chunkSize,
      chunkCount: chunks.length,
      totalPackages: simulatedPackages.toString(),
      totalTokensPES: formatUnits(simulatedTokens),
      wouldFitMaxPackageCap: wouldFit,
      expectedTotalPackagesAllocated: (totalPackagesAllocated + simulatedPackages).toString(),
      expectedRemainingPackages: wouldFit ? (remainingBefore - simulatedPackages).toString() : "0",
    },
    callResult: {
      status: wouldFit && failedChunks.length === 0 ? "success" : "review_required",
      reason:
        failedChunks.length > 0
          ? `${failedChunks.length} chunk(s) reverted during eth_call simulation`
          : wouldFit
            ? null
            : "total simulated packages exceed remaining max package cap",
      totalEstimatedGas: totalEstimatedGas.toString(),
      chunks: chunkResults,
    },
    activityPreview: {
      displayRule: "AdminAllocationGranted entries are rendered as 用户购买 in the frontend activity ticker",
      visibleLimit: "frontend keeps 24 latest events and renders up to 16 in the ticker",
      visibleEvents,
    },
  };

  console.log("ADMIN_BATCH_ALLOCATION_SIMULATION_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("ADMIN_BATCH_ALLOCATION_SIMULATION_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
