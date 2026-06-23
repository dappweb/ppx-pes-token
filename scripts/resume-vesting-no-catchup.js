/**
 * Resume vesting without catch-up: align schedule → fund presale → optional worker trigger.
 *
 * Step 1: setAutoDistributionSchedule (align scheduled == elapsed)
 * Step 2: fund presale to PRESALE_PES_AMOUNT
 * Step 3: POST worker /run when DISTRIBUTOR_RUN_TOKEN is set
 *
 * Required for on-chain steps (EXECUTE=true):
 *   PRIVATE_KEY          presale owner + PES owner
 *   PRESALE_ADDRESS      default 0x38882c608F64a8dAA5fbAB9a0712361D72866B6B
 *   PES_ADDRESS          default 0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41
 *
 * Optional:
 *   PRESALE_PES_AMOUNT=2000000
 *   SKIP_FUND=true
 *   SKIP_SCHEDULE=true
 *   TRIGGER_WORKER=true
 *   DISTRIBUTOR_RUN_TOKEN
 *   WORKER_URL             default https://pes-auto-distributor.dappweb.workers.dev
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

function env(name) {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

function parseBool(name, fallback = false) {
  const v = env(name);
  if (v === null) return fallback;
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}

function runHardhatScript(scriptName, extraEnv = {}) {
  const cwd = path.resolve(__dirname, "..");
  const envVars = { ...process.env, EXECUTE: "true", ...extraEnv };
  const cmd = `npx hardhat run scripts/${scriptName} --network bsc`;
  console.log(`\n>>> ${cmd}`);
  execSync(cmd, { cwd, env: envVars, stdio: "inherit" });
}

async function triggerWorker() {
  const workerUrl = (env("WORKER_URL") || "https://pes-auto-distributor.dappweb.workers.dev").replace(/\/$/, "");
  const token = env("DISTRIBUTOR_RUN_TOKEN");
  if (!token) {
    console.log("\n>>> Skipping worker trigger: DISTRIBUTOR_RUN_TOKEN not set");
    return null;
  }

  const url = `${workerUrl}/run`;
  console.log(`\n>>> POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-run-token": token },
  });
  const body = await res.text();
  console.log(`Worker status: ${res.status}`);
  console.log(body);
  if (!res.ok) throw new Error(`Worker trigger failed: ${res.status}`);
  return body;
}

async function readWorkerStatus() {
  const workerUrl = (env("WORKER_URL") || "https://pes-auto-distributor.dappweb.workers.dev").replace(/\/$/, "");
  const res = await fetch(workerUrl);
  const data = await res.json();
  console.log("\n>>> Worker status:");
  console.log(JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  const execute = parseBool("EXECUTE", false);
  if (!execute) {
    console.log("Dry-run mode. Set EXECUTE=true to send transactions.");
    console.log("Preview: npx hardhat run scripts/set-auto-distribution-schedule.js --network bsc");
    return;
  }

  if (!env("PRIVATE_KEY")) {
    throw new Error("PRIVATE_KEY is required when EXECUTE=true");
  }

  process.env.PRESALE_ADDRESS =
    env("PRESALE_ADDRESS") || "0x38882c608F64a8dAA5fbAB9a0712361D72866B6B";
  process.env.PES_ADDRESS =
    env("PES_ADDRESS") || "0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41";
  process.env.PRESALE_PES_AMOUNT = env("PRESALE_PES_AMOUNT") || "2000000";
  process.env.FUND_FROM_SIGNER = "true";

  await readWorkerStatus();

  if (!parseBool("SKIP_SCHEDULE", false)) {
    runHardhatScript("set-auto-distribution-schedule.js");
  }

  if (!parseBool("SKIP_FUND", false)) {
    runHardhatScript("fund-presale.js");
  }

  await readWorkerStatus();

  if (parseBool("TRIGGER_WORKER", true)) {
    await triggerWorker();
    await readWorkerStatus();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
