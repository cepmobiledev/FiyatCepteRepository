// api/cloud.js
// Pompa fiyatları toplayıcı (KV cache + günlük cron için uygun)

const MAX_AGE_HOURS = 12; // prices endpoint'i, veri 12 saatten eskiyse update yapar

///////////////////////////
// KV (Upstash/Vercel KV REST)
///////////////////////////
async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) return { ok: false, result: null, error: "KV env missing" };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) return { ok: false, result: null, error: `KV HTTP ${response.status}` };
    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, result: null, error: "KV bad json" };
    if (json.error) return { ok: false, result: null, error: String(json.error) };
    return { ok: true, result: json.result, error: null };
  } catch (e) {
    return { ok: false, result: null, error: String(e.message || e) };
  }
}

async function kvGetJson(key) {
  const { ok, result } = await redisCmd(["GET", key]);
  if (!ok || result == null || typeof result !== "string") return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function kvSetJson(key, value) {
  const payload = JSON.stringify(value);
  const { ok } = await redisCmd(["SET", key, payload]);
  return ok;
}

///////////////////////////
// Helpers
///////////////////////////
function normalizeCityKey(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ş/g, "S")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, "_");
}

function parseTrNumber(s) {
  if (s == null) return null;
  const txt = String(s).replace(/\s+/g, " ").trim();
  const m = txt.match(/(\d{1,3}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const num = m[1].replace(/\./g, "").replace(",", ".");
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; fiyat-cepte/1.0; +https://vercel.com/)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function toBrandCityShape(pricesByCityByBrand) {
  // input: { BRAND: { CITY: {...} } } zaten bu formatta olacak
  return pricesByCityByBrand;
}

function ensure(obj, k, init) {
  if (!obj[k]) obj[k] = init;
  return obj[k];
}

///////////////////////////
// Scrapers (Kaynak bazlı)
// Not: HTML değişirse selector/regex güncellemek gerekebilir. [web:111]
///////////////////////////
async function scrapePetrolOfisi() {
  const url = "https://www.petrolofisi.com.tr/akaryakit-fiyatlari"; // il bazlı tablo içerir [web:23]
  const html = await fetchHtml(url);

  // Basit ve dayanıklı yaklaşım: tabloda geçen şehir + sayı desenlerini satır satır yakalamaya çalış.
  // Petrol Ofisi sayfasında genelde satırlar: Şehir | Kurşunsuz 95 | Diesel | ... | Otogaz [web:23]
  // Bu parse "mükemmel" değil ama pratikte işe yarar; tutmadığı yerde log ile görürsün.
  const out = {}; // CITY_KEY -> { benzin, motorin, lpg }

  // Şehir adları Türkçe karakterli olabilir; normalize edeceğiz.
  // Tablo satırları çoğu zaman <tr> içinde; hızlı regex:
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const cellText = row
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // "İstanbul 54,xx 56,xx ... 27,xx" gibi
    // İlk kelime(ler) şehir, sonra 3 sayı yakalamaya çalış.
    const nums = cellText.match(/(\d{1,3}(?:[.,]\d{1,2})?)/g);
    if (!nums || nums.length < 2) continue;

    // Şehir adını bulmak için satırın başından ilk sayıya kadar olan kısmı al
    const firstNum = nums[0];
    const idx = cellText.indexOf(firstNum);
    if (idx <= 0) continue;

    const cityRaw = cellText.slice(0, idx).trim();
    const cityKey = normalizeCityKey(cityRaw);
    if (!cityKey) continue;

    const benzin = parseTrNumber(nums[0]);
    const motorin = parseTrNumber(nums[1]);

    // LPG genelde son sütunlarda; en sondaki sayıyı lpg diye almayı dene
    const lpg = parseTrNumber(nums[nums.length - 1]);

    const rec = {};
    if (benzin != null) rec.benzin = benzin;
    if (motorin != null) rec.motorin = motorin;
    if (lpg != null) rec.lpg = lpg;

    if (Object.keys(rec).length) out[cityKey] = rec;
  }

  return { brandKey: "PETROL_OFISI", sourceUrl: url, data: out };
}

async function scrapeAytemiz() {
  const url = "https://www.aytemiz.com.tr/akaryakit-fiyatlari/benzin-fiyatlari"; // il bazlı tablo [web:35]
  const html = await fetchHtml(url);

  const out = {}; // CITY_KEY -> { benzin, motorin }
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const cellText = row
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const nums = cellText.match(/(\d{1,3}(?:[.,]\d{1,2})?)/g);
    if (!nums || nums.length < 2) continue;

    const firstNum = nums[0];
    const idx = cellText.indexOf(firstNum);
    if (idx <= 0) continue;

    const cityRaw = cellText.slice(0, idx).trim();
    const cityKey = normalizeCityKey(cityRaw);
    if (!cityKey) continue;

    const benzin = parseTrNumber(nums[0]);
    const motorin = parseTrNumber(nums[1]);

    if (benzin == null && motorin == null) continue;
    out[cityKey] = { benzin: benzin ?? null, motorin: motorin ?? null };
  }

  return { brandKey: "AYTEMIZ", sourceUrl: url, data: out };
}

