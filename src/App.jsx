import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ethers } from "ethers";
import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    Coins,
    Copy,
    Database,
    ExternalLink,
    Pause,
    Play,
    Power,
    RefreshCw,
    Save,
    ShieldCheck,
    ShoppingCart,
    SlidersHorizontal,
    Upload,
    Users,
    Wallet,
    Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import { ERC20_ABI, PES_TOKEN_ABI, PRESALE_ABI } from "./lib/abis.js";
import { DISTRIBUTION_BUYERS, DISTRIBUTION_BUYER_COUNT } from "./lib/distribution-buyers.js";
import {
    DISTRIBUTION_BATCH_SIZE,
    chunkArray,
    computeAlignedAutoDistributionStart,
    estimateCatchUpPesPerUser,
    estimateDailyDistributionPes,
    getScheduleLag,
} from "./lib/vesting-ops.js";

const CONFIG_KEY = "pes-token-console-config";
const ADMIN_ALLOCATIONS_CACHE_KEY = "pes-admin-allocations-cache";
const IP_POLICY_ENDPOINT = "/api/ip-policy";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TARGET_CHAIN_ID = import.meta.env.VITE_TARGET_CHAIN_ID || "56";
const TARGET_CHAIN_NAME = import.meta.env.VITE_TARGET_CHAIN_NAME || "BSC Mainnet";
const DEFAULT_BSC_RPC_URL =
  import.meta.env.VITE_DEFAULT_READ_RPC_URL ||
  (TARGET_CHAIN_ID === "97" ? "https://bsc-testnet-rpc.publicnode.com" : "https://bsc-rpc.publicnode.com");
const EVENT_LOOKBACK_BLOCKS = Number(import.meta.env.VITE_EVENT_LOOKBACK_BLOCKS || "20000");
const ADMIN_ALLOCATION_SCAN_BLOCKS = Number(import.meta.env.VITE_ADMIN_ALLOCATION_SCAN_BLOCKS || "500000");
const EVENT_QUERY_BLOCK_RANGE = Number(import.meta.env.VITE_EVENT_QUERY_BLOCK_RANGE || "1000");
const READ_PROVIDER_OPTIONS = { batchMaxCount: 1, batchStallTime: 0 };
const OWNER_ALLOCATION_TARGET = 950n;
const DEFAULT_ALLOCATION_CHUNK_SIZE = 100;
const DEFAULT_IP_POLICY = {
  ok: false,
  enabled: false,
  loading: true,
  ip: "",
  whitelisted: false,
  usedPackages: 0,
  remainingPackages: 0,
  packageLimit: 1,
  whitelist: [],
};
const DEFAULT_BSC_TESTNET_CONFIG = {
  pesAddress: "0x40D51d93e3Eb057b3558DA71C7CCdEAa27713E41",
  presaleAddress: "0x38882c608F64a8dAA5fbAB9a0712361D72866B6B",
  paymentTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
};
const LEGACY_BSC_TESTNET_CONFIG = {
  presaleAddress: "0x5e353B9F99e5A8EF669Bc8399035c3408A370D66",
  paymentTokenAddress: "0xD9a6F0d3A794314567f4f1cce17aeb76e13B0924",
};
const PREVIOUS_BSC_TESTNET_CONFIG = {
  presaleAddress: "0x55557090058345F9D758aD7Fb3b8bbB6Ed142f11",
  paymentTokenAddress: "0xacD944e910952c020eb129C50921f180c62c3291",
};
const LATEST_BSC_TESTNET_CONFIG = {
  presaleAddress: "0xBCB3abE6FbeAEe3deb24A06527295045f9D47b28",
  paymentTokenAddress: "0xacD944e910952c020eb129C50921f180c62c3291",
};

const emptyConfig = {
  pesAddress: import.meta.env.VITE_PES_ADDRESS || DEFAULT_BSC_TESTNET_CONFIG.pesAddress,
  presaleAddress: import.meta.env.VITE_PRESALE_ADDRESS || DEFAULT_BSC_TESTNET_CONFIG.presaleAddress,
  paymentTokenAddress: import.meta.env.VITE_PAYMENT_TOKEN_ADDRESS || DEFAULT_BSC_TESTNET_CONFIG.paymentTokenAddress,
  ammPairAddress: import.meta.env.VITE_AMM_PAIR_ADDRESS || "",
  dexUrl: import.meta.env.VITE_DEX_URL || "",
};

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    const config = { ...emptyConfig, ...stored };
    if (
      normalizeAddress(config.presaleAddress) === normalizeAddress(LEGACY_BSC_TESTNET_CONFIG.presaleAddress) &&
      normalizeAddress(config.paymentTokenAddress) === normalizeAddress(LEGACY_BSC_TESTNET_CONFIG.paymentTokenAddress)
    ) {
      return { ...config, ...DEFAULT_BSC_TESTNET_CONFIG };
    }
    if (
      normalizeAddress(config.presaleAddress) === normalizeAddress(PREVIOUS_BSC_TESTNET_CONFIG.presaleAddress) &&
      normalizeAddress(config.paymentTokenAddress) === normalizeAddress(PREVIOUS_BSC_TESTNET_CONFIG.paymentTokenAddress)
    ) {
      return { ...config, ...DEFAULT_BSC_TESTNET_CONFIG };
    }
    if (
      normalizeAddress(config.presaleAddress) === normalizeAddress(LATEST_BSC_TESTNET_CONFIG.presaleAddress) &&
      normalizeAddress(config.paymentTokenAddress) === normalizeAddress(LATEST_BSC_TESTNET_CONFIG.paymentTokenAddress)
    ) {
      return { ...config, ...DEFAULT_BSC_TESTNET_CONFIG };
    }
    return config;
  } catch {
    return emptyConfig;
  }
}

async function fetchIpPolicy(includeWhitelist = false) {
  const response = await fetch(`${IP_POLICY_ENDPOINT}${includeWhitelist ? "?admin=1" : ""}`, {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "IP 策略读取失败");
  }
  return payload;
}

async function postIpPolicy(payload) {
  const response = await fetch(IP_POLICY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || "IP 策略保存失败");
  }
  return result;
}

async function signIpPolicyAdminAction(signer, action, ip) {
  if (!signer) {
    throw new Error("请先连接 Admin 钱包");
  }

  const admin = await signer.getAddress();
  const message = [
    "PES IP whitelist admin",
    `Action: ${action}`,
    `IP: ${ip}`,
    `Admin: ${admin}`,
    `Nonce: ${Date.now()}`,
  ].join("\n");
  const signature = await signer.signMessage(message);
  return { admin, message, signature };
}

function loadCachedAdminAllocationRows(presaleAddress) {
  try {
    const cache = JSON.parse(localStorage.getItem(ADMIN_ALLOCATIONS_CACHE_KEY) || "{}");
    return (cache[presaleAddress] || []).map((row) => ({
      ...row,
      packages: BigInt(row.packages || "0"),
      tokenAmount: BigInt(row.tokenAmount || "0"),
    }));
  } catch {
    return [];
  }
}

function saveCachedAdminAllocationRows(presaleAddress, rows) {
  try {
    const cache = JSON.parse(localStorage.getItem(ADMIN_ALLOCATIONS_CACHE_KEY) || "{}");
    cache[presaleAddress] = rows.map((row) => ({
      ...row,
      packages: row.packages.toString(),
      tokenAmount: row.tokenAmount.toString(),
    }));
    localStorage.setItem(ADMIN_ALLOCATIONS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Local cache is best-effort; chain events remain the source of truth.
  }
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(String(value || "").trim());
  } catch {
    return "";
  }
}

function isAddress(value) {
  return Boolean(normalizeAddress(value));
}

function shortAddress(value) {
  const normalized = normalizeAddress(value);
  if (!normalized) return "--";
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function formatUnits(value, decimals = 18, digits = 4) {
  if (value === undefined || value === null) return "--";
  const formatted = ethers.formatUnits(value, decimals);
  const [whole, fraction = ""] = formatted.split(".");
  const wholeText = BigInt(whole || "0").toLocaleString("en-US");
  const fractionText = fraction.slice(0, digits).replace(/0+$/, "");
  return fractionText ? `${wholeText}.${fractionText}` : wholeText;
}

function formatInteger(value) {
  if (value === undefined || value === null) return "--";
  return BigInt(value).toLocaleString("en-US");
}

function formatPlainInteger(value) {
  if (value === undefined || value === null) return "--";
  return BigInt(value).toString();
}

function positiveRemaining(total, used) {
  const totalValue = BigInt(total || 0n);
  const usedValue = BigInt(used || 0n);
  return totalValue > usedValue ? totalValue - usedValue : 0n;
}

function minBigInt(...values) {
  return values.reduce((min, value) => (value < min ? value : min));
}

function parsePositiveBigIntInput(value) {
  const text = String(value || "").trim();
  return /^[1-9]\d*$/.test(text) ? BigInt(text) : 0n;
}

function formatBps(value) {
  if (value === undefined || value === null) return "--";
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function formatTimestamp(value) {
  const seconds = Number(value || 0n);
  if (!seconds) return "未设置";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatActivityTime(value) {
  const seconds = Number(value || 0);
  if (!seconds) return "时间读取中";
  return new Date(seconds * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function toDateTimeLocal(value) {
  const seconds = Number(value || 0n);
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  if (!value) return 0n;
  return BigInt(Math.floor(new Date(value).getTime() / 1000));
}

function secondsToDays(value) {
  const seconds = Number(value || 0n);
  if (!seconds) return "";
  return String(seconds / 86_400);
}

function daysToSeconds(value) {
  const days = Number(String(value || "").trim());
  if (!Number.isFinite(days) || days <= 0) return 0n;
  return BigInt(Math.round(days * 86_400));
}

function formatPeriodSeconds(value) {
  const seconds = Number(value || 0n);
  if (!seconds) return "--";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  return `${seconds} 秒`;
}

async function optionalContractCall(call, fallbackValue) {
  try {
    return { supported: true, value: await call() };
  } catch {
    return { supported: false, value: fallbackValue };
  }
}

function getErrorMessage(error) {
  const message =
    error?.shortMessage ||
    error?.reason ||
    error?.info?.error?.message ||
    error?.message ||
    "交易失败";
  return message.replace(/\s+/g, " ").slice(0, 220);
}

function saleStatus(data) {
  const now = Math.floor(Date.now() / 1000);
  const start = Number(data?.saleStart || 0n);
  const end = Number(data?.saleEnd || 0n);
  if (!start || !end) return "未设置";
  if (now < start) return "未开始";
  if (now > end) return "已结束";
  return "进行中";
}

function launchStatus(data) {
  const launch = Number(data?.launchTime || 0n);
  if (!launch) return "未设置";
  return Math.floor(Date.now() / 1000) >= launch ? "已上线" : "未上线";
}

function packageProgress(sold, cap) {
  if (!cap || cap === 0n) return 0;
  return Math.min(100, Number((sold * 10_000n) / cap) / 100);
}

function parseBatchAllocations(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 1) {
      throw new Error(`第 ${index + 1} 行只填写地址`);
    }
    const normalized = normalizeAddress(parts[0]);
    if (!normalized) {
      throw new Error(`第 ${index + 1} 行地址格式错误`);
    }
    return { account: normalized, packages: 1n };
  });
}

function parseAllocationChunkSize(value) {
  const chunkSize = Number(value || DEFAULT_ALLOCATION_CHUNK_SIZE);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("批次大小必须是正整数");
  }
  return chunkSize;
}

function chunkAllocations(entries, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    chunks.push(entries.slice(offset, offset + chunkSize));
  }
  return chunks;
}

