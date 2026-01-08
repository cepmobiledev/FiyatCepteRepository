// Minimal Upstash/Vercel KV REST client (no dependencies).
// Requires:
// - KV_REST_API_URL (Upstash REST URL)
// - KV_REST_API_TOKEN (Upstash REST token)

async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, result: null, error: 'KV env missing' };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    return { ok: false, result: null, error: `KV HTTP ${response.status}` };
  }

  const json = await response.json().catch(() => null);
  // Upstash response typically: { result: <value>, error: <string|null> }
  if (!json) return { ok: false, result: null, error: 'KV bad json' };
  if (json.error) return { ok: false, result: null, error: String(json.error) };
  return { ok: true, result: json.result, error: null };
}

async function kvGetJson(key) {
  const { ok, result } = await redisCmd(['GET', key]);
  if (!ok || result == null) return null;
  if (typeof result !== 'string') return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function kvSetJson(key, value) {
  const payload = JSON.stringify(value);
  const { ok } = await redisCmd(['SET', key, payload]);
  return ok;
}

module.exports = {
  kvGetJson,
  kvSetJson,
};
