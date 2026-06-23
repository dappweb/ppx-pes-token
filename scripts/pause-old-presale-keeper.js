/**
 * Disable keeper on the OLD presale to stop auto-distribution of the OLD PES.
 * After this, the worker's distributeVested calls will revert with NotOwnerOrKeeper.
 *
 * Manual claim is already disabled, so buyers cannot pull old PES either.
 *
 * Required env (when EXECUTE=true):
 *   PRIVATE_KEY            owner key
 *   BSC_RPC_URL            (optional)
 *   OLD_PRESALE_ADDRESS    default 0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd
 *   EXECUTE=true           otherwise dry-run only
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const EXPLORER_BASE_URL = "https://bscscan.com";
const DEFAULT_OLD_PRESALE = "0x6d5Fc8F6A0481a81A726Ca2Fac85c23ED80619fd";

const PRESALE_ABI = [
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function manualClaimEnabled() view returns (bool)",
  "function pesToken() view returns (address)",
  "function totalTokensAllocated() view returns (uint256)",
  "function totalTokensClaimed() view returns (uint256)",
  "function elapsedVestingPeriods() view returns (uint16)",
  "function setKeeper(address newKeeper)",
];

function env(name) {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}
function parseBool(name, fb = false) {
  const v = env(name);
  if (v === null) return fb;
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}
function checkedAddress(name, value) {
  if (!hre.ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return hre.ethers.getAddress(value);
}
function txUrl(h) { return h ? `${EXPLORER_BASE_URL}/tx/${h}` : null; }
function addressUrl(a) { return `${EXPLORER_BASE_URL}/address/${a}`; }

async function main() {
  const execute = parseBool("EXECUTE", false);
  const confirmations = Number(env("CONFIRMATIONS") || "1");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) throw new Error(`Expected BSC mainnet chainId 56, got ${network.chainId}`);

  const presaleAddress = checkedAddress("OLD_PRESALE_ADDRESS", env("OLD_PRESALE_ADDRESS") || DEFAULT_OLD_PRESALE);
  const presale = await hre.ethers.getContractAt(PRESALE_ABI, presaleAddress);

  const [owner, keeperBefore, manualEnabled, pesToken, alloc, claimed, elapsed] = await Promise.all([
    presale.owner(),
    presale.keeper(),
    presale.manualClaimEnabled(),
    presale.pesToken(),
    presale.totalTokensAllocated(),
    presale.totalTokensClaimed(),
    presale.elapsedVestingPeriods(),
  ]);

  if (keeperBefore === hre.ethers.ZeroAddress) {
    console.log("Keeper already address(0); nothing to do.");
  }

  let signerAddress = null;
  let txHash = null;
  if (execute && keeperBefore !== hre.ethers.ZeroAddress) {
    const [signer] = await hre.ethers.getSigners();
    if (!signer) throw new Error("PRIVATE_KEY required");
    signerAddress = signer.address;
    if (hre.ethers.getAddress(signerAddress) !== hre.ethers.getAddress(owner)) {
      throw new Error(`Signer ${signerAddress} is not owner ${owner}`);
    }
    const tx = await presale.connect(signer).setKeeper(hre.ethers.ZeroAddress);
    console.log(`setKeeper(0) tx: ${tx.hash}`);
    await tx.wait(confirmations);
    txHash = tx.hash;
  }

  const keeperAfter = await presale.keeper();
  const result = {
    runAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    network: "bsc",
    chainId: network.chainId.toString(),
    signer: signerAddress,
    oldPresale: { address: presaleAddress, owner, pesToken, explorer: addressUrl(presaleAddress) },
    state: {
      keeperBefore,
      keeperAfter,
      manualClaimEnabled: manualEnabled,
      totalTokensAllocated: hre.ethers.formatUnits(alloc, 18),
      totalTokensClaimed: hre.ethers.formatUnits(claimed, 18),
      elapsedVestingPeriods: elapsed.toString(),
    },
    transactions: { setKeeperZero: txUrl(txHash) },
    notes: [
      "Keeper removed: worker's distributeVested calls will revert (NotOwnerOrKeeper).",
      "manualClaimEnabled is false, so buyers cannot pull old PES either.",
      "Old PES balance remains in presale; recovery requires separate procedure due to ReservedTokenRecovery check.",
    ],
  };
  console.log("PAUSE_OLD_PRESALE_KEEPER_RESULT_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("PAUSE_OLD_PRESALE_KEEPER_RESULT_END");

  if (execute && txHash) {
    const outputPath = path.join(process.cwd(), "deployments",
      `bsc-mainnet-pause-old-presale-keeper-${new Date().toISOString().slice(0, 10)}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Deployment file: ${outputPath}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
