export const DISTRIBUTION_BATCH_SIZE = 80;

export function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function computeAlignedAutoDistributionStart(elapsedPeriods, periodSeconds, nowSeconds) {
  const elapsed = BigInt(elapsedPeriods || 0);
  const period = BigInt(periodSeconds || 0);
  if (elapsed <= 0n) {
    throw new Error("已执行期数必须大于 0");
  }
  if (period <= 0n) {
    throw new Error("周期秒数必须大于 0");
  }

  const now = BigInt(nowSeconds ?? Math.floor(Date.now() / 1000));
  return now - (elapsed - 1n) * period;
}

export function getScheduleLag(elapsedPeriods, scheduledPeriods) {
  const elapsed = BigInt(elapsedPeriods || 0);
  const scheduled = BigInt(scheduledPeriods || 0);
  return scheduled > elapsed ? scheduled - elapsed : 0n;
}

export function estimateCatchUpPesPerUser(pesPerPackage, elapsedPeriods, scheduledPeriods, vestingPeriods = 40n) {
  const elapsed = Number(elapsedPeriods || 0);
  const scheduled = Number(scheduledPeriods || 0);
  if (scheduled <= elapsed || elapsed <= 0) return 0n;

  const pkg = BigInt(pesPerPackage || 0);
  const periods = BigInt(vestingPeriods || 40);
  const releaseBps = (period) => 2000n + (8000n * BigInt(period - 1)) / periods;
  const vested = (period) => (pkg * releaseBps(period)) / 10000n;

  return vested(scheduled) - vested(elapsed);
}

export function estimateDailyDistributionPes(pesPerPackage, buyerCount, vestingPeriods = 40n) {
  const pkg = BigInt(pesPerPackage || 0);
  const buyers = BigInt(buyerCount || 0);
  const periods = BigInt(vestingPeriods || 40);
  const perUserPerPeriod = (pkg * 8000n) / periods / 10000n;
  return perUserPerPeriod * buyers;
}
