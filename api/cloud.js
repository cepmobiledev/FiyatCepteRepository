// Single-file Vercel Serverless API (routes via vercel.json rewrites)
// Routes:
// - GET  /api/health
// - GET  /api/prices?city=ISTANBUL
// - GET  /api/source?token=...&type=gasoline|diesel|lpg&limit=10
// - GET  /api/update?token=...   (CollectAPI -> KV)
// - POST /api/update?token=...  body: { prices: { CITY: { benzin, motorin, lpg } }, lastUpdate? }

const fs = require('fs').promises;
const path = require('path');

// ---------------- KV (Upstash/Vercel KV REST) ----------------
async function redisCmd(args) {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
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

// ---------------- Helpers ----------------
function normalizeCityKey(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .toUpperCase()
    .replace(/İ/g, 'I')
    .replace(/İ/g, 'I')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/[^A-Z0-9]/g, '');
}

function parseMaybeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(',', '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractArray(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.response && Array.isArray(payload.response)) return payload.response;
  return null;
}

function extractCity(item) {
  if (!item || typeof item !== 'object') return '';
  return (
    item.city ||
    item.City ||
    item.name ||
    item.Name ||
    item.il ||
    item.IL ||
    item.sehir ||
    item.Sehir ||
    item.province ||
    item.Province ||
    ''
  );
}

function extractPrice(item) {
  if (!item || typeof item !== 'object') return null;
  return (
    parseMaybeNumber(item.price) ??
    parseMaybeNumber(item.Price) ??
    parseMaybeNumber(item.value) ??
    parseMaybeNumber(item.Value) ??
    parseMaybeNumber(item.gasoline) ??
    parseMaybeNumber(item.Gasoline) ??
    parseMaybeNumber(item.diesel) ??
    parseMaybeNumber(item.Diesel) ??
    parseMaybeNumber(item.lpg) ??
    parseMaybeNumber(item.LPG) ??
    parseMaybeNumber(item.autogas) ??
    parseMaybeNumber(item.Autogas) ??
    null
  );
}

function mergePriceField(target, field, nextValue) {
  if (nextValue == null) return;
  const current = target[field];
  if (typeof current !== 'number') {
    target[field] = nextValue;
    return;
  }
  target[field] = Math.min(current, nextValue);
}

async function readJsonIfExists(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function readLocalDbJson() {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'db.json'),
    path.join(cwd, 'cloud-api', 'db.json'),
    path.join(cwd, '..', 'db.json'),
  ];

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const json = await readJsonIfExists(candidate);
    if (json) return json;
  }

  return null;
}

async function readRequestJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const json = body ? JSON.parse(body) : null;
        resolve(json);
      } catch {
        resolve(null);
      }
    });
  });
}

function getRoute(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (p.endsWith('/health')) return 'health';
  if (p.endsWith('/prices')) return 'prices';
  if (p.endsWith('/update')) return 'update';
  if (p.endsWith('/source')) return 'source';
  // If called as /api/cloud directly, allow ?route=
  const q = (req.query && req.query.route) ? String(req.query.route) : '';
  if (q) return q;
  return 'prices';
}

