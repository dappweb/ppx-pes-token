const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULT_DEPLOYMENT_FILE = "deployments/bsc-mainnet-presale-config-2026-05-24.json";
const FALLBACK_PES_ADDRESS = "0xe83e750feEbe231c870DdF30165CbFE64F400Ebc";
const FALLBACK_PRESALE_ADDRESS = "0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd";

const PES_ABI = [
  "function owner() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function pesToken() view returns (address)",
  "function pesPerPackage() view returns (uint256)",
  "function maxPackages() view returns (uint256)",
  "function totalTokensAllocated() view returns (uint256)",
  "function totalTokensClaimed() view returns (uint256)",
  "function unclaimedAllocatedTokens() view returns (uint256)",
];

function env(name) {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function parseBool(name, fallback = false) {
  const value = env(name);
  if (value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function readDeployment() {
  const deploymentFile = env("DEPLOYMENT_FILE") || DEFAULT_DEPLOYMENT_FILE;
  const deploymentPath = path.resolve(process.cwd(), deploymentFile);
  if (!fs.existsSync(deploymentPath)) return null;
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
}

function addressFromDeployment(deployment, section, fallback) {
  return deployment?.contracts?.[section]?.proxy || deployment?.contracts?.[section]?.address || fallback;
}

function checkedAddress(name, value) {
  if (!hre.ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return hre.ethers.getAddress(value);
}

function txUrl(hash) {
  return hash ? `${EXPLORER_BASE_URL}/tx/${hash}` : null;
}

function addressUrl(address) {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

function formatPes(amount) {
  return hre.ethers.formatUnits(amount, 18);
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error("CONFIRMATIONS must be a positive integer");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);
  }

  const deployment = readDeployment();
  const pesAddress = checkedAddress(
    "PES_ADDRESS",
    env("PES_ADDRESS") || addressFromDeployment(deployment, "pesToken", FALLBACK_PES_ADDRESS)
  );
  const presaleAddress = checkedAddress(
    "PRESALE_ADDRESS",
    env("PRESALE_ADDRESS") || addressFromDeployment(deployment, "presaleVesting", FALLBACK_PRESALE_ADDRESS)
  );

  const pes = await hre.ethers.getContractAt(PES_ABI, pesAddress);
  const presale = await hre.ethers.getContractAt(PRESALE_ABI, presaleAddress);

  const [
    tokenOwner,
    presaleOwner,
    presalePesToken,
    pesPerPackage,
    maxPackages,
    totalTokensAllocated,
    totalTokensClaimed,
    unclaimedAllocatedTokens,
    presalePesBalance,
  ] = await Promise.all([
    pes.owner(),
    presale.owner(),
    presale.pesToken(),
    presale.pesPerPackage(),
    presale.maxPackages(),
    presale.totalTokensAllocated(),
    presale.totalTokensClaimed(),
    presale.unclaimedAllocatedTokens(),
    pes.balanceOf(presaleAddress),
  ]);

  if (hre.ethers.getAddress(presalePesToken) !== pesAddress) {
    throw new Error(`Presale pesToken ${presalePesToken} does not match PES ${pesAddress}`);
  }

  const requiredFunding = maxPackages * pesPerPackage;
  const targetFunding = env("PRESALE_PES_AMOUNT")
    ? hre.ethers.parseUnits(env("PRESALE_PES_AMOUNT"), 18)
    : requiredFunding;
  const shortfall = presalePesBalance >= targetFunding ? 0n : targetFunding - presalePesBalance;

  const fundFromSigner = parseBool("FUND_FROM_SIGNER", false);
  const zeroOwner =
    !tokenOwner || hre.ethers.getAddress(tokenOwner) === hre.ethers.ZeroAddress;
  const useSignerFunding = fundFromSigner || zeroOwner;

  let signerAddress = null;
  let funderPesBalance = await pes.balanceOf(tokenOwner);
  let txHash = null;

  if (execute) {
    const [signer] = await hre.ethers.getSigners();
    if (!signer) {
      throw new Error("PRIVATE_KEY is required when EXECUTE=true");
    }

    signerAddress = signer.address;
    if (!useSignerFunding && hre.ethers.getAddress(signerAddress) !== hre.ethers.getAddress(tokenOwner)) {
      throw new Error(`Signer ${signerAddress} is not PES owner ${tokenOwner}`);
    }

    funderPesBalance = await pes.balanceOf(signerAddress);
    if (funderPesBalance < shortfall) {
      throw new Error(
        `Signer PES balance ${formatPes(funderPesBalance)} is below shortfall ${formatPes(shortfall)}`
      );
    }

    if (shortfall > 0n) {
      const tx = await pes.connect(signer).transfer(presaleAddress, shortfall);
      console.log(`fundPresale tx: ${tx.hash}`);
      await tx.wait(confirmations);
      txHash = tx.hash;
    }
  }

  const presalePesBalanceAfter = await pes.balanceOf(presaleAddress);
  const result = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    signer: signerAddress,
    contracts: {
      pesToken: {
        proxy: pesAddress,
        owner: tokenOwner,
        explorer: addressUrl(pesAddress),
      },
      presaleVesting: {
        proxy: presaleAddress,
        owner: presaleOwner,
        explorer: addressUrl(presaleAddress),
      },
    },
    funding: {
      requiredFunding: formatPes(requiredFunding),
      targetFunding: formatPes(targetFunding),
      pesOwner: tokenOwner,
      fundFromSigner: useSignerFunding,
      funderPesBalance: formatPes(funderPesBalance),
      presalePesBalanceBefore: formatPes(presalePesBalance),
      shortfallTransferred: formatPes(execute ? shortfall : 0n),
      shortfallPending: formatPes(execute ? 0n : shortfall),
      presalePesBalanceAfter: formatPes(presalePesBalanceAfter),
      totalTokensAllocated: formatPes(totalTokensAllocated),
      totalTokensClaimed: formatPes(totalTokensClaimed),
      unclaimedAllocatedTokens: formatPes(unclaimedAllocatedTokens),
    },
    transactions: {
      fundPresale: txUrl(txHash),
    },
  };

  console.log("BSC_MAINNET_PRESALE_FUNDING_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("BSC_MAINNET_PRESALE_FUNDING_RESULT_END");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
