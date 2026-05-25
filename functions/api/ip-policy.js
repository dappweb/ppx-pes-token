function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const disabledPolicy = {
  ok: true,
  enabled: false,
  disabled: true,
  whitelisted: true,
  usedPackages: 0,
  remainingPackages: null,
  packageLimit: null,
  whitelist: [],
  message: "IP purchase limits are disabled.",
};

export async function onRequestGet() {
  return json(disabledPolicy);
}

export async function onRequestPost() {
  return json({ ...disabledPolicy, recorded: false });
}