function requireToken(req, res) {
  const token = (req.query && req.query.token) ? String(req.query.token) : '';
  const expected = process.env.UPDATE_TOKEN || '';
  if (!expected || token !== expected) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

// ---------------- CollectAPI fetch & merge ----------------
async function fetchCollectApiMerged() {
  const collectKey = process.env.COLLECTAPI_KEY;
  if (!collectKey) return null;

  const base = process.env.COLLECTAPI_BASE_URL || 'https://api.collectapi.com/gasPrice';
  const headers = {
    authorization: `apikey ${collectKey}`,
    'content-type': 'application/json',
  };

  async function fetchOne(pathSuffix) {
    const url = `${base.replace(/\/$/, '')}/${pathSuffix}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  const [gasolineJson, dieselJson, lpgJson] = await Promise.all([
    fetchOne('turkeyGasoline'),
    fetchOne('turkeyDiesel'),
    fetchOne('turkeyLpg'),
  ]);

  const gasolineArr = extractArray(gasolineJson);
  const dieselArr = extractArray(dieselJson);
  const lpgArr = extractArray(lpgJson);
  if (!gasolineArr || !dieselArr || !lpgArr) return null;

  const pricesByCity = {};

  for (const item of gasolineArr) {
    const cityKey = normalizeCityKey(extractCity(item));
    const value = extractPrice(item);
    if (!cityKey || value == null) continue;
    pricesByCity[cityKey] ||= {};
    mergePriceField(pricesByCity[cityKey], 'benzin', value);
  }

  for (const item of dieselArr) {
    const cityKey = normalizeCityKey(extractCity(item));
    const value = extractPrice(item);
    if (!cityKey || value == null) continue;
    pricesByCity[cityKey] ||= {};
    mergePriceField(pricesByCity[cityKey], 'motorin', value);
  }

  for (const item of lpgArr) {
    const cityKey = normalizeCityKey(extractCity(item));
    const value = extractPrice(item);
    if (!cityKey || value == null) continue;
    pricesByCity[cityKey] ||= {};
    mergePriceField(pricesByCity[cityKey], 'lpg', value);
  }

  const merged = {};
  for (const [city, p] of Object.entries(pricesByCity)) {
    if (
      p &&
      typeof p.benzin === 'number' &&
      typeof p.motorin === 'number' &&
      typeof p.lpg === 'number'
    ) {
      merged[city] = { benzin: p.benzin, motorin: p.motorin, lpg: p.lpg };
    }
  }

  if (Object.keys(merged).length === 0) return null;
  return { prices: merged, lastUpdate: new Date().toISOString() };
}

// ---------------- Handlers ----------------
async function handleHealth(_req, res) {
  const hasKvEnv = Boolean(
    (process.env.KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL ||
      process.env.UPSTASH_REDIS_KV_REST_API_URL) &&
      (process.env.KV_REST_API_TOKEN ||
        process.env.UPSTASH_REDIS_REST_TOKEN ||
        process.env.UPSTASH_REDIS_KV_REST_API_TOKEN)
  );
  let lastUpdate = null;
  let hasData = false;

  if (hasKvEnv) {
    const kvData = await kvGetJson('fuel:prices');
    if (kvData && typeof kvData === 'object') {
      hasData = Boolean(kvData.prices && typeof kvData.prices === 'object' && Object.keys(kvData.prices).length > 0);
      lastUpdate = kvData.lastUpdate ?? null;
    }
  }

  return res.status(200).json({ ok: true, hasKvEnv, hasData, lastUpdate });
}

async function handlePrices(req, res) {
  const city = (req.query && req.query.city) ? String(req.query.city) : undefined;

  const kvData = await kvGetJson('fuel:prices');
  if (kvData && typeof kvData === 'object') {
    const prices = kvData.prices && typeof kvData.prices === 'object' ? kvData.prices : {};
    const lastUpdate = kvData.lastUpdate ?? null;
    if (city) {
      const key = String(city).toUpperCase();
      return res.status(200).json({ price: prices[key] || null, lastUpdate });
    }
    return res.status(200).json({ prices, lastUpdate });
  }

  const db = await readLocalDbJson();
  const prices = db && db.prices && typeof db.prices === 'object' ? db.prices : {};
  const lastUpdate = db && db.lastUpdate ? db.lastUpdate : null;

  if (city) {
    const key = String(city).toUpperCase();
    return res.status(200).json({ price: prices[key] || null, lastUpdate });
  }

  return res.status(200).json({ prices, lastUpdate });
}

async function handleSource(req, res) {
  if (!requireToken(req, res)) return;

  const collectKey = process.env.COLLECTAPI_KEY;
  if (!collectKey) {
    return res.status(400).json({ ok: false, error: 'COLLECTAPI_KEY missing' });
  }

  const type = (req.query && req.query.type) ? String(req.query.type) : 'gasoline';
  const limitRaw = (req.query && req.query.limit) ? String(req.query.limit) : '10';
  const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 10));

  const map = {
    gasoline: 'turkeyGasoline',
    diesel: 'turkeyDiesel',
    lpg: 'turkeyLpg',
  };

  const pathSuffix = map[type];
  if (!pathSuffix) {
    return res.status(400).json({ ok: false, error: 'type must be gasoline|diesel|lpg' });
  }

  const base = process.env.COLLECTAPI_BASE_URL || 'https://api.collectapi.com/gasPrice';
  const url = `${base.replace(/\/$/, '')}/${pathSuffix}`;

  const response = await fetch(url, {
    headers: {
      authorization: `apikey ${collectKey}`,
      'content-type': 'application/json',
    },
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!response.ok) {
    return res.status(response.status).json({ ok: false, error: `upstream ${response.status}`, url, body: json || text });
  }

  const arr = extractArray(json);
  if (arr) {
    return res.status(200).json({ ok: true, url, count: arr.length, sample: arr.slice(0, limit) });
  }

  return res.status(200).json({ ok: true, url, body: json });
}

async function handleUpdate(req, res) {
  if (!requireToken(req, res)) return;

  let payload = null;
  if (req.method === 'POST') {
    payload = await readRequestJson(req);
  } else {
    // Öncelik: CollectAPI
    payload = await fetchCollectApiMerged();
    // Fallback: local db.json
    if (!payload) payload = await readLocalDbJson();
  }

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'no payload' });
  }

  const prices = payload.prices && typeof payload.prices === 'object' ? payload.prices : null;
  if (!prices || Object.keys(prices).length === 0) {
    return res.status(400).json({ ok: false, error: 'no valid prices' });
  }

  const dataToStore = {
    prices,
    lastUpdate: payload.lastUpdate || new Date().toISOString(),
  };

  const ok = await kvSetJson('fuel:prices', dataToStore);
  if (!ok) return res.status(500).json({ ok: false, error: 'kv write failed' });

  return res.status(200).json({ ok: true, cities: Object.keys(prices).length, lastUpdate: dataToStore.lastUpdate });
}

module.exports = async (req, res) => {
  const route = getRoute(req);
  if (route === 'health') return handleHealth(req, res);
  if (route === 'prices') return handlePrices(req, res);
  if (route === 'source') return handleSource(req, res);
  if (route === 'update') return handleUpdate(req, res);
  return handlePrices(req, res);
};
