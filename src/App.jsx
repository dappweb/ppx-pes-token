import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { ERC20_ABI, PES_TOKEN_ABI, PRESALE_ABI } from "./lib/abis.js";

const CONFIG_KEY = "pes-token-console-config";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const emptyConfig = {
  pesAddress: import.meta.env.VITE_PES_ADDRESS || "",
  presaleAddress: import.meta.env.VITE_PRESALE_ADDRESS || "",
  paymentTokenAddress: import.meta.env.VITE_PAYMENT_TOKEN_ADDRESS || "",
  ammPairAddress: import.meta.env.VITE_AMM_PAIR_ADDRESS || "",
  dexUrl: import.meta.env.VITE_DEX_URL || "",
};

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return { ...emptyConfig, ...stored };
  } catch {
    return emptyConfig;
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

function formatBps(value) {
  if (value === undefined || value === null) return "--";
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function formatTimestamp(value) {
  const seconds = Number(value || 0n);
  if (!seconds) return "未设置";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
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
    const [account, packages] = line.split(/[,\s]+/).filter(Boolean);
    const normalized = normalizeAddress(account);
    if (!normalized || !packages) {
      throw new Error(`第 ${index + 1} 行格式错误`);
    }
    return { account: normalized, packages: BigInt(packages) };
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
    <div className="progressWrap" aria-label="公开认购进度">
      <div className="progressMeta">
        <span>{percent.toFixed(2)}%</span>
        <span>
          {formatInteger(value || 0n)} / {formatInteger(total || 0n)}
        </span>
      </div>
      <div className="progressTrack">
        <div className="progressFill" style={{ width: `${percent}%` }} />
      </div>
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
  account,
  config,
  buyPackages,
  setBuyPackages,
  busy,
  runTransaction,
  contractsReady,
  number = "01",
  title = "用户端",
}) {
  const publicRemaining =
    data?.publicPackageCap && data?.publicPackagesSold
      ? data.publicPackageCap > data.publicPackagesSold
        ? data.publicPackageCap - data.publicPackagesSold
        : 0n
      : 0n;
  const paymentRequired = data?.paymentPerPackage ? data.paymentPerPackage * BigInt(buyPackages || "0") : 0n;
  const allowance = payment?.allowance || 0n;
  const needsApprove = paymentRequired > allowance;
  const saleState = saleStatus(data);
  const launchState = launchStatus(data);
  const walletState = account ? "已连接" : "未连接";
  const approvalState = paymentRequired === 0n ? "无支付金额" : needsApprove ? "需要授权" : "授权足够";
  const presaleAddress = normalizeAddress(config.presaleAddress);

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
          <span className="clientKicker">PES PRESALE</span>
          <h3>{formatUnits(data?.pesPerPackage || 0n)} PES / 份</h3>
          <p>
            每份支付 {formatUnits(data?.paymentPerPackage || 0n, payment?.decimals || 18, 2)} {payment?.symbol || "USDT"}。
            上线后先释放 20%，剩余部分每日释放 2%，40 天释放完毕。
          </p>
          <div className="heroNumbers">
            <div>
              <span>公开剩余</span>
              <strong>{formatInteger(publicRemaining)}</strong>
            </div>
            <div>
              <span>可领取</span>
              <strong>{formatUnits(data?.claimable || 0n)} PES</strong>
            </div>
          </div>
          {config.dexUrl ? (
            <div className="clientHeroActions">
              <a className="linkButton" href={config.dexUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                <span>打开交易页</span>
              </a>
            </div>
          ) : null}
        </div>
        <div className="walletStatePanel">
          <div className="stateRow">
            <span>钱包</span>
            <strong>{walletState}</strong>
          </div>
          <div className="stateRow">
            <span>支付授权</span>
            <strong>{approvalState}</strong>
          </div>
          <div className="stateRow">
            <span>认购状态</span>
            <strong>{saleState}</strong>
          </div>
          <div className="stateRow">
            <span>释放状态</span>
            <strong>{launchState}</strong>
          </div>
        </div>
      </div>

      <div className="metricGrid">
        <Metric label="认购状态" value={saleStatus(data)} note={`${formatTimestamp(data?.saleStart)} - ${formatTimestamp(data?.saleEnd)}`} />
        <Metric label="上线状态" value={launchStatus(data)} note={formatTimestamp(data?.launchTime)} />
        <Metric label="单份价格" value={`${formatUnits(data?.paymentPerPackage || 0n, payment?.decimals || 18, 2)} ${payment?.symbol || "USDT"}`} />
        <Metric label="单份 PES" value={`${formatUnits(data?.pesPerPackage || 0n)} PES`} />
        <Metric label="公开剩余份数" value={formatInteger(publicRemaining)} note={`公开上限 ${formatInteger(data?.publicPackageCap || 0n)}`} />
        <Metric label="总分配份数" value={formatInteger(data?.totalPackagesAllocated || 0n)} note={`总份数 ${formatInteger(data?.maxPackages || 0n)}`} />
      </div>

      <div className="splitLayout">
        <div className="surfacePanel">
          <h3>公开认购</h3>
          <Progress value={data?.publicPackagesSold || 0n} total={data?.publicPackageCap || 0n} />
          <div className="formGrid two">
            <Field label="购买份数">
              <input min="1" type="number" value={buyPackages} onChange={(event) => setBuyPackages(event.target.value)} />
            </Field>
            <Field label="需支付">
              <input readOnly value={`${formatUnits(paymentRequired, payment?.decimals || 18, 2)} ${payment?.symbol || "USDT"}`} />
            </Field>
          </div>
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
              <strong>{formatUnits((data?.pesPerPackage || 0n) * BigInt(buyPackages || "0"))} PES</strong>
            </div>
            <div>
              <span>私募合约</span>
              <strong>{shortAddress(presaleAddress)}</strong>
            </div>
          </div>
          <div className="buttonRow">
            <Button
              icon={ShoppingCart}
              busy={busy === "approvePurchase"}
              disabled={!account || !contractsReady || paymentRequired === 0n}
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

                  return presale.purchasePackages(BigInt(buyPackages || "0"));
                })
              }
            >
              {needsApprove ? `授权并购买 PES 份额` : "购买 PES 份额"}
            </Button>
          </div>
        </div>

        <div className="surfacePanel">
          <h3>我的释放</h3>
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
          </div>
          <Button
            icon={Coins}
            variant="primary"
            busy={busy === "claim"}
            disabled={!account || !contractsReady || !data?.claimable || data.claimable === 0n}
            onClick={() => runTransaction("领取 PES", "claim", async ({ presale }) => presale.claim())}
          >
            领取已释放 PES
          </Button>
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
  busy,
  runTransaction,
  refreshData,
  number = "02",
  title = "Admin 管理",
}) {
  const [saleForm, setSaleForm] = useState({ start: "", end: "" });
  const [launchForm, setLaunchForm] = useState("");
  const [packageForm, setPackageForm] = useState({
    paymentPerPackage: "300",
    pesPerPackage: "3000",
    maxPackages: "2000",
    publicPackageCap: "50",
    perWalletPackageLimit: "1",
  });
  const [fundsWallet, setFundsWallet] = useState("");
  const [feeWallets, setFeeWallets] = useState({ liquidityWallet: "", operationsWallet: "" });
  const [buyFees, setBuyFees] = useState({ liquidityBps: "50", operationsBps: "50", burnBps: "50" });
  const [sellFees, setSellFees] = useState({ liquidityBps: "50", operationsBps: "50", burnBps: "50" });
  const [allocation, setAllocation] = useState({ account: "", packages: "1" });
  const [batchText, setBatchText] = useState("");
  const [feeExclusion, setFeeExclusion] = useState({ account: "", excluded: "true" });

  useEffect(() => {
    setSaleForm({ start: toDateTimeLocal(data?.saleStart), end: toDateTimeLocal(data?.saleEnd) });
    setLaunchForm(toDateTimeLocal(data?.launchTime));
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

  const isOwner =
    account &&
    ((data?.owner && normalizeAddress(data.owner) === normalizeAddress(account)) ||
      (token?.owner && normalizeAddress(token.owner) === normalizeAddress(account)));

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
        <Metric label="公开认购" value={`${formatInteger(data?.publicPackagesSold || 0n)} / ${formatInteger(data?.publicPackageCap || 0n)}`} />
        <Metric label="总分配份数" value={formatInteger(data?.totalPackagesAllocated || 0n)} note={`总上限 ${formatInteger(data?.maxPackages || 0n)}`} />
        <Metric label="已分配 PES" value={`${formatUnits(data?.totalTokensAllocated || 0n)} PES`} />
        <Metric label="已领取 PES" value={`${formatUnits(data?.totalTokensClaimed || 0n)} PES`} />
        <Metric label="交易状态" value={token?.tradingEnabled ? "已开启" : "未开启"} />
        <Metric label="合约暂停" value={token?.paused || data?.paused ? "有暂停项" : "正常"} />
      </div>

      <div className="adminGrid">
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
        </div>

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
          <Field label="批量分配(address,packages)">
            <textarea
              rows="7"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder="0x0000000000000000000000000000000000000001,1"
            />
          </Field>
          <Button
            icon={Upload}
            busy={busy === "grantBatch"}
            disabled={!isOwner || !batchText.trim()}
            onClick={() =>
              runTransaction("批量分配", "grantBatch", async ({ presale }) => {
                const parsed = parseBatchAllocations(batchText);
                return presale.grantAllocations(
                  parsed.map((entry) => entry.account),
                  parsed.map((entry) => entry.packages)
                );
              })
            }
          >
            批量分配
          </Button>
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
  const [config, setConfig] = useState(loadConfig);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [data, setData] = useState(null);
  const [token, setToken] = useState(null);
  const [payment, setPayment] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const [buyPackages, setBuyPackages] = useState("1");
  const [path, setPath] = useState(() => window.location.pathname);

  const isAdminRoute = path.startsWith("/admin");
  const pageLabel = isAdminRoute ? "PES Admin Console" : "PES Client";
  const pageTitle = isAdminRoute ? "PES Admin 管理系统" : "PES 私募认购";

  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0, left: 0 });
  }, []);

  const contractsReady = useMemo(
    () => isAddress(config.pesAddress) && isAddress(config.presaleAddress) && Boolean(provider),
    [config.pesAddress, config.presaleAddress, provider]
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

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      setNotice({ type: "error", message: "未检测到钱包扩展" });
      return;
    }

    const nextProvider = new ethers.BrowserProvider(window.ethereum);
    await nextProvider.send("eth_requestAccounts", []);
    const nextSigner = await nextProvider.getSigner();
    const network = await nextProvider.getNetwork();
    const nextAccount = await nextSigner.getAddress();

    setProvider(nextProvider);
    setSigner(nextSigner);
    setAccount(nextAccount);
    setChainId(network.chainId.toString());
    setNotice({ type: "success", message: `已连接 ${shortAddress(nextAccount)}` });
  }, []);

  const refreshData = useCallback(async () => {
    if (!provider || !isAddress(config.pesAddress) || !isAddress(config.presaleAddress)) return;

    try {
      const pes = new ethers.Contract(normalizeAddress(config.pesAddress), PES_TOKEN_ABI, provider);
      const presale = new ethers.Contract(normalizeAddress(config.presaleAddress), PRESALE_ABI, provider);

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
        publicPackagesSold,
        totalPackagesAllocated,
        totalTokensAllocated,
        totalTokensClaimed,
        unclaimedAllocatedTokens,
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
      const paymentToken = new ethers.Contract(paymentAddress, ERC20_ABI, provider);
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
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    }
  }, [account, config.paymentTokenAddress, config.pesAddress, config.presaleAddress, provider]);

  const runTransaction = useCallback(
    async (label, key, callback) => {
      if (!signer) {
        setNotice({ type: "error", message: "请先连接钱包" });
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
        const tx = await callback({
          pes,
          presale,
          paymentToken,
          presaleAddress,
          notify: (type, message) => setNotice({ type, message }),
        });
        setNotice({ type: "info", message: `${label}: 等待链上确认 ${tx.hash}` });
        await tx.wait();
        setNotice({ type: "success", message: `${label}: 已确认` });
        await refreshData();
      } catch (error) {
        setNotice({ type: "error", message: getErrorMessage(error) });
      } finally {
        setBusy("");
      }
    },
    [config.paymentTokenAddress, config.pesAddress, config.presaleAddress, payment?.address, refreshData, signer]
  );

  useEffect(() => {
    if (!window.ethereum) return;

    const connectExisting = async () => {
      const nextProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await nextProvider.send("eth_accounts", []);
      if (!accounts.length) return;
      const nextSigner = await nextProvider.getSigner();
      const network = await nextProvider.getNetwork();
      setProvider(nextProvider);
      setSigner(nextSigner);
      setAccount(await nextSigner.getAddress());
      setChainId(network.chainId.toString());
    };

    connectExisting();
  }, []);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    document.title = isAdminRoute ? "PES Admin Console" : "PES Presale";
  }, [isAdminRoute]);

  return (
    <div className={`appShell ${isAdminRoute ? "adminShell" : "clientShell"}`}>
      <aside className="rail">
        <div className="mark">PES</div>
        <nav>
          {isAdminRoute ? (
            <>
              <a href="#config">01</a>
              <a href="#admin">02</a>
            </>
          ) : (
            <a href="#client">01</a>
          )}
        </nav>
      </aside>

      <main>
        <header className="topBar">
          <div>
            {isAdminRoute ? <p>{pageLabel}</p> : null}
            <h1>{pageTitle}</h1>
          </div>
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
                <span>{account ? shortAddress(account) : "未连接钱包"}</span>
                <IconButton label="复制钱包地址" icon={Copy} disabled={!account} onClick={() => navigator.clipboard.writeText(account)} />
              </>
            ) : null}
            <Button icon={Wallet} onClick={connectWallet} busy={busy === "connect"}>
              {account ? "切换钱包" : "连接钱包"}
            </Button>
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
                busy={busy}
                runTransaction={runTransaction}
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
              account={account}
              config={config}
              buyPackages={buyPackages}
              setBuyPackages={setBuyPackages}
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