async function queryFilterInRanges(contract, filter, fromBlock, toBlock, rangeSize = EVENT_QUERY_BLOCK_RANGE) {
  if (fromBlock > toBlock) return [];

  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += rangeSize) {
    const end = Math.min(toBlock, start + rangeSize - 1);
    try {
      logs.push(...(await contract.queryFilter(filter, start, end)));
    } catch (error) {
      console.warn(`Skipped event range ${start}-${end}: ${getErrorMessage(error)}`);
    }
  }
  return logs;
}

function createReadProvider(rpcUrl) {
  return new ethers.JsonRpcProvider(rpcUrl || DEFAULT_BSC_RPC_URL, Number(TARGET_CHAIN_ID), READ_PROVIDER_OPTIONS);
}

function buildAdminAllocationRows(grantLogs, seedRows = []) {
  const byAccount = new Map();

  for (const row of seedRows) {
    byAccount.set(row.account, { ...row });
  }

  for (const event of grantLogs) {
    const account = normalizeAddress(event.args?.account || event.args?.[0]);
    if (!account) continue;

    const previous = byAccount.get(account) || {
      account,
      packages: 0n,
      tokenAmount: 0n,
      grantCount: 0,
      lastBlock: 0,
      lastLogIndex: 0,
      lastTransactionHash: "",
    };
    const logIndex = event.index ?? event.logIndex ?? 0;

    byAccount.set(account, {
      ...previous,
      packages: previous.packages + BigInt(event.args?.packages || event.args?.[1] || 0n),
      tokenAmount: previous.tokenAmount + BigInt(event.args?.tokenAmount || event.args?.[2] || 0n),
      grantCount: previous.grantCount + 1,
      lastBlock: event.blockNumber,
      lastLogIndex: logIndex,
      lastTransactionHash: event.transactionHash,
    });
  }

  return [...byAccount.values()].sort((a, b) => {
    if (b.lastBlock !== a.lastBlock) return b.lastBlock - a.lastBlock;
    return b.lastLogIndex - a.lastLogIndex;
  });
}

function Section({ number, title, children, actions }) {
  return (
    <section className="section">
      <div className="sectionHead">
        <span className="sectionNumber">{number}</span>
        <h2>{title}</h2>
        <div className="sectionActions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

function Button({ children, icon: Icon, variant = "primary", busy, ...props }) {
  return (
    <button className={`button ${variant}`} disabled={busy || props.disabled} {...props}>
      {busy ? <RefreshCw className="spin" size={16} /> : Icon ? <Icon size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({ label, icon: Icon, ...props }) {
  return (
    <button className="iconButton" title={label} aria-label={label} {...props}>
      <Icon size={16} />
    </button>
  );
}

function RainbowWalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!ready) {
          return (
            <Button icon={Wallet} disabled>
              连接钱包
            </Button>
          );
        }

        if (!connected) {
          return (
            <Button icon={Wallet} onClick={openConnectModal}>
              连接钱包
            </Button>
          );
        }

        if (chain.unsupported) {
          return (
            <Button icon={AlertTriangle} variant="secondary" onClick={openChainModal}>
              切换到 BSC Mainnet
            </Button>
          );
        }

        return (
          <Button icon={Wallet} onClick={openAccountModal}>
            {account.displayName}
          </Button>
        );
      }}
    </ConnectButton.Custom>
  );
}

