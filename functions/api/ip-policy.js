import { ethers } from "ethers";

const DEFAULT_ADMIN_WALLET = "0x744447d8580EB900b199e852C132F626247a36F7";
const IP_PACKAGE_LIMIT = 1;
const INDEX_KEY = "whitelist:index";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ""
  );
}

function cleanIp(value) {
  const ip = String(value || "").trim();
  if (!ip || ip.length > 80 || !/^[0-9a-fA-F:.]+$/.test(ip)) return "";
  return ip;
}

function cleanAddress(value) {
  return ethers.isAddress(value || "") ? ethers.getAddress(value) : "";
}

function ipKey(ip) {
  return `ip:${ip}`;
}

function whitelistKey(ip) {
  return `whitelist:${ip}`;
}

async function readJson(kv, key, fallback) {
  const value = await kv.get(key, "json");
  return value ?? fallback;
}

async function isWhitelisted(kv, ip) {
  return Boolean(await kv.get(whitelistKey(ip)));
}

async function getIpState(kv, ip) {
  const [usage, whitelisted] = await Promise.all([
    readJson(kv, ipKey(ip), { packages: 0, accounts: [], transactions: [], updatedAt: "" }),
    isWhitelisted(kv, ip),
  ]);

  const usedPackages = Number(usage.packages || 0);
  return {
    ip,
    whitelisted,
    usedPackages,
    remainingPackages: whitelisted ? null : Math.max(0, IP_PACKAGE_LIMIT - usedPackages),
    packageLimit: IP_PACKAGE_LIMIT,
    usage,
  };
}

async function listWhitelist(kv) {
  const ips = await readJson(kv, INDEX_KEY, []);
  const rows = await Promise.all(ips.map(async (ip) => readJson(kv, whitelistKey(ip), null)));
  return rows.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function verifyAdmin(env, body) {
  const expected = cleanAddress(env.PES_ADMIN_WALLET || DEFAULT_ADMIN_WALLET);
  const admin = cleanAddress(body.admin);
  const message = String(body.message || "");
  const signature = String(body.signature || "");

  if (!expected || !admin || !message || !signature) return false;
  if (admin.toLowerCase() !== expected.toLowerCase()) return false;
  if (!message.includes("PES IP whitelist admin")) return false;
  if (!message.includes(`Action: ${body.action}`)) return false;
  if (body.ip && !message.includes(`IP: ${body.ip}`)) return false;

  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

async function upsertWhitelist(kv, body) {
  const ip = cleanIp(body.ip);
  if (!ip) return json({ ok: false, error: "Invalid IP" }, { status: 400 });

  const index = new Set(await readJson(kv, INDEX_KEY, []));
  index.add(ip);
  const row = {
    ip,
    note: String(body.note || "").slice(0, 120),
    updatedAt: new Date().toISOString(),
    updatedBy: cleanAddress(body.admin),
  };

  await Promise.all([
    kv.put(whitelistKey(ip), JSON.stringify(row)),
    kv.put(INDEX_KEY, JSON.stringify([...index])),
  ]);

  return json({ ok: true, row, whitelist: await listWhitelist(kv) });
}

async function removeWhitelist(kv, body) {
  const ip = cleanIp(body.ip);
  if (!ip) return json({ ok: false, error: "Invalid IP" }, { status: 400 });

  const index = new Set(await readJson(kv, INDEX_KEY, []));
  index.delete(ip);
  await Promise.all([
    kv.delete(whitelistKey(ip)),
    kv.put(INDEX_KEY, JSON.stringify([...index])),
  ]);

  return json({ ok: true, whitelist: await listWhitelist(kv) });
}

async function recordPurchase(kv, request, body) {
  const ip = getClientIp(request);
  if (!ip) return json({ ok: false, error: "Cannot resolve client IP" }, { status: 400 });

  const state = await getIpState(kv, ip);
  if (state.whitelisted) {
    return json({ ok: true, ...state, recorded: false });
  }

  const packages = Math.max(1, Math.min(IP_PACKAGE_LIMIT, Number(body.packages || 1)));
  if (state.usedPackages + packages > IP_PACKAGE_LIMIT) {
    return json({ ok: false, ...state, error: "IP package limit exceeded" }, { status: 409 });
  }

  const account = cleanAddress(body.account);
  const usage = {
    packages: state.usedPackages + packages,
    accounts: [...new Set([...(state.usage.accounts || []), account].filter(Boolean))],
    transactions: [
      ...(state.usage.transactions || []),
      {
        hash: String(body.transactionHash || ""),
        packages,
        account,
        at: new Date().toISOString(),
      },
    ].slice(-20),
    updatedAt: new Date().toISOString(),
  };

  await kv.put(ipKey(ip), JSON.stringify(usage));
  return json({ ok: true, ...(await getIpState(kv, ip)), recorded: true });
}

export async function onRequestGet({ request, env }) {
  if (!env.PES_IP_POLICY) {
    return json({ ok: false, enabled: false, error: "PES_IP_POLICY KV binding is missing" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!ip) return json({ ok: false, error: "Cannot resolve client IP" }, { status: 400 });

  const url = new URL(request.url);
  const state = await getIpState(env.PES_IP_POLICY, ip);
  const includeWhitelist = url.searchParams.get("admin") === "1";

  return json({
    ok: true,
    enabled: true,
    ...state,
    whitelist: includeWhitelist ? await listWhitelist(env.PES_IP_POLICY) : undefined,
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.PES_IP_POLICY) {
    return json({ ok: false, enabled: false, error: "PES_IP_POLICY KV binding is missing" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "");

  if (action === "recordPurchase") {
    return recordPurchase(env.PES_IP_POLICY, request, body);
  }

  if (action !== "setWhitelist" && action !== "removeWhitelist") {
    return json({ ok: false, error: "Unsupported action" }, { status: 400 });
  }

  if (!(await verifyAdmin(env, body))) {
    return json({ ok: false, error: "Admin signature required" }, { status: 401 });
  }

  if (action === "setWhitelist") return upsertWhitelist(env.PES_IP_POLICY, body);
  return removeWhitelist(env.PES_IP_POLICY, body);
}