///////////////////////////
// Build + Cache
///////////////////////////
function merge(prices, brandKey, cityMap, meta) {
  const byBrand = ensure(prices, brandKey, {});
  for (const [cityKey, v] of Object.entries(cityMap || {})) {
    byBrand[cityKey] = {
      benzin: v.benzin ?? null,
      motorin: v.motorin ?? null,
      lpg: v.lpg ?? null,
      source: meta?.sourceUrl || null,
      fetchedAt: meta?.fetchedAt || null,
    };
  }
}

function buildAverages(prices) {
  const sums = {}; // CITY -> sums
  for (const brandKey of Object.keys(prices || {})) {
    for (const [cityKey, p] of Object.entries(prices[brandKey] || {})) {
      const s = ensure(sums, cityKey, { bS: 0, bN: 0, mS: 0, mN: 0, lS: 0, lN: 0 });
      if (typeof p.benzin === "number") { s.bS += p.benzin; s.bN++; }
      if (typeof p.motorin === "number") { s.mS += p.motorin; s.mN++; }
      if (typeof p.lpg === "number") { s.lS += p.lpg; s.lN++; }
    }
  }
  const avg = {};
  for (const [cityKey, s] of Object.entries(sums)) {
    avg[cityKey] = {
      benzin: s.bN ? Number((s.bS / s.bN).toFixed(2)) : null,
      motorin: s.mN ? Number((s.mS / s.mN).toFixed(2)) : null,
      lpg: s.lN ? Number((s.lS / s.lN).toFixed(2)) : null,
    };
  }
  return avg;
}

async function updatePrices() {
  const fetchedAt = new Date().toISOString();
  const prices = {};
  const sources = [];

  // Petrol Ofisi
  try {
    const po = await scrapePetrolOfisi();
    merge(prices, po.brandKey, po.data, { sourceUrl: po.sourceUrl, fetchedAt });
    sources.push({ brand: po.brandKey, ok: true, url: po.sourceUrl });
  } catch (e) {
    sources.push({ brand: "PETROL_OFISI", ok: false, error: String(e.message || e) });
  }

  // Aytemiz
  try {
    const ay = await scrapeAytemiz();
    merge(prices, ay.brandKey, ay.data, { sourceUrl: ay.sourceUrl, fetchedAt });
    sources.push({ brand: ay.brandKey, ok: true, url: ay.sourceUrl });
  } catch (e) {
    sources.push({ brand: "AYTEMIZ", ok: false, error: String(e.message || e) });
  }

  const dataToStore = {
    prices: toBrandCityShape(prices),
    averages: buildAverages(prices),
    sources,
    lastUpdate: fetchedAt,
    note: "Fiyatlar marka sitelerindeki il bazlı tablolardan otomatik alınır (KV cache).",
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

///////////////////////////
// API handlers
///////////////////////////
async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  const hasData = !!(kvData?.prices && Object.keys(kvData.prices).length);

  res.status(200).json({
    ok: true,
    hasData,
    lastUpdate: kvData?.lastUpdate || null,
    sources: kvData?.sources || [],
    note: kvData?.note || null,
  });
}

async function handlePrices(req, res) {
  let kvData = await kvGetJson("fuel:prices");

  // Yoksa oluştur
  if (!kvData) kvData = await updatePrices();

  // Eskiyse arka planda güncelle (response'u bekletmeden)
  if (hoursSince(kvData?.lastUpdate) > MAX_AGE_HOURS) {
    updatePrices().catch(() => null);
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const brandParam = url.searchParams.get("brand");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;
  const brandKey = brandParam ? normalizeCityKey(brandParam) : null;

  if (!cityKey && !brandKey) {
    return res.status(200).json(kvData);
  }

  if (brandKey && !cityKey) {
    return res.status(200).json({
      ...kvData,
      prices: { [brandKey]: kvData.prices?.[brandKey] || {} },
    });
  }

  if (cityKey && !brandKey) {
    const byBrand = {};
    for (const bk of Object.keys(kvData.prices || {})) {
      if (kvData.prices?.[bk]?.[cityKey]) byBrand[bk] = { [cityKey]: kvData.prices[bk][cityKey] };
    }
    return res.status(200).json({
      ...kvData,
      prices: byBrand,
      averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {},
    });
  }

  return res.status(200).json({
    ...kvData,
    prices: {
      [brandKey]: {
        [cityKey]: kvData.prices?.[brandKey]?.[cityKey] || {},
      },
    },
    averages: kvData.averages?.[cityKey] ? { [cityKey]: kvData.averages[cityKey] } : {},
  });
}

async function handleUpdate(_req, res) {
  const result = await updatePrices();
  res.status(200).json({ ok: true, ...result });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);

  return handlePrices(req, res);
};
