// Single-file Vercel Serverless API
// Routes: /api/health, /api/prices, /api/update, /api/source

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
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/[^A-Z0-9]/g, '');
}

function toCollectCityParam(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/İ/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return item.city || item.City || item.name || item.Name || item.il || item.IL || item.sehir || item.Sehir || item.province || item.Province || '';
}

function extractPrice(item) {
  if (!item || typeof item !== 'object') return null;
  return (
    parseMaybeNumber(item.price) ??
    parseMaybeNumber(item.Price) ??
    parseMaybeNumber(item.value) ??
    parseMaybeNumber(item.Value) ??
    parseMaybeNumber(item.benzin) ??
    parseMaybeNumber(item.motorin) ??
    parseMaybeNumber(item.gasoline) ??
    parseMaybeNumber(item.diesel) ??
    parseMaybeNumber(item.lpg) ??
    parseMaybeNumber(item.autogas) ??
    null
  );
}

function minPriceFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let min = null;
  for (const item of arr) {
    const p = extractPrice(item);
    if (p == null) continue;
    if (min == null || p < min) min = p;
  }
  return min;
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

function getRoute(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (p.endsWith('/health')) return 'health';
  if (p.endsWith('/prices')) return 'prices';
  if (p.endsWith('/update')) return 'update';
  if (p.endsWith('/source')) return 'source';
  return 'prices';
}

function requireToken(req, res) {
  const token = req.query && req.query.token ? String(req.query.token) : '';
  const expected = process.env.UPDATE_TOKEN || '';
  if (!expected || token !== expected) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

// ---------------- Petrol Ofisi Scraper (Primary) ----------------
async function fetchPetrolOfisiPrices() {
  // Petrol Ofisi sayfası tek istekte 81 ilin tüm fiyatlarını veriyor
  const url = 'https://www.petrolofisi.com.tr/akaryakit-fiyatlari';
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    
    if (!response.ok) return null;
    const html = await response.text();
    
    const pricesByCity = {};
    
    // HTML'den şehir bloklarını parse et
    // Format: "SEHIR V/Max Kurşunsuz 9553.17 TL/LT V/Max Diesel54.58 TL/LT ... PO/gaz Otogaz29.03 TL/LT"
    const cityPattern = /([A-ZİĞÜŞÖÇIı]+(?:\s*\([^)]+\))?)\s+V\/Max Kurşunsuz 95([\d,\.]+)\s*TL\/LT\s+V\/Max Diesel([\d,\.]+)\s*TL\/LT[^P]*PO\/gaz Otogaz([\d,\.]+)\s*TL\/LT/gi;
    
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      // "ISTANBUL (AVRUPA)" -> "ISTANBUL" şeklinde normalize et
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      
      const benzin = parseMaybeNumber(match[2]);
      const motorin = parseMaybeNumber(match[3]);
      const lpg = parseMaybeNumber(match[4]);
      
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        
        // Eğer şehir zaten varsa (örn: ISTANBUL AVRUPA ve ANADOLU) en düşük fiyatı al
        if (!pricesByCity[cityKey]) {
          pricesByCity[cityKey] = {};
        }
        
        if (benzin != null) {
          if (!pricesByCity[cityKey].benzin || benzin < pricesByCity[cityKey].benzin) {
            pricesByCity[cityKey].benzin = benzin;
          }
        }
        if (motorin != null) {
          if (!pricesByCity[cityKey].motorin || motorin < pricesByCity[cityKey].motorin) {
            pricesByCity[cityKey].motorin = motorin;
          }
        }
        if (lpg != null) {
          if (!pricesByCity[cityKey].lpg || lpg < pricesByCity[cityKey].lpg) {
            pricesByCity[cityKey].lpg = lpg;
          }
        }
      }
    }
    
    if (Object.keys(pricesByCity).length === 0) return null;
    return { prices: pricesByCity, lastUpdate: new Date().toISOString(), source: 'petrolofisi' };
  } catch (e) {
    return null;
  }
}

// ---------------- CollectAPI fetch & merge (Fallback) ----------------
const TURKEY_CITIES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin',
  'Aydın', 'Balıkesir', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa',
  'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan',
  'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Isparta',
  'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla',
  'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop',
  'Sivas', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van',
  'Yozgat', 'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman', 'Kırıkkale', 'Batman', 'Şırnak',
  'Bartın', 'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye', 'Düzce'
];