function Metric({ label, value, note }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Progress({ value, total }) {
  const percent = packageProgress(value || 0n, total || 0n);
  return (
    <div className="progressWrap" role="progressbar" aria-label="公开认购进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="progressMeta">
        <span>{percent.toFixed(2)}</span>
        <span>{formatPlainInteger(value || 0n)}/{formatPlainInteger(total || 0n)}</span>
      </div>
      <div className="progressTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ActivityTicker({ events }) {
  const visibleEvents = events?.slice(0, 8) || [];
  const tickerEvents = visibleEvents.length > 1 ? [...visibleEvents, ...visibleEvents] : visibleEvents;

  return (
    <div className={`activityTicker ${visibleEvents.length ? "" : "empty"}`} aria-label="用户购买动态">
      <div className="activityTickerHead">
        <div>
          <strong>线上认购状态</strong>
        </div>
        <small>{visibleEvents.length > 1 ? "滚动显示" : visibleEvents.length ? "最近一笔" : "等待新记录"}</small>
      </div>
      {visibleEvents.length ? (
        <div className="activityMarquee">
          <div className={`activityTrack ${visibleEvents.length > 1 ? "scrolling" : ""}`}>
            {tickerEvents.map((event, index) => {
              return (
                <div className="activityToast purchase" key={`${event.transactionHash}-${event.logIndex}-${index}`}>
                  <span className="activityType purchase">用户认购</span>
                  <strong>{shortAddress(event.account)}</strong>
                  <span className="activityPackages">{formatInteger(event.packages)} 份</span>
                  <small>{formatUnits(event.tokenAmount)} PES</small>
                  <time className="activityTime" dateTime={event.timestamp ? new Date(Number(event.timestamp) * 1000).toISOString() : undefined}>
                    {formatActivityTime(event.timestamp)}
                  </time>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="activityEmpty">暂无新的链上动态。连接钱包后会自动刷新认购和释放数据。</div>
      )}
    </div>
  );
}

function Notice({ notice, onDismiss }) {
  if (!notice?.message) return null;
  const Icon = notice.type === "error" ? AlertTriangle : notice.type === "success" ? CheckCircle2 : Clock;
  return (
    <div className={`notice ${notice.type || "info"}`}>
      <Icon size={18} />
      <span>{notice.message}</span>
      <button onClick={onDismiss}>关闭</button>
    </div>
  );
}

function ConfigPanel({ config, setConfig, onSave, number = "01", title = "合约配置" }) {
  return (
    <Section
      number={number}
      title={title}
      actions={
        <Button icon={Save} onClick={onSave}>
          保存
        </Button>
      }
    >
      <div className="formGrid four">
        <Field label="PES 合约地址">
          <input value={config.pesAddress} onChange={(event) => setConfig({ ...config, pesAddress: event.target.value })} />
        </Field>
        <Field label="私募释放合约地址">
          <input
            value={config.presaleAddress}
            onChange={(event) => setConfig({ ...config, presaleAddress: event.target.value })}
          />
        </Field>
        <Field label="支付代币地址">
          <input
            value={config.paymentTokenAddress}
            onChange={(event) => setConfig({ ...config, paymentTokenAddress: event.target.value })}
          />
        </Field>
        <Field label="AMM 交易对地址">
          <input
            value={config.ammPairAddress}
            onChange={(event) => setConfig({ ...config, ammPairAddress: event.target.value })}
          />
        </Field>
      </div>
      <div className="formGrid">
        <Field label="DEX 交易页面链接">
          <input value={config.dexUrl} onChange={(event) => setConfig({ ...config, dexUrl: event.target.value })} />
        </Field>
      </div>
    </Section>
  );
}

function ClientPanel({
  data,
  payment,
  saleEvents,
  account,
  config,
  buyPackages,
  setBuyPackages,
  busy,
  runTransaction,
  contractsReady,
  ipPolicy,
  recordIpPurchase,
  number = "01",
  title = "用户端",
}) {
  const totalPackages = data?.maxPackages || 0n;
  const totalAllocated = data?.totalPackagesAllocated || 0n;
  const publicSold = data?.publicPackagesSold || 0n;
  const publicRemaining = positiveRemaining(totalPackages, totalAllocated);
  const ownerAllocated = totalAllocated > publicSold ? totalAllocated - publicSold : 0n;
  const ownerRemaining = positiveRemaining(OWNER_ALLOCATION_TARGET, ownerAllocated);
  const walletPackageLimit = data?.perWalletPackageLimit || 1n;
  const accountPackages = data?.allocation?.packages || 0n;
  const walletRemaining = positiveRemaining(walletPackageLimit, accountPackages);
  const ipPolicyReady = Boolean(ipPolicy?.ok && ipPolicy?.enabled);
  const ipWhitelisted = Boolean(ipPolicyReady && ipPolicy?.whitelisted);
  const ipRemaining = ipWhitelisted
    ? publicRemaining
    : ipPolicyReady
      ? BigInt(Math.max(0, Number(ipPolicy.remainingPackages || 0)))
      : 0n;
  const purchaseLimit = minBigInt(publicRemaining, walletRemaining, ipRemaining);
  const requestedBuyPackages = parsePositiveBigIntInput(buyPackages);
  const payableBuyPackages =
    purchaseLimit === 0n ? 0n : requestedBuyPackages > purchaseLimit ? purchaseLimit : requestedBuyPackages;
  const paymentRequired = data?.paymentPerPackage ? data.paymentPerPackage * payableBuyPackages : 0n;
  const allowance = payment?.allowance || 0n;
  const needsApprove = paymentRequired > allowance;
  const presaleAddress = normalizeAddress(config.presaleAddress);
  const paymentLabel = `${formatUnits(data?.paymentPerPackage || 0n, payment?.decimals || 18, 2)} ${payment?.symbol || "USDT"}`;
  const progressLabel = `${formatPlainInteger(totalAllocated)}/${formatPlainInteger(totalPackages)}`;
  const saleState = saleStatus(data);
  const purchaseButtonText = !account ? "立即认购" : needsApprove ? "授权并购买" : "立即认购";
  const vestingPeriodLabel = formatPeriodSeconds(data?.vestingPeriodSeconds || 86_400n);
  const vestingPeriodsLabel = formatInteger(data?.vestingPeriods || 40n);
  const ipLimitLabel = ipWhitelisted
    ? "当前 IP 已在白名单，不受 IP 份数限制。"
    : ipPolicyReady
      ? `当前 IP 限购 ${Math.max(0, Number(ipPolicy.packageLimit || 1))} 份，已购 ${Math.max(0, Number(ipPolicy.usedPackages || 0))} 份，剩余 ${Math.max(0, Number(ipPolicy.remainingPackages || 0))} 份。`
      : ipPolicy?.loading
        ? "正在读取 IP 限购状态，读取完成后可认购。"
        : `IP 限购状态读取失败，暂不能认购${ipPolicy?.error ? `：${ipPolicy.error}` : "。"}`;

  return (
    <Section
      number={number}
      title={title}
      actions={
        config.dexUrl ? (
          <a className="linkButton" href={config.dexUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            <span>打开交易页</span>
          </a>
        ) : null
      }
    >
      <div className="clientOverview">
        <div className="clientHero">
          <div className="clientHeroContent">
            <div className="clientHeroTop">
              <span className="clientKicker">PES PRESALE</span>
              <span className="statusPill">{saleState}</span>
            </div>
            <h3>{formatUnits(data?.pesPerPackage || 0n)} PES / 份</h3>
            <p className="clientLead">
              每份支付 {paymentLabel}，上线满 1 个周期先释放 20%，之后每个已过周期追加释放剩余 80% / {vestingPeriodsLabel}，每周期 {vestingPeriodLabel}。
            </p>
            <div className="clientHeroActions">
              <a className="linkButton heroCta" href="#purchase-panel">
                <ShoppingCart size={16} />
                <span>立即认购</span>
              </a>
              {config.dexUrl ? (
                <a className="linkButton" href={config.dexUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} />
                  <span>打开交易页</span>
                </a>
              ) : null}
            </div>
            <div className="heroNumbers">
              <div>
                <span>单份价格</span>
                <strong>{paymentLabel}</strong>
              </div>
              <div>
                <span>公开剩余</span>
                <strong>{formatInteger(publicRemaining)}</strong>
              </div>
              <div>
                <span>认购进度</span>
                <strong>{progressLabel}</strong>
              </div>
            </div>
          </div>

          <div className="tokenVisual" aria-hidden="true">
            <div className="tokenDisk">
              <img src="/pes-coin.svg" alt="" />
            </div>
            <div className="tokenVisualMeta">
              <span>BSC MAINNET</span>
              <strong>20% + {vestingPeriodsLabel} periods</strong>
              <small>Vesting Schedule</small>
            </div>
            <div className="tokenBars">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      </div>

      <div className="metricGrid">
        <Metric label="认购状态" value={saleStatus(data)} note={`${formatTimestamp(data?.saleStart)} - ${formatTimestamp(data?.saleEnd)}`} />
        <Metric label="上线状态" value={launchStatus(data)} note={formatTimestamp(data?.launchTime)} />
        <Metric label="单份价格" value={`${formatUnits(data?.paymentPerPackage || 0n, payment?.decimals || 18, 2)} ${payment?.symbol || "USDT"}`} />
        <Metric label="单份 PES" value={`${formatUnits(data?.pesPerPackage || 0n)} PES`} />
        <Metric label="公开剩余份数" value={formatInteger(publicRemaining)} note={`总份数 ${formatInteger(totalPackages)}`} />
        <Metric label="Owner待发放" value={formatInteger(ownerRemaining)} note={`目标 ${formatInteger(OWNER_ALLOCATION_TARGET)} 份`} />
      </div>

      <ActivityTicker events={saleEvents} />

      <div className="splitLayout">
        <div className="surfacePanel purchasePanel" id="purchase-panel">
          <div className="panelHeader">
            <div>
              <span className="panelKicker">PURCHASE</span>
              <h3>公开认购</h3>
            </div>
            <span className="panelStatus">{payment?.symbol || "USDT"}</span>
          </div>
          <Progress value={totalAllocated} total={totalPackages} />
          <div className="formGrid two">
            <Field label="购买份数">
              <input
                min="1"
                max={purchaseLimit > 0n ? purchaseLimit.toString() : "1"}
                type="number"
                value={buyPackages}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "") {
                    setBuyPackages("");
                    return;
                  }

                  if (!/^\d+$/.test(nextValue)) return;
                  const parsed = BigInt(nextValue);
                  if (parsed === 0n) {
                    setBuyPackages("1");
                    return;
                  }

                  const capped = purchaseLimit > 0n ? minBigInt(parsed, purchaseLimit) : 1n;
                  setBuyPackages(capped.toString());
                }}
              />
            </Field>
            <Field label="需支付">
              <input readOnly value={`${formatUnits(paymentRequired, payment?.decimals || 18, 2)} ${payment?.symbol || "USDT"}`} />
            </Field>
          </div>
          <p className="purchaseLimitHint">
            每个账号限购 {formatInteger(walletPackageLimit)} 份，当前账号剩余 {formatInteger(walletRemaining)} 份。
          </p>
          <p className="purchaseLimitHint">{ipLimitLabel}</p>
          <div className="transactionChecklist" aria-label="购买前检查">
            <div>
              <span>付款代币</span>
              <strong>{payment?.symbol || "USDT"}</strong>
            </div>
            <div>
              <span>当前授权</span>
              <strong>{formatUnits(allowance, payment?.decimals || 18, 2)}</strong>
            </div>
            <div>
              <span>接收额度</span>
              <strong>{formatUnits((data?.pesPerPackage || 0n) * payableBuyPackages)} PES</strong>
            </div>
            <div>
              <span>私募合约</span>
              <strong>{shortAddress(presaleAddress)}</strong>
            </div>
            <div>
              <span>当前 IP</span>
              <strong>{ipPolicy?.ip || "--"}</strong>
            </div>
            <div>
              <span>IP 剩余额度</span>
              <strong>{ipWhitelisted ? "白名单" : `${formatInteger(ipRemaining)} 份`}</strong>
            </div>
          </div>
          <div className="buttonRow">
            <Button
              icon={ShoppingCart}
              busy={busy === "approvePurchase"}
              disabled={!account || !contractsReady || !ipPolicyReady || paymentRequired === 0n || purchaseLimit === 0n}
              onClick={() =>
                runTransaction(needsApprove ? "授权并购买 PES 份额" : "购买 PES 份额", "approvePurchase", async ({
                  paymentToken,
                  presale,
                  presaleAddress,
                  notify,
                }) => {
                  if (needsApprove) {
                    notify("info", `等待钱包确认 ${payment?.symbol || "USDT"} 授权`);
                    const approveTx = await paymentToken.approve(presaleAddress, paymentRequired);
                    notify("info", `授权交易已提交 ${approveTx.hash}`);
                    await approveTx.wait();
                    notify("info", "授权已确认，继续购买 PES 份额");
                  }

                  const tx = await presale.purchasePackages(payableBuyPackages);
                  return {
                    tx,
                    afterConfirmed: async (receipt) => {
                      try {
                        await recordIpPurchase?.({
                          account,
                          packages: Number(payableBuyPackages),
                          transactionHash: receipt?.hash || tx.hash,
                        });
                      } catch (error) {
                        notify("error", `IP 限购记录失败：${getErrorMessage(error)}`);
                      }
                    },
                  };
                })
              }
          >
              {purchaseButtonText}
            </Button>
          </div>
        </div>

        <div className="surfacePanel vestingPanel">
          <div className="panelHeader">
            <div>
              <span className="panelKicker">VESTING</span>
              <h3>我的释放</h3>
            </div>
            <span className="panelStatus">PES</span>
          </div>
          <div className="dataList">
            <span>我的份数</span>
            <strong>{formatInteger(data?.allocation?.packages || 0n)}</strong>
            <span>总额度</span>
            <strong>{formatUnits(data?.allocation?.tokens || 0n)} PES</strong>
            <span>已释放</span>
            <strong>{formatUnits(data?.vested || 0n)} PES</strong>
            <span>已领取</span>
            <strong>{formatUnits(data?.allocation?.claimed || 0n)} PES</strong>
            <span>可领取</span>
            <strong>{formatUnits(data?.claimable || 0n)} PES</strong>
            <span>PES 余额</span>
            <strong>{formatUnits(data?.pesBalance || 0n)} PES</strong>
            <span>{payment?.symbol || "USDT"} 余额</span>
            <strong>{formatUnits(payment?.balance || 0n, payment?.decimals || 18, 2)}</strong>
            {data?.autoDistributionSupported ? (
              <>
                <span>发放方式</span>
                <strong>{data?.manualClaimEnabled ? "手动领取" : "系统自动发放"}</strong>
                <span>下次计划周期</span>
                <strong>{formatInteger(data?.currentScheduledElapsedPeriods || 0n)}</strong>
              </>
            ) : null}
          </div>
          {data?.manualClaimEnabled ? (
            <Button
              icon={Coins}
              variant="primary"
              busy={busy === "claim"}
              disabled={!account || !contractsReady || !data?.claimable || data.claimable === 0n}
              onClick={() => runTransaction("领取 PES", "claim", async ({ presale }) => presale.claim())}
            >
              领取已释放 PES
            </Button>
          ) : (
            <div className="emptyState">PES 将由系统按释放计划自动发放到购买钱包，无需手动领取。</div>
          )}
        </div>
      </div>
    </Section>
  );
}

function AdminPanel({
  data,
  token,
  payment,
  config,
  setConfig,
  account,
  signer,
  ipPolicy,
  refreshIpPolicy,
  adminAllocations = [],
  recordAdminAllocations,
  busy,
  runTransaction,
  notify,
  refreshData,
  number = "02",
  title = "Admin 管理",
}) {
  const [saleForm, setSaleForm] = useState({ start: "", end: "" });
  const [launchForm, setLaunchForm] = useState("");
  const [vestingForm, setVestingForm] = useState({ periodDays: "1", periods: "40", elapsedPeriods: "0" });
  const [packageForm, setPackageForm] = useState({
    paymentPerPackage: "300",
    pesPerPackage: "3000",
    maxPackages: "1000",
    publicPackageCap: "1000",
    perWalletPackageLimit: "1",
  });
  const [ownerTransfer, setOwnerTransfer] = useState({ pesOwner: "", presaleOwner: "" });
  const [fundsWallet, setFundsWallet] = useState("");
  const [feeWallets, setFeeWallets] = useState({ liquidityWallet: "", operationsWallet: "" });
  const [buyFees, setBuyFees] = useState({ liquidityBps: "50", operationsBps: "50", burnBps: "50" });
  const [sellFees, setSellFees] = useState({ liquidityBps: "50", operationsBps: "50", burnBps: "50" });
  const [allocation, setAllocation] = useState({ account: "", packages: "1" });
  const [batchText, setBatchText] = useState("");
  const [batchChunkSize, setBatchChunkSize] = useState(String(DEFAULT_ALLOCATION_CHUNK_SIZE));
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [allocationSearch, setAllocationSearch] = useState("");
  const [feeExclusion, setFeeExclusion] = useState({ account: "", excluded: "true" });
  const [ipWhitelistForm, setIpWhitelistForm] = useState({ ip: "", note: "" });
  const [fundPresaleAmount, setFundPresaleAmount] = useState("2000000");
  const [distributionProgress, setDistributionProgress] = useState({ current: 0, total: 0 });

  useEffect(() => {
    setSaleForm({ start: toDateTimeLocal(data?.saleStart), end: toDateTimeLocal(data?.saleEnd) });
    setLaunchForm(toDateTimeLocal(data?.launchTime));
    setVestingForm({
      periodDays: secondsToDays(data?.vestingPeriodSeconds || 86_400n),
      periods: String(data?.vestingPeriods || 40n),
      elapsedPeriods: String(data?.elapsedVestingPeriods || 0n),
    });
    setPackageForm({
      paymentPerPackage: formatUnits(data?.paymentPerPackage || 0n, payment?.decimals || 18, 2).replace(/,/g, ""),
      pesPerPackage: formatUnits(data?.pesPerPackage || 0n, 18, 2).replace(/,/g, ""),
      maxPackages: String(data?.maxPackages || 0n),
      publicPackageCap: String(data?.publicPackageCap || 0n),
      perWalletPackageLimit: String(data?.perWalletPackageLimit || 0n),
    });
    setFundsWallet(data?.fundsWallet || "");
    setFeeWallets({
      liquidityWallet: token?.liquidityWallet || "",
      operationsWallet: token?.operationsWallet || "",
    });
    if (token?.buyFees) {
      setBuyFees({
        liquidityBps: String(token.buyFees.liquidityBps),
        operationsBps: String(token.buyFees.operationsBps),
        burnBps: String(token.buyFees.burnBps),
      });
    }
    if (token?.sellFees) {
      setSellFees({
        liquidityBps: String(token.sellFees.liquidityBps),
        operationsBps: String(token.sellFees.operationsBps),
        burnBps: String(token.sellFees.burnBps),
      });
    }
  }, [data, token, payment?.decimals]);

  const accountAddress = normalizeAddress(account);
  const presaleOwnerAddress = normalizeAddress(data?.owner);
  const tokenOwnerAddress = normalizeAddress(token?.owner);
  const isPresaleOwner = Boolean(accountAddress && presaleOwnerAddress && presaleOwnerAddress === accountAddress);
  const isTokenOwner = Boolean(accountAddress && tokenOwnerAddress && tokenOwnerAddress === accountAddress);
  const isOwner = isPresaleOwner || isTokenOwner;
  const keeperAddress = normalizeAddress(data?.keeper);
  const isKeeper = Boolean(accountAddress && keeperAddress && keeperAddress === accountAddress);
  const canRunDistribution = isPresaleOwner || isKeeper;
  const scheduleLag = useMemo(
    () => getScheduleLag(data?.elapsedVestingPeriods || 0n, data?.currentScheduledElapsedPeriods || 0n),
    [data?.currentScheduledElapsedPeriods, data?.elapsedVestingPeriods]
  );
  const scheduleAligned = scheduleLag === 0n;
  const catchUpPesPerUser = useMemo(
    () =>
      estimateCatchUpPesPerUser(
        data?.pesPerPackage || 0n,
        data?.elapsedVestingPeriods || 0n,
        data?.currentScheduledElapsedPeriods || 0n,
        data?.vestingPeriods || 40n
      ),
    [data?.currentScheduledElapsedPeriods, data?.elapsedVestingPeriods, data?.pesPerPackage, data?.vestingPeriods]
  );
  const dailyDistributionPes = useMemo(
    () => estimateDailyDistributionPes(data?.pesPerPackage || 0n, DISTRIBUTION_BUYER_COUNT, data?.vestingPeriods || 40n),
    [data?.pesPerPackage, data?.vestingPeriods]
  );
  const fundShortfall = useMemo(() => {
    const target = ethers.parseUnits(fundPresaleAmount || "0", 18);
    const current = data?.presalePesBalance || 0n;
    return target > current ? target - current : 0n;
  }, [data?.presalePesBalance, fundPresaleAmount]);
  const adminPublicSold = data?.publicPackagesSold || 0n;
  const adminTotalAllocated = data?.totalPackagesAllocated || 0n;
  const adminOwnerAllocated = adminTotalAllocated > adminPublicSold ? adminTotalAllocated - adminPublicSold : 0n;
  const adminRemaining = positiveRemaining(data?.maxPackages || 0n, adminTotalAllocated);
  const visibleAdminAllocations = useMemo(() => {
    const keyword = allocationSearch.trim().toLowerCase();
    if (!keyword) return adminAllocations;
    return adminAllocations.filter((entry) => entry.account.toLowerCase().includes(keyword));
  }, [adminAllocations, allocationSearch]);
  const batchSummary = useMemo(() => {
    if (!batchText.trim()) return null;
    try {
      const parsed = parseBatchAllocations(batchText);
      const chunkSize = parseAllocationChunkSize(batchChunkSize);
      const uniqueAccounts = new Set(parsed.map((entry) => entry.account.toLowerCase()));
      const totalPackages = parsed.reduce((sum, entry) => sum + entry.packages, 0n);

      return {
        count: parsed.length,
        chunkSize,
        duplicateCount: parsed.length - uniqueAccounts.size,
        totalPackages,
        chunks: Math.ceil(parsed.length / chunkSize),
        exceedsRemaining: totalPackages > adminRemaining,
      };
    } catch (error) {
      return { error: getErrorMessage(error) };
    }
  }, [adminRemaining, batchChunkSize, batchText]);

  const saveIpWhitelist = useCallback(async () => {
    const ip = ipWhitelistForm.ip.trim();
    if (!ip) throw new Error("请输入 IP 地址");
    const signed = await signIpPolicyAdminAction(signer, "setWhitelist", ip);
    await postIpPolicy({
      action: "setWhitelist",
      ip,
      note: ipWhitelistForm.note,
      ...signed,
    });
    await refreshIpPolicy?.(true);
  }, [ipWhitelistForm.ip, ipWhitelistForm.note, refreshIpPolicy, signer]);

  const removeIpWhitelist = useCallback(
    async (ip) => {
      const signed = await signIpPolicyAdminAction(signer, "removeWhitelist", ip);
      await postIpPolicy({ action: "removeWhitelist", ip, ...signed });
      await refreshIpPolicy?.(true);
    },
    [refreshIpPolicy, signer]
  );

  return (
    <Section
      number={number}
      title={title}
      actions={
        <Button icon={RefreshCw} variant="secondary" onClick={refreshData}>
          刷新
        </Button>
      }
    >
      <div className="statusStrip">
        <span>当前钱包: {account ? shortAddress(account) : "未连接"}</span>
        <span>私募 Owner: {shortAddress(data?.owner)}</span>
        <span>PES Owner: {shortAddress(token?.owner)}</span>
        <span>Admin 权限: {isOwner ? "匹配" : "未匹配"}</span>
      </div>

      <div className="adminOverview">
        <Metric label="公开认购" value={`${formatInteger(adminPublicSold)} / ${formatInteger(data?.publicPackageCap || 0n)}`} />
        <Metric label="剩余份数" value={formatInteger(adminRemaining)} note={`总份数 ${formatInteger(data?.maxPackages || 0n)}`} />
        <Metric label="Owner发放" value={`${formatInteger(adminOwnerAllocated)} / ${formatInteger(OWNER_ALLOCATION_TARGET)}`} />
        <Metric label="已分配 PES" value={`${formatUnits(data?.totalTokensAllocated || 0n)} PES`} />
        <Metric label="已领取 PES" value={`${formatUnits(data?.totalTokensClaimed || 0n)} PES`} />
        <Metric label="交易状态" value={token?.tradingEnabled ? "已开启" : "未开启"} />
        <Metric label="合约暂停" value={token?.paused || data?.paused ? "有暂停项" : "正常"} />
      </div>

      <div className="adminGrid">
        <div className="surfacePanel">
          <h3>Owner Transfer</h3>
          <div className="formGrid two">
            <Field label="New PES Owner">
              <input
                value={ownerTransfer.pesOwner}
                onChange={(event) => setOwnerTransfer({ ...ownerTransfer, pesOwner: event.target.value })}
                placeholder={token?.owner || "0x..."}
              />
            </Field>
            <Field label="New Presale Owner">
              <input
                value={ownerTransfer.presaleOwner}
                onChange={(event) => setOwnerTransfer({ ...ownerTransfer, presaleOwner: event.target.value })}
                placeholder={data?.owner || "0x..."}
              />
            </Field>
          </div>
          <div className="buttonRow">
            <Button
              icon={ShieldCheck}
              variant="secondary"
              busy={busy === "transferPesOwner"}
              disabled={
                !isTokenOwner ||
                !isAddress(ownerTransfer.pesOwner) ||
                normalizeAddress(ownerTransfer.pesOwner) === tokenOwnerAddress
              }
              onClick={() => {
                if (!window.confirm("Transfer PES owner? The current wallet will lose PES owner permissions.")) return;
                runTransaction("Transfer PES Owner", "transferPesOwner", async ({ pes }) =>
                  pes.transferOwnership(ownerTransfer.pesOwner)
                );
              }}
            >
              Transfer PES Owner
            </Button>
            <Button
              icon={ShieldCheck}
              variant="secondary"
              busy={busy === "transferPresaleOwner"}
              disabled={
                !isPresaleOwner ||
                !isAddress(ownerTransfer.presaleOwner) ||
                normalizeAddress(ownerTransfer.presaleOwner) === presaleOwnerAddress
              }
              onClick={() => {
                if (!window.confirm("Transfer Presale owner? The current wallet will lose Presale owner permissions.")) return;
                runTransaction("Transfer Presale Owner", "transferPresaleOwner", async ({ presale }) =>
                  presale.transferOwnership(ownerTransfer.presaleOwner)
                );
              }}
            >
              Transfer Presale Owner
            </Button>
          </div>
          <div className="emptyState">
            Current PES Owner: {shortAddress(token?.owner)} / Current Presale Owner: {shortAddress(data?.owner)}
          </div>
        </div>

        <div className="surfacePanel">
          <h3>私募参数</h3>
          <div className="formGrid two">
            <Field label="认购开始时间">
              <input type="datetime-local" value={saleForm.start} onChange={(event) => setSaleForm({ ...saleForm, start: event.target.value })} />
            </Field>
            <Field label="认购结束时间">
              <input type="datetime-local" value={saleForm.end} onChange={(event) => setSaleForm({ ...saleForm, end: event.target.value })} />
            </Field>
          </div>
          <Button
            icon={Clock}
            busy={busy === "setSaleWindow"}
            disabled={!isOwner}
            onClick={() =>
              runTransaction("设置认购时间", "setSaleWindow", async ({ presale }) =>
                presale.setSaleWindow(fromDateTimeLocal(saleForm.start), fromDateTimeLocal(saleForm.end))
              )
            }
          >
            保存认购时间
          </Button>

          <div className="divider" />
          <Field label="上线时间">
            <input type="datetime-local" value={launchForm} onChange={(event) => setLaunchForm(event.target.value)} />
          </Field>
          <Button
            icon={Clock}
            busy={busy === "setLaunchTime"}
            disabled={!isOwner}
            onClick={() =>
              runTransaction("设置上线时间", "setLaunchTime", async ({ presale }) =>
                presale.setLaunchTime(fromDateTimeLocal(launchForm))
              )
            }
          >
            保存上线时间
          </Button>

          <div className="divider" />
          <h4>释放周期</h4>
          <div className="formGrid two">
            <Field label="周期时间(天)">
              <input
                type="number"
                min="0.0001"
                step="0.0001"
                value={vestingForm.periodDays}
                onChange={(event) => setVestingForm({ ...vestingForm, periodDays: event.target.value })}
              />
            </Field>
            <Field label="周期数">
              <input
                type="number"
                min="1"
                step="1"
                value={vestingForm.periods}
                onChange={(event) => setVestingForm({ ...vestingForm, periods: event.target.value })}
              />
            </Field>
            <Field label={"\u5df2\u8fc7\u5468\u671f\u6570"}>
              <input
                type="number"
                min="0"
                step="1"
                value={vestingForm.elapsedPeriods}
                onChange={(event) => setVestingForm({ ...vestingForm, elapsedPeriods: event.target.value })}
              />
            </Field>
          </div>
          <Button
            icon={SlidersHorizontal}
            variant="secondary"
            busy={busy === "setVestingConfig"}
            disabled={!isOwner || !data?.vestingConfigSupported}
            onClick={() =>
              runTransaction("设置释放周期", "setVestingConfig", async ({ presale }) =>
                data?.vestingProgressSupported
                  ? presale.setVestingConfigAndProgress(
                      daysToSeconds(vestingForm.periodDays),
                      Number(vestingForm.periods || "0"),
                      Number(vestingForm.elapsedPeriods || "0")
                    )
                  : presale.setVestingConfig(daysToSeconds(vestingForm.periodDays), Number(vestingForm.periods || "0"))
              )
            }
          >
            保存释放周期
          </Button>
          {!data?.vestingProgressSupported ? (
            <div className="emptyState">
              {"\u5f53\u524d\u79c1\u52df\u5408\u7ea6\u4e0d\u652f\u6301\u5df2\u8fc7\u5468\u671f\u6570\u914d\u7f6e\uff1b\u65b0\u5408\u7ea6\u90e8\u7f72\u540e\u53ef\u52a8\u6001\u8c03\u6574\u5df2\u91ca\u653e\u6570\u91cf\u3002"}
            </div>
          ) : null}
          {!data?.vestingConfigSupported ? (
            <div className="emptyState">当前私募合约不支持释放周期设置；新合约部署后可在这里配置。</div>
          ) : null}
        </div>

        {data?.autoDistributionSupported ? (
          <div className="surfacePanel">
            <div className="panelHeader">
              <div>
                <span className="panelKicker">AUTO DISTRIBUTION</span>
                <h3>自动发放运维</h3>
              </div>
              <span className="panelStatus">{scheduleAligned ? "已对齐" : `落后 ${formatInteger(scheduleLag)} 期`}</span>
            </div>
            <div className="dataList">
              <span>已执行期数</span>
              <strong>{formatInteger(data?.elapsedVestingPeriods || 0n)}</strong>
              <span>计划应到期数</span>
              <strong>{formatInteger(data?.currentScheduledElapsedPeriods || 0n)}</strong>
              <span>归属合约 PES 余额</span>
              <strong>{formatUnits(data?.presalePesBalance || 0n)} PES</strong>
              <span>已领取总量</span>
              <strong>{formatUnits(data?.totalTokensClaimed || 0n)} PES</strong>
              <span>未领取总量</span>
              <strong>{formatUnits(data?.unclaimedAllocatedTokens || 0n)} PES</strong>
              <span>每日释放预估</span>
              <strong>{formatUnits(dailyDistributionPes)} PES</strong>
              {!scheduleAligned ? (
                <>
                  <span>若直接发放将补发</span>
                  <strong>{formatUnits(catchUpPesPerUser)} PES / 人</strong>
                </>
              ) : null}
              <span>Keeper</span>
              <strong>{shortAddress(data?.keeper)}</strong>
            </div>
            {!scheduleAligned ? (
              <div className="emptyState">
                当前计划期数领先已执行期数 {formatInteger(scheduleLag)} 期。请先点击「对齐释放进度（不补发）」，再补充 PES 并触发发放。
              </div>
            ) : null}
            <div className="formGrid two">
              <Field label="补款目标余额 (PES)">
                <input
                  value={fundPresaleAmount}
                  onChange={(event) => setFundPresaleAmount(event.target.value)}
                  placeholder="2000000"
                />
              </Field>
              <Field label="本次需转入">
                <input value={formatUnits(fundShortfall)} readOnly />
              </Field>
            </div>
            <div className="buttonRow">
              <Button
                icon={Clock}
                variant="secondary"
                busy={busy === "alignAutoDistribution"}
                disabled={!isPresaleOwner || data?.paused || scheduleAligned || !(data?.elapsedVestingPeriods > 0n)}
                onClick={() => {
                  if (
                    !window.confirm(
                      "将回拨自动释放起点，使计划期数与已执行期数对齐。不会补发逾期份额，之后按日继续释放。确认执行？"
                    )
                  ) {
                    return;
                  }
                  runTransaction("对齐释放进度", "alignAutoDistribution", async ({ presale }) => {
                    const elapsed = data?.elapsedVestingPeriods || 0n;
                    const periodSeconds = data?.autoDistributionPeriodSeconds || 86_400n;
                    const newStart = computeAlignedAutoDistributionStart(elapsed, periodSeconds);
                    return presale.setAutoDistributionSchedule(newStart, periodSeconds);
                  });
                }}
              >
                对齐释放进度（不补发）
              </Button>
              <Button
                icon={Coins}
                variant="secondary"
                busy={busy === "fundPresaleVesting"}
                disabled={!account || fundShortfall === 0n}
                onClick={() => {
                  if (
                    !window.confirm(
                      `向归属合约转入 ${formatUnits(fundShortfall)} PES？当前钱包需持有足够 PES 并支付 Gas。`
                    )
                  ) {
                    return;
                  }
                  runTransaction("补充归属合约 PES", "fundPresaleVesting", async ({ pes, presaleAddress }) =>
                    pes.transfer(presaleAddress, fundShortfall)
                  );
                }}
              >
                补充 PES 到归属合约
              </Button>
              <Button
                icon={Zap}
                busy={busy === "runAutoDistribution"}
                disabled={
                  !canRunDistribution ||
                  data?.paused ||
                  !scheduleAligned ||
                  !(data?.currentScheduledElapsedPeriods > 0n)
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      `将按 ${DISTRIBUTION_BUYER_COUNT} 个地址、${DISTRIBUTION_BATCH_SIZE} 个一批调用 distributeVested。确认执行？`
                    )
                  ) {
                    return;
                  }
                  runTransaction("触发自动发放", "runAutoDistribution", async ({ presale, notify }) => {
                    const chunks = chunkArray(DISTRIBUTION_BUYERS, DISTRIBUTION_BATCH_SIZE);
                    setDistributionProgress({ current: 0, total: chunks.length });

                    for (let index = 0; index < chunks.length; index += 1) {
                      const accounts = chunks[index];
                      const start = index * DISTRIBUTION_BATCH_SIZE + 1;
                      const end = start + accounts.length - 1;

                      notify("info", `自动发放 ${index + 1}/${chunks.length}: 等待钱包确认 ${start}-${end}`);
                      const estimatedGas = await presale.distributeVested.estimateGas(accounts);
                      const gasLimit = (estimatedGas * 12n) / 10n;
                      const tx = await presale.distributeVested(accounts, { gasLimit });
                      notify("info", `自动发放 ${index + 1}/${chunks.length}: 等待链上确认 ${tx.hash}`);
                      await tx.wait();
                      setDistributionProgress({ current: index + 1, total: chunks.length });
                    }
                  });
                }}
              >
                触发自动发放
              </Button>
            </div>
            {distributionProgress.total ? (
              <div className="batchProgress">
                已完成 {distributionProgress.current} / {distributionProgress.total} 批
              </div>
            ) : null}
            <div className="emptyState">
              推荐顺序：① 对齐释放进度 → ② 补充 PES → ③ 触发自动发放。Keeper 或 Presale Owner 钱包可执行发放；补款可使用任意持有 PES 的钱包。
            </div>
          </div>
        ) : null}

        <div className="surfacePanel">
          <h3>份额配置</h3>
          <div className="formGrid two">
            <Field label={`每份价格(${payment?.symbol || "USDT"})`}>
              <input
                value={packageForm.paymentPerPackage}
                onChange={(event) => setPackageForm({ ...packageForm, paymentPerPackage: event.target.value })}
              />
            </Field>
            <Field label="每份 PES">
              <input
                value={packageForm.pesPerPackage}
                onChange={(event) => setPackageForm({ ...packageForm, pesPerPackage: event.target.value })}
              />
            </Field>
            <Field label="总份数">
              <input value={packageForm.maxPackages} onChange={(event) => setPackageForm({ ...packageForm, maxPackages: event.target.value })} />
            </Field>
            <Field label="公开份数上限">
              <input
                value={packageForm.publicPackageCap}
                onChange={(event) => setPackageForm({ ...packageForm, publicPackageCap: event.target.value })}
              />
            </Field>
            <Field label="单钱包份数上限">
              <input
                value={packageForm.perWalletPackageLimit}
                onChange={(event) => setPackageForm({ ...packageForm, perWalletPackageLimit: event.target.value })}
              />
            </Field>
          </div>
          <Button
            icon={SlidersHorizontal}
            busy={busy === "setPackageConfig"}
            disabled={!isOwner}
            onClick={() =>
              runTransaction("设置份额配置", "setPackageConfig", async ({ presale }) =>
                presale.setPackageConfig(
                  ethers.parseUnits(packageForm.paymentPerPackage || "0", payment?.decimals || 18),
                  ethers.parseUnits(packageForm.pesPerPackage || "0", 18),
                  BigInt(packageForm.maxPackages || "0"),
                  BigInt(packageForm.publicPackageCap || "0"),
                  BigInt(packageForm.perWalletPackageLimit || "0")
                )
              )
            }
          >
            保存份额配置
          </Button>
        </div>

        <div className="surfacePanel">
          <h3>收款与交易</h3>
          <Field label="USDT 收款钱包">
            <input value={fundsWallet} onChange={(event) => setFundsWallet(event.target.value)} />
          </Field>
          <Button
            icon={Save}
            busy={busy === "setFundsWallet"}
            disabled={!isOwner || !isAddress(fundsWallet)}
            onClick={() =>
              runTransaction("设置收款钱包", "setFundsWallet", async ({ presale }) => presale.setFundsWallet(fundsWallet))
            }
          >
            保存收款钱包
          </Button>

          <div className="divider" />
          <Field label="AMM 交易对地址">
            <input value={config.ammPairAddress} onChange={(event) => setConfig({ ...config, ammPairAddress: event.target.value })} />
          </Field>
          <div className="buttonRow">
            <Button
              icon={Database}
              variant="secondary"
              busy={busy === "setPair"}
              disabled={!isOwner || !isAddress(config.ammPairAddress)}
              onClick={() =>
                runTransaction("设置 AMM 交易对", "setPair", async ({ pes }) =>
                  pes.setAutomatedMarketMakerPair(config.ammPairAddress, true)
                )
              }
            >
              设置交易对
            </Button>
            <Button
              icon={Power}
              busy={busy === "enableTrading"}
              disabled={!isOwner}
              onClick={() =>
                runTransaction("开启交易", "enableTrading", async ({ pes }) => pes.setTradingEnabled(true))
              }
            >
              开启交易
            </Button>
          </div>
        </div>

        <div className="surfacePanel">
          <h3>手续费</h3>
          <div className="formGrid two">
            <Field label="LP 钱包">
              <input
                value={feeWallets.liquidityWallet}
                onChange={(event) => setFeeWallets({ ...feeWallets, liquidityWallet: event.target.value })}
              />
            </Field>
            <Field label="运营钱包">
              <input
                value={feeWallets.operationsWallet}
                onChange={(event) => setFeeWallets({ ...feeWallets, operationsWallet: event.target.value })}
              />
            </Field>
          </div>
          <Button
            icon={Save}
            variant="secondary"
            busy={busy === "setFeeWallets"}
            disabled={!isOwner || !isAddress(feeWallets.liquidityWallet) || !isAddress(feeWallets.operationsWallet)}
            onClick={() =>
              runTransaction("设置手续费钱包", "setFeeWallets", async ({ pes }) =>
                pes.setFeeWallets(feeWallets.liquidityWallet, feeWallets.operationsWallet)
              )
            }
          >
            保存手续费钱包
          </Button>

          <FeeEditor title="买入手续费(BPS)" form={buyFees} setForm={setBuyFees} />
          <Button
            icon={SlidersHorizontal}
            busy={busy === "setBuyFees"}
            disabled={!isOwner}
            onClick={() =>
              runTransaction("设置买入手续费", "setBuyFees", async ({ pes }) =>
                pes.setFeeRates(true, Number(buyFees.liquidityBps), Number(buyFees.operationsBps), Number(buyFees.burnBps))
              )
            }
          >
            保存买入手续费
          </Button>

          <FeeEditor title="卖出手续费(BPS)" form={sellFees} setForm={setSellFees} />
          <Button
            icon={SlidersHorizontal}
            busy={busy === "setSellFees"}
            disabled={!isOwner}
            onClick={() =>
              runTransaction("设置卖出手续费", "setSellFees", async ({ pes }) =>
                pes.setFeeRates(false, Number(sellFees.liquidityBps), Number(sellFees.operationsBps), Number(sellFees.burnBps))
              )
            }
          >
            保存卖出手续费
          </Button>
        </div>

        <div className="surfacePanel">
          <h3>战略/生态分配</h3>
          <div className="formGrid two">
            <Field label="地址">
              <input value={allocation.account} onChange={(event) => setAllocation({ ...allocation, account: event.target.value })} />
            </Field>
            <Field label="份数">
              <input value={allocation.packages} onChange={(event) => setAllocation({ ...allocation, packages: event.target.value })} />
            </Field>
          </div>
          <Button
            icon={Users}
            busy={busy === "grantAllocation"}
            disabled={!isOwner || !isAddress(allocation.account)}
            onClick={() =>
              runTransaction("分配单个地址", "grantAllocation", async ({ presale }) =>
                presale.grantAllocation(allocation.account, BigInt(allocation.packages || "0"))
              )
            }
          >
            分配
          </Button>

          <div className="divider" />
          <Field label="批量分配(address)">
            <textarea
              rows="7"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder="0x0000000000000000000000000000000000000001"
            />
          </Field>
          <div className="formGrid two batchControls">
            <Field label="每批地址数">
              <input
                type="number"
                min="1"
                step="1"
                value={batchChunkSize}
                onChange={(event) => setBatchChunkSize(event.target.value)}
              />
            </Field>
            <div className="batchPlan">
              {batchSummary?.error ? (
                <span className="batchError">{batchSummary.error}</span>
              ) : batchSummary ? (
                <>
                  <span>{formatInteger(BigInt(batchSummary.count))} 个地址</span>
                  <span>{formatInteger(batchSummary.totalPackages)} 份</span>
                  <span>{batchSummary.chunks} 笔交易</span>
                  {batchSummary.duplicateCount ? <span>{batchSummary.duplicateCount} 个重复地址</span> : null}
                  {batchSummary.exceedsRemaining ? <span className="batchError">超过剩余份数</span> : null}
                </>
              ) : (
                <span>建议 950 个账号按 100 个一批提交</span>
              )}
            </div>
          </div>
          {batchProgress.total ? (
            <div className="batchProgress">
              已完成 {batchProgress.current} / {batchProgress.total} 批
            </div>
          ) : null}
          <Button
            icon={Upload}
            busy={busy === "grantBatch"}
            disabled={!isOwner || !batchText.trim() || Boolean(batchSummary?.error || batchSummary?.exceedsRemaining)}
            onClick={() =>
              runTransaction("批量分配", "grantBatch", async ({ presale, notify }) => {
                const parsed = parseBatchAllocations(batchText);
                const chunkSize = parseAllocationChunkSize(batchChunkSize);
                const chunks = chunkAllocations(parsed, chunkSize);
                setBatchProgress({ current: 0, total: chunks.length });

                for (let index = 0; index < chunks.length; index += 1) {
                  const chunk = chunks[index];
                  const start = index * chunkSize + 1;
                  const end = start + chunk.length - 1;

                  notify("info", `批量分配 ${index + 1}/${chunks.length}: 等待钱包确认 ${start}-${end}`);
                  const tx = await presale.grantAllocations(
                    chunk.map((entry) => entry.account),
                    chunk.map((entry) => entry.packages)
                  );
                  notify("info", `批量分配 ${index + 1}/${chunks.length}: 等待链上确认 ${tx.hash}`);
                  const receipt = await tx.wait();
                  recordAdminAllocations?.(chunk, receipt?.blockNumber || 0, tx.hash);
                  setBatchProgress({ current: index + 1, total: chunks.length });
                }
              })
            }
          >
            批量分配
          </Button>
        </div>

        <div className="surfacePanel widePanel">
          <h3>已发放账户管理</h3>
          <div className="allocationToolbar">
            <Field label="搜索账户">
              <input
                value={allocationSearch}
                onChange={(event) => setAllocationSearch(event.target.value)}
                placeholder="输入地址筛选"
              />
            </Field>
            <div className="batchPlan">
              <span>{formatInteger(BigInt(adminAllocations.length))} 个账户</span>
              <span>显示 {formatInteger(BigInt(visibleAdminAllocations.length))} 个</span>
            </div>
          </div>

          {visibleAdminAllocations.length ? (
            <div className="allocationTableWrap">
              <table className="allocationTable">
                <thead>
                  <tr>
                    <th>账户</th>
                    <th>份数</th>
                    <th>PES</th>
                    <th>发放次数</th>
                    <th>最近区块</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAdminAllocations.map((entry) => (
                    <tr key={entry.account}>
                      <td>
                        <code>{entry.account}</code>
                      </td>
                      <td>{formatInteger(entry.packages)}</td>
                      <td>{formatUnits(entry.tokenAmount)} PES</td>
                      <td>{entry.grantCount}</td>
                      <td>{formatInteger(BigInt(entry.lastBlock || 0))}</td>
                      <td>
                        <div className="tableActions">
                          <button type="button" onClick={() => navigator.clipboard.writeText(entry.account)}>
                            复制
                          </button>
                          <button
                            type="button"
                            onClick={() => setAllocation({ account: entry.account, packages: String(entry.packages || 1n) })}
                          >
                            回填
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState">暂无已发放账户；批量分配确认后会从链上事件自动回显。</div>
          )}
        </div>

        <div className="surfacePanel">
          <h3>开关与白名单</h3>
          <div className="dataList compact">
            <span>PES 暂停</span>
            <strong>{token?.paused ? "是" : "否"}</strong>
            <span>私募暂停</span>
            <strong>{data?.paused ? "是" : "否"}</strong>
            <span>交易状态</span>
            <strong>{token?.tradingEnabled ? "已开启" : "未开启"}</strong>
            <span>买入手续费</span>
            <strong>{formatBps(token?.totalBuyFeeBps || 0)}</strong>
            <span>卖出手续费</span>
            <strong>{formatBps(token?.totalSellFeeBps || 0)}</strong>
          </div>
          <div className="buttonRow">
            <Button
              icon={token?.paused ? Play : Pause}
              variant="secondary"
              busy={busy === "toggleTokenPause"}
              disabled={!isOwner}
              onClick={() =>
                runTransaction(token?.paused ? "恢复 PES" : "暂停 PES", "toggleTokenPause", async ({ pes }) =>
                  token?.paused ? pes.unpause() : pes.pause()
                )
              }
            >
              {token?.paused ? "恢复 PES" : "暂停 PES"}
            </Button>
            <Button
              icon={data?.paused ? Play : Pause}
              variant="secondary"
              busy={busy === "togglePresalePause"}
              disabled={!isOwner}
              onClick={() =>
                runTransaction(data?.paused ? "恢复私募" : "暂停私募", "togglePresalePause", async ({ presale }) =>
                  data?.paused ? presale.unpause() : presale.pause()
                )
              }
            >
              {data?.paused ? "恢复私募" : "暂停私募"}
            </Button>
          </div>

          <div className="divider" />
          <h4>认购 IP 白名单</h4>
          <div className="dataList compact">
            <span>当前访问 IP</span>
            <strong>{ipPolicy?.ip || "--"}</strong>
            <span>IP 限购</span>
            <strong>{ipPolicy?.packageLimit || 1} 份</strong>
            <span>当前 IP 已购</span>
            <strong>{ipPolicy?.usedPackages || 0} 份</strong>
            <span>当前 IP 状态</span>
            <strong>{ipPolicy?.whitelisted ? "白名单，不限份数" : "普通 IP"}</strong>
          </div>
          <div className="formGrid two">
            <Field label="白名单 IP">
              <input
                value={ipWhitelistForm.ip}
                onChange={(event) => setIpWhitelistForm({ ...ipWhitelistForm, ip: event.target.value })}
                placeholder="例如 1.2.3.4"
              />
            </Field>
            <Field label="备注">
              <input
                value={ipWhitelistForm.note}
                onChange={(event) => setIpWhitelistForm({ ...ipWhitelistForm, note: event.target.value })}
                placeholder="渠道/内部测试"
              />
            </Field>
          </div>
          <Button
            icon={ShieldCheck}
            variant="secondary"
            disabled={!isOwner || !signer || !ipWhitelistForm.ip.trim()}
            onClick={async () => {
              try {
                notify?.("info", "等待 Admin 钱包签名");
                await saveIpWhitelist();
                notify?.("success", "IP 白名单已保存");
              } catch (error) {
                notify?.("error", getErrorMessage(error));
              }
            }}
          >
            保存 IP 白名单
          </Button>

          {ipPolicy?.whitelist?.length ? (
            <div className="allocationTableWrap compactTable">
              <table className="allocationTable">
                <thead>
                  <tr>
                    <th>IP</th>
                    <th>备注</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {ipPolicy.whitelist.map((row) => (
                    <tr key={row.ip}>
                      <td>
                        <code>{row.ip}</code>
                      </td>
                      <td>{row.note || "--"}</td>
                      <td>{formatTimestamp(Math.floor(new Date(row.updatedAt).getTime() / 1000))}</td>
                      <td>
                        <div className="tableActions">
                          <button type="button" onClick={() => setIpWhitelistForm({ ip: row.ip, note: row.note || "" })}>
                            回填
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                notify?.("info", "等待 Admin 钱包签名");
                                await removeIpWhitelist(row.ip);
                                notify?.("success", "IP 白名单已移除");
                              } catch (error) {
                                notify?.("error", getErrorMessage(error));
                              }
                            }}
                          >
                            移除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState">暂无 IP 白名单；普通 IP 默认最多认购 1 份。</div>
          )}

          <div className="divider" />
          <div className="formGrid two">
            <Field label="免手续费地址">
              <input
                value={feeExclusion.account}
                onChange={(event) => setFeeExclusion({ ...feeExclusion, account: event.target.value })}
              />
            </Field>
            <Field label="状态">
              <select
                value={feeExclusion.excluded}
                onChange={(event) => setFeeExclusion({ ...feeExclusion, excluded: event.target.value })}
              >
                <option value="true">免手续费</option>
                <option value="false">收手续费</option>
              </select>
            </Field>
          </div>
          <Button
            icon={ShieldCheck}
            busy={busy === "setExcluded"}
            disabled={!isOwner || !isAddress(feeExclusion.account)}
            onClick={() =>
              runTransaction("设置免手续费地址", "setExcluded", async ({ pes }) =>
                pes.setExcludedFromFees(feeExclusion.account, feeExclusion.excluded === "true")
              )
            }
          >
            保存白名单
          </Button>
        </div>
      </div>
    </Section>
  );
}

function FeeEditor({ title, form, setForm }) {
  return (
    <div className="feeEditor">
      <h4>{title}</h4>
      <div className="formGrid three">
        <Field label="LP">
          <input value={form.liquidityBps} onChange={(event) => setForm({ ...form, liquidityBps: event.target.value })} />
        </Field>
        <Field label="运营">
          <input value={form.operationsBps} onChange={(event) => setForm({ ...form, operationsBps: event.target.value })} />
        </Field>
        <Field label="销毁">
          <input value={form.burnBps} onChange={(event) => setForm({ ...form, burnBps: event.target.value })} />
        </Field>
      </div>
    </div>
  );
}

export default function App() {
  const { address: connectedAddress } = useAccount();
  const activeChainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const [config, setConfig] = useState(loadConfig);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [data, setData] = useState(null);
  const [token, setToken] = useState(null);
  const [payment, setPayment] = useState(null);
  const [saleEvents, setSaleEvents] = useState([]);
  const [adminAllocations, setAdminAllocations] = useState([]);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const [buyPackages, setBuyPackages] = useState("1");
  const [ipPolicy, setIpPolicy] = useState(DEFAULT_IP_POLICY);
  const [path, setPath] = useState(() => window.location.pathname);
  const adminAllocationScanRef = useRef({ presaleAddress: "", scannedToBlock: 0, rows: [] });

  const isAdminRoute = path.startsWith("/admin");
  const pageLabel = isAdminRoute ? "PES Admin Console" : "PES Token Launchpad";
  const pageTitle = isAdminRoute ? "PES Admin 管理系统" : "PES 私募认购";
  const fallbackProvider = useMemo(
    () => createReadProvider(import.meta.env.VITE_READ_RPC_URL),
    []
  );
  const readProvider = fallbackProvider;

  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0, left: 0 });
  }, []);

  const contractsReady = useMemo(
    () => isAddress(config.pesAddress) && isAddress(config.presaleAddress) && Boolean(readProvider),
    [config.pesAddress, config.presaleAddress, readProvider]
  );

  const saveConfig = useCallback(() => {
    const normalized = {
      ...config,
      pesAddress: normalizeAddress(config.pesAddress) || config.pesAddress,
      presaleAddress: normalizeAddress(config.presaleAddress) || config.presaleAddress,
      paymentTokenAddress: normalizeAddress(config.paymentTokenAddress) || config.paymentTokenAddress,
      ammPairAddress: normalizeAddress(config.ammPairAddress) || config.ammPairAddress,
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
    setConfig(normalized);
    setNotice({ type: "success", message: "配置已保存" });
  }, [config]);

  const refreshIpPolicy = useCallback(async (includeWhitelist = false) => {
    setIpPolicy((current) => ({ ...DEFAULT_IP_POLICY, ...current, loading: true }));
    try {
      const nextPolicy = await fetchIpPolicy(includeWhitelist);
      setIpPolicy({ ...DEFAULT_IP_POLICY, ...nextPolicy, loading: false, whitelist: nextPolicy.whitelist || [] });
      return nextPolicy;
    } catch (error) {
      const fallback = { ...DEFAULT_IP_POLICY, loading: false, error: getErrorMessage(error) };
      setIpPolicy(fallback);
      return fallback;
    }
  }, []);

  const recordIpPurchase = useCallback(async ({ account: buyer, packages, transactionHash }) => {
    const nextPolicy = await postIpPolicy({
      action: "recordPurchase",
      account: buyer,
      packages,
      transactionHash,
    });
    setIpPolicy({ ...DEFAULT_IP_POLICY, ...nextPolicy, loading: false, whitelist: nextPolicy.whitelist || [] });
    return nextPolicy;
  }, []);

  const refreshData = useCallback(async () => {
    if (!readProvider || !isAddress(config.pesAddress) || !isAddress(config.presaleAddress)) return;

    try {
      const pes = new ethers.Contract(normalizeAddress(config.pesAddress), PES_TOKEN_ABI, readProvider);
      const presale = new ethers.Contract(normalizeAddress(config.presaleAddress), PRESALE_ABI, readProvider);

      const [tokenReads, presaleReads] = await Promise.all([
        Promise.all([
          pes.owner(),
          pes.paused(),
          pes.totalSupply(),
          pes.liquidityWallet(),
          pes.operationsWallet(),
          pes.tradingEnabled(),
          pes.buyFees(),
          pes.sellFees(),
          pes.totalBuyFeeBps(),
          pes.totalSellFeeBps(),
          account ? pes.balanceOf(account) : 0n,
          pes.balanceOf(normalizeAddress(config.presaleAddress)),
        ]),
        Promise.all([
          presale.owner(),
          presale.paused(),
          presale.paymentToken(),
          presale.fundsWallet(),
          presale.paymentPerPackage(),
          presale.pesPerPackage(),
          presale.maxPackages(),
          presale.publicPackageCap(),
          presale.perWalletPackageLimit(),
          presale.saleStart(),
          presale.saleEnd(),
          presale.launchTime(),
          optionalContractCall(() => presale.vestingPeriodSeconds(), 86_400n),
          optionalContractCall(() => presale.vestingPeriods(), 40n),
          optionalContractCall(() => presale.elapsedVestingPeriods(), 0n),
          optionalContractCall(() => presale.keeper(), ZERO_ADDRESS),
          optionalContractCall(() => presale.manualClaimEnabled(), true),
          optionalContractCall(() => presale.autoDistributionStart(), 0n),
          optionalContractCall(() => presale.autoDistributionPeriodSeconds(), 86_400n),
          optionalContractCall(() => presale.currentScheduledElapsedPeriods(), 0n),
          presale.publicPackagesSold(),
          presale.totalPackagesAllocated(),
          presale.totalTokensAllocated(),
          presale.totalTokensClaimed(),
          presale.unclaimedAllocatedTokens(),
          account ? presale.allocations(account) : [0n, 0n, 0n],
          account ? presale.vestedAmount(account) : 0n,
          account ? presale.claimableAmount(account) : 0n,
        ]),
      ]);

      const [
        owner,
        tokenPaused,
        totalSupply,
        liquidityWallet,
        operationsWallet,
        tradingEnabled,
        buyFeeTuple,
        sellFeeTuple,
        totalBuyFeeBps,
        totalSellFeeBps,
        pesBalance,
        presalePesBalance,
      ] = tokenReads;

      const [
        presaleOwner,
        presalePaused,
        paymentTokenAddress,
        fundsWallet,
        paymentPerPackage,
        pesPerPackage,
        maxPackages,
        publicPackageCap,
        perWalletPackageLimit,
        saleStart,
        saleEnd,
        launchTime,
        vestingPeriodSecondsResult,
        vestingPeriodsResult,
        elapsedVestingPeriodsResult,
        keeperResult,
        manualClaimEnabledResult,
        autoDistributionStartResult,
        autoDistributionPeriodSecondsResult,
        currentScheduledElapsedPeriodsResult,
        publicPackagesSold,
        totalPackagesAllocated,
        totalTokensAllocated,
        totalTokensClaimed,
        unclaimedAllocatedTokens,
        allocationTuple,
        vested,
        claimable,
      ] = presaleReads;

      const nextToken = {
        owner,
        paused: tokenPaused,
        totalSupply,
        liquidityWallet,
        operationsWallet,
        tradingEnabled,
        buyFees: {
          liquidityBps: Number(buyFeeTuple.liquidityBps),
          operationsBps: Number(buyFeeTuple.operationsBps),
          burnBps: Number(buyFeeTuple.burnBps),
        },
        sellFees: {
          liquidityBps: Number(sellFeeTuple.liquidityBps),
          operationsBps: Number(sellFeeTuple.operationsBps),
          burnBps: Number(sellFeeTuple.burnBps),
        },
        totalBuyFeeBps: Number(totalBuyFeeBps),
        totalSellFeeBps: Number(totalSellFeeBps),
      };

      const nextData = {
        owner: presaleOwner,
        paused: presalePaused,
        paymentTokenAddress,
        fundsWallet,
        paymentPerPackage,
        pesPerPackage,
        maxPackages,
        publicPackageCap,
        perWalletPackageLimit,
        saleStart,
        saleEnd,
        launchTime,
        vestingPeriodSeconds: vestingPeriodSecondsResult.value,
        vestingPeriods: vestingPeriodsResult.value,
        elapsedVestingPeriods: elapsedVestingPeriodsResult.value,
        keeper: keeperResult.value,
        manualClaimEnabled: manualClaimEnabledResult.value,
        autoDistributionStart: autoDistributionStartResult.value,
        autoDistributionPeriodSeconds: autoDistributionPeriodSecondsResult.value,
        currentScheduledElapsedPeriods: currentScheduledElapsedPeriodsResult.value,
        vestingConfigSupported: vestingPeriodSecondsResult.supported && vestingPeriodsResult.supported,
        vestingProgressSupported: elapsedVestingPeriodsResult.supported,
        autoDistributionSupported:
          keeperResult.supported &&
          manualClaimEnabledResult.supported &&
          autoDistributionStartResult.supported &&
          autoDistributionPeriodSecondsResult.supported &&
          currentScheduledElapsedPeriodsResult.supported,
        publicPackagesSold,
        totalPackagesAllocated,
        totalTokensAllocated,
        totalTokensClaimed,
        unclaimedAllocatedTokens,
        presalePesBalance,
        pesBalance,
        vested,
        claimable,
        allocation: {
          packages: allocationTuple.packages ?? allocationTuple[0],
          tokens: allocationTuple.tokens ?? allocationTuple[1],
          claimed: allocationTuple.claimed ?? allocationTuple[2],
        },
      };

      const paymentAddress = normalizeAddress(config.paymentTokenAddress) || paymentTokenAddress;
      const paymentToken = new ethers.Contract(paymentAddress, ERC20_ABI, readProvider);
      const [paymentSymbol, paymentDecimalsRaw, paymentBalance, allowance] = await Promise.all([
        paymentToken.symbol(),
        paymentToken.decimals(),
        account ? paymentToken.balanceOf(account) : 0n,
        account ? paymentToken.allowance(account, normalizeAddress(config.presaleAddress)) : 0n,
      ]);

      setToken(nextToken);
      setData(nextData);
      setPayment({
        address: paymentAddress,
        symbol: paymentSymbol,
        decimals: Number(paymentDecimalsRaw),
        balance: paymentBalance,
        allowance,
      });

      if (!normalizeAddress(config.paymentTokenAddress)) {
        setConfig((current) => ({ ...current, paymentTokenAddress: paymentAddress }));
      }

      try {
        const latestBlock = await readProvider.getBlockNumber();
        const fromBlock = Math.max(0, latestBlock - EVENT_LOOKBACK_BLOCKS);
        const purchaseLogs = await queryFilterInRanges(
          presale,
          presale.filters.PackagesPurchased(),
          fromBlock,
          latestBlock
        );
        const grantLogs = await queryFilterInRanges(
          presale,
          presale.filters.AdminAllocationGranted(),
          fromBlock,
          latestBlock
        );

        const presaleAddress = normalizeAddress(config.presaleAddress);
        const scanState = adminAllocationScanRef.current;
        const firstScanBlock =
          Number(import.meta.env.VITE_ADMIN_ALLOCATION_FROM_BLOCK || "") ||
          Math.max(0, latestBlock - ADMIN_ALLOCATION_SCAN_BLOCKS);
        const shouldResetScan = scanState.presaleAddress !== presaleAddress || !scanState.rows.length;
        const allocationFromBlock = shouldResetScan ? firstScanBlock : scanState.scannedToBlock + 1;
        const allocationGrantLogs = await queryFilterInRanges(
          presale,
          presale.filters.AdminAllocationGranted(),
          allocationFromBlock,
          latestBlock
        );
        const cachedRows = shouldResetScan ? loadCachedAdminAllocationRows(presaleAddress) : [];
        const nextAdminAllocations = buildAdminAllocationRows(
          allocationGrantLogs,
          shouldResetScan ? (allocationGrantLogs.length ? [] : cachedRows) : scanState.rows
        );
        adminAllocationScanRef.current = {
          presaleAddress,
          scannedToBlock: latestBlock,
          rows: nextAdminAllocations,
        };
        saveCachedAdminAllocationRows(presaleAddress, nextAdminAllocations);
        setAdminAllocations(nextAdminAllocations);

        const rawSaleEvents = [
          ...purchaseLogs.map((event) => ({
            type: "purchase",
            account: event.args?.buyer || event.args?.[0] || ZERO_ADDRESS,
            packages: event.args?.packages || event.args?.[1] || 0n,
            tokenAmount: event.args?.tokenAmount || event.args?.[3] || 0n,
            blockNumber: event.blockNumber,
            logIndex: event.index ?? event.logIndex ?? 0,
            transactionHash: event.transactionHash,
          })),
          ...grantLogs.map((event) => ({
            type: "grant",
            account: event.args?.account || event.args?.[0] || ZERO_ADDRESS,
            packages: event.args?.packages || event.args?.[1] || 0n,
            tokenAmount: event.args?.tokenAmount || event.args?.[2] || 0n,
            blockNumber: event.blockNumber,
            logIndex: event.index ?? event.logIndex ?? 0,
            transactionHash: event.transactionHash,
          })),
        ]
          .sort((a, b) => (b.blockNumber === a.blockNumber ? b.logIndex - a.logIndex : b.blockNumber - a.blockNumber))
          .slice(0, 24);

        const uniqueBlockNumbers = [...new Set(rawSaleEvents.map((event) => event.blockNumber))];
        const blockTimestamps = new Map(
          await Promise.all(
            uniqueBlockNumbers.map(async (blockNumber) => {
              const block = await readProvider.getBlock(blockNumber);
              return [blockNumber, block?.timestamp || 0];
            })
          )
        );

        const nextSaleEvents = rawSaleEvents
          .map((event) => ({
            ...event,
            timestamp: blockTimestamps.get(event.blockNumber) || 0,
          }))
          .sort((a, b) => {
            if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
            return b.blockNumber === a.blockNumber ? b.logIndex - a.logIndex : b.blockNumber - a.blockNumber;
          });

        setSaleEvents(nextSaleEvents);
      } catch {
        setSaleEvents([]);
        setAdminAllocations([]);
        adminAllocationScanRef.current = { presaleAddress: "", scannedToBlock: 0, rows: [] };
      }
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    }
  }, [account, config.paymentTokenAddress, config.pesAddress, config.presaleAddress, readProvider]);

  const recordAdminAllocations = useCallback(
    (entries, blockNumber = 0, transactionHash = "") => {
      const presaleAddress = normalizeAddress(config.presaleAddress);
      if (!presaleAddress || !entries?.length) return;

      const pesPerPackage = data?.pesPerPackage || 0n;
      const syntheticLogs = entries.map((entry, index) => ({
        args: {
          account: entry.account,
          packages: entry.packages,
          tokenAmount: entry.packages * pesPerPackage,
        },
        blockNumber,
        index,
        logIndex: index,
        transactionHash,
      }));

      setAdminAllocations((currentRows) => {
        const seedRows =
          adminAllocationScanRef.current.presaleAddress === presaleAddress
            ? adminAllocationScanRef.current.rows
            : currentRows;
        const nextRows = buildAdminAllocationRows(syntheticLogs, seedRows);

        adminAllocationScanRef.current = {
          ...adminAllocationScanRef.current,
          presaleAddress,
          scannedToBlock: Math.max(adminAllocationScanRef.current.scannedToBlock || 0, Number(blockNumber || 0)),
          rows: nextRows,
        };
        saveCachedAdminAllocationRows(presaleAddress, nextRows);
        return nextRows;
      });
    },
    [config.presaleAddress, data?.pesPerPackage]
  );

  const runTransaction = useCallback(
    async (label, key, callback) => {
      if (!signer) {
        setNotice({ type: "error", message: "请先连接钱包" });
        return;
      }
      if (chainId !== TARGET_CHAIN_ID) {
        setNotice({ type: "error", message: `请先在 RainbowKit 中切换到 ${TARGET_CHAIN_NAME}` });
        return;
      }
      if (!isAddress(config.pesAddress) || !isAddress(config.presaleAddress)) {
        setNotice({ type: "error", message: "请先配置 PES 和私募合约地址" });
        return;
      }

      setBusy(key);
      try {
        const presaleAddress = normalizeAddress(config.presaleAddress);
        const pes = new ethers.Contract(normalizeAddress(config.pesAddress), PES_TOKEN_ABI, signer);
        const presale = new ethers.Contract(presaleAddress, PRESALE_ABI, signer);
        const paymentAddress = normalizeAddress(payment?.address || config.paymentTokenAddress);
        const paymentToken = paymentAddress ? new ethers.Contract(paymentAddress, ERC20_ABI, signer) : null;
        const result = await callback({
          pes,
          presale,
          paymentToken,
          presaleAddress,
          notify: (type, message) => setNotice({ type, message }),
        });
        const tx = result?.tx || result;
        if (tx?.hash) {
          setNotice({ type: "info", message: `${label}: 等待链上确认 ${tx.hash}` });
          const receipt = await tx.wait();
          if (result?.afterConfirmed) {
            await result.afterConfirmed(receipt);
          }
        }
        setNotice({ type: "success", message: `${label}: 已确认` });
        await refreshData();
      } catch (error) {
        setNotice({ type: "error", message: getErrorMessage(error) });
      } finally {
        setBusy("");
      }
    },
    [chainId, config.paymentTokenAddress, config.pesAddress, config.presaleAddress, payment?.address, refreshData, signer]
  );

  useEffect(() => {
    let disposed = false;

    const syncRainbowWallet = async () => {
      setAccount(connectedAddress || "");
      setChainId(activeChainId ? String(activeChainId) : "");

      if (!walletClient || !connectedAddress) {
        setSigner(null);
        return;
      }

      const nextProvider = new ethers.BrowserProvider(walletClient.transport, {
        chainId: walletClient.chain.id,
        name: walletClient.chain.name,
      });
      const nextSigner = await nextProvider.getSigner(connectedAddress);

      if (!disposed) {
        setSigner(nextSigner);
      }
    };

    syncRainbowWallet().catch((error) => {
      if (!disposed) {
        setNotice({ type: "error", message: getErrorMessage(error) });
      }
    });

    return () => {
      disposed = true;
    };
  }, [activeChainId, connectedAddress, walletClient]);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    refreshData();
    const timer = window.setInterval(refreshData, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshData]);

  useEffect(() => {
    refreshIpPolicy(isAdminRoute);
  }, [isAdminRoute, refreshIpPolicy]);

  useEffect(() => {
    document.title = isAdminRoute ? "PES Admin Console" : "PES Presale";
  }, [isAdminRoute]);

  return (
    <div className={`appShell ${isAdminRoute ? "adminShell" : "clientShell"}`}>
      <main>
        <header className="topBar">
          {!isAdminRoute ? (
            <div className="clientWalletLink">
              <RainbowWalletButton />
            </div>
          ) : null}
          <div>
            <p>{pageLabel}</p>
            <h1>
              {isAdminRoute ? (
                pageTitle
              ) : (
                <>
                  <span className="heroTitleBrand">PES</span>
                  <span className="heroTitleText">私募认购</span>
                </>
              )}
            </h1>
            {!isAdminRoute ? (
              <p className="heroSubtitle">
                <span>构建高效数字生态</span>
                <span>探索未来无限可能</span>
              </p>
            ) : null}
          </div>
          {!isAdminRoute ? (
            <div className="heroOrnaments" aria-hidden="true">
              <span className="heroSpecimen" />
              <span className="ornament ornamentA" />
              <span className="ornament ornamentB" />
              <span className="ornament ornamentC" />
              <span className="ornament ornamentD" />
            </div>
          ) : null}
          <div className="walletCluster">
            {isAdminRoute ? (
              <>
                <div className="routeTabs" aria-label="端切换">
                  <a
                    href="/"
                    className={!isAdminRoute ? "active" : ""}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate("/");
                    }}
                  >
                    用户端
                  </a>
                  <a
                    href="/admin"
                    className={isAdminRoute ? "active" : ""}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate("/admin");
                    }}
                  >
                    Admin
                  </a>
                </div>
                <span>Chain {chainId || "--"}</span>
                {account ? <IconButton label="复制钱包地址" icon={Copy} onClick={() => navigator.clipboard.writeText(account)} /> : null}
              </>
            ) : null}
            <RainbowWalletButton />
          </div>
        </header>

        <Notice notice={notice} onDismiss={() => setNotice(null)} />

        {isAdminRoute ? (
          <>
            <div id="config">
              <ConfigPanel config={config} setConfig={setConfig} onSave={saveConfig} number="01" title="合约配置" />
            </div>

            <div id="admin">
              <AdminPanel
                data={data}
                token={token}
                payment={payment}
                config={config}
                setConfig={setConfig}
                account={account}
                signer={signer}
                ipPolicy={ipPolicy}
                refreshIpPolicy={refreshIpPolicy}
                adminAllocations={adminAllocations}
                recordAdminAllocations={recordAdminAllocations}
                busy={busy}
                runTransaction={runTransaction}
                notify={(type, message) => setNotice({ type, message })}
                refreshData={refreshData}
                number="02"
                title="Admin 管理"
              />
            </div>
          </>
        ) : (
          <div id="client">
            <ClientPanel
              data={data}
              payment={payment}
              saleEvents={saleEvents}
              account={account}
              config={config}
              buyPackages={buyPackages}
              setBuyPackages={setBuyPackages}
              ipPolicy={ipPolicy}
              recordIpPurchase={recordIpPurchase}
              busy={busy}
              runTransaction={runTransaction}
              contractsReady={contractsReady}
              number="01"
              title="PES 私募认购"
            />
          </div>
        )}
      </main>
    </div>
  );
}