async function fetchCollectApiMerged() {
  const collectKey = process.env.COLLECTAPI_KEY;
  if (!collectKey) return null;

  const base = process.env.COLLECTAPI_BASE_URL || 'https://api.collectapi.com/gasPrice';
  const headers = {
    authorization: `apikey ${collectKey}`,
    'content-type': 'application/json',
  };

  const retries = Math.max(0, Math.min(5, Number.parseInt(process.env.COLLECTAPI_RETRIES || '2', 10) || 2));
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(process.env.COLLECTAPI_CONCURRENCY || '3', 10) || 3));

  async function fetchJsonWithRetry(url) {
    let attempt = 0;
    // 429/5xx durumlarında kısa backoff ile retry.
    while (true) {
      let response;
      try {
        response = await fetch(url, { headers });
      } catch (e) {
        if (attempt >= retries) return { ok: false, status: 0, json: null, text: String(e) };
        await sleep(250 * Math.pow(2, attempt));
        attempt += 1;
        continue;
      }

      const status = response.status;
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { }

      if (response.ok) return { ok: true, status, json, text };

      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt >= retries) {
        return { ok: false, status, json, text };
      }

      await sleep(250 * Math.pow(2, attempt));
      attempt += 1;
    }
  }

  async function fetchCityFuel(city, fuelType) {
    try {
      const cityParam = toCollectCityParam(city);
      const url = `${base.replace(/\/$/, '')}/${fuelType}?city=${encodeURIComponent(cityParam)}`;
      const { ok, json } = await fetchJsonWithRetry(url);
      if (!ok) return null;
      const arr = extractArray(json);
      if (!arr || arr.length === 0) return null;
      // İstasyondan gelen liste içinde en düşük fiyatı al
      return minPriceFromArray(arr);
    } catch {
      return null;
    }
  }

  const pricesByCity = {};

  // 81 şehir * 3 istek = 243 istek. Tam paralel gidince upstream 500/limit oluyor.
  // Bu yüzden sınırlı paralellik ile şehirleri işliyoruz.
  let idx = 0;
  async function worker() {
    while (true) {
      const current = idx;
      idx += 1;
      if (current >= TURKEY_CITIES.length) return;

      const city = TURKEY_CITIES[current];
      const [benzin, motorin, lpg] = await Promise.all([
        fetchCityFuel(city, 'turkeyGasoline'),
        fetchCityFuel(city, 'turkeyDiesel'),
        fetchCityFuel(city, 'turkeyLpg'),
      ]);

      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(city);
        pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (Object.keys(pricesByCity).length === 0) return null;
  return { prices: pricesByCity, lastUpdate: new Date().toISOString() };
}

// ---------------- Handlers ----------------
async function handleHealth(_req, res) {
  const hasKvEnv = Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN)
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
  const city = req.query && req.query.city ? String(req.query.city) : undefined;

  const kvData = await kvGetJson('fuel:prices');
  if (kvData && typeof kvData === 'object') {
    const prices = kvData.prices && typeof kvData.prices === 'object' ? kvData.prices : {};
    const lastUpdate = kvData.lastUpdate ?? null;
    if (city) {
      const key = normalizeCityKey(city);
      return res.status(200).json({ price: prices[key] || null, lastUpdate });
    }
    return res.status(200).json({ prices, lastUpdate });
  }

  return res.status(200).json({ prices: {}, lastUpdate: null });
}

async function handleSource(req, res) {
  if (!requireToken(req, res)) return;

  const collectKey = process.env.COLLECTAPI_KEY;
  if (!collectKey) {
    return res.status(400).json({ ok: false, error: 'COLLECTAPI_KEY missing' });
  }

  const type = req.query && req.query.type ? String(req.query.type) : 'gasoline';
  const city = req.query && req.query.city ? String(req.query.city) : 'ankara';
  const limitRaw = req.query && req.query.limit ? String(req.query.limit) : '10';
  const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 10));

  const map = { gasoline: 'turkeyGasoline', diesel: 'turkeyDiesel', lpg: 'turkeyLpg' };
  const pathSuffix = map[type];
  if (!pathSuffix) {
    return res.status(400).json({ ok: false, error: 'type must be gasoline|diesel|lpg' });
  }

  const base = process.env.COLLECTAPI_BASE_URL || 'https://api.collectapi.com/gasPrice';
  const url = `${base.replace(/\/$/, '')}/${pathSuffix}?city=${encodeURIComponent(toCollectCityParam(city))}`;

  const response = await fetch(url, {
    headers: {
      authorization: `apikey ${collectKey}`,
      'content-type': 'application/json',
    },
  });

  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }

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

  // 1. Önce Petrol Ofisi'nden dene (tek istek, tüm şehirler, benzin+motorin+lpg)
  let payload = await fetchPetrolOfisiPrices();
  let source = 'petrolofisi';
  
  // 2. Petrol Ofisi başarısızsa CollectAPI'ye fallback
  if (!payload || Object.keys(payload.prices || {}).length < 10) {
    payload = await fetchCollectApiMerged();
    source = 'collectapi';
  }

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'no payload from any source' });
  }

  const prices = payload.prices && typeof payload.prices === 'object' ? payload.prices : null;
  if (!prices || Object.keys(prices).length === 0) {
    return res.status(400).json({ ok: false, error: 'no valid prices' });
  }

  const dataToStore = {
    prices,
    lastUpdate: payload.lastUpdate || new Date().toISOString(),
    source,
  };

  const ok = await kvSetJson('fuel:prices', dataToStore);
  if (!ok) return res.status(500).json({ ok: false, error: 'kv write failed' });

  return res.status(200).json({ ok: true, cities: Object.keys(prices).length, source, lastUpdate: dataToStore.lastUpdate });
}

module.exports = async (req, res) => {
  const route = getRoute(req);
  if (route === 'health') return handleHealth(req, res);
  if (route === 'prices') return handlePrices(req, res);
  if (route === 'source') return handleSource(req, res);
  if (route === 'update') return handleUpdate(req, res);
  return handlePrices(req, res);
};
