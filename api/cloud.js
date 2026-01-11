// cloud.js
// Vercel Serverless API - Akaryakıt Cloud
//
// Kullandığı kaynak: CollectAPI Akaryakıt Fiyatları API
//   https://collectapi.com/tr/api/gasPrice/akaryakit-fiyatlari-api
//
// Routes:
//   GET /api/health
//   GET /api/prices              → tüm şehirler / filtreli şehir
//   GET /api/update              → CollectAPI'den tüm şehirleri çek, KV'ye yaz
//
// KV Key: "fuel:prices"
//
// KV ENV:
//   KV_REST_API_URL                veya  UPSTASH_REDIS_KV_REST_API_URL
//   KV_REST_API_TOKEN              veya  UPSTASH_REDIS_KV_REST_API_TOKEN
//
// CollectAPI ENV:
//   COLLECTAPI_KEY  → "apikey {KEY}" şeklinde kullanılacak KEY

///////////////////////////
// KV BAĞLANTISI
///////////////////////////

async function redisCmd(args) {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    console.error("KV env missing", { url: !!url, token: !!token });
    return { ok: false, result: null, error: "KV env missing" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      console.error("KV HTTP error", response.status);
      return { ok: false, result: null, error: `KV HTTP ${response.status}` };
    }

    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, result: null, error: "KV bad json" };
    if (json.error) {
      console.error("KV logical error", json.error);
      return { ok: false, result: null, error: String(json.error) };
    }
    return { ok: true, result: json.result, error: null };
  } catch (e) {
    console.error("KV fetch error", e);
    return { ok: false, result: null, error: String(e.message || e) };
  }
}

async function kvGetJson(key) {
  const { ok, result } = await redisCmd(["GET", key]);
  if (!ok || result == null) return null;
  if (typeof result !== "string") return null;
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
// HELPER FONKSİYONLAR
///////////////////////////

function normalizeCityKey(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .toUpperCase()
    .replace(/İ/g, "I")
    .replace(/İ/g, "I")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ş/g, "S")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/Â/g, "A")
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, "_");
}

function parsePrice(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

///////////////////////////
// COLLECTAPI İLE FİYAT ÇEKME
///////////////////////////

// Türkiye il listesi (CollectAPI Türkçe şehir adı ile çalışıyor)
const TURKEY_CITIES = [
  "Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara",
  "Antalya","Ardahan","Artvin","Aydın","Balıkesir","Bartın","Batman",
  "Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale",
  "Çankırı","Çorum","Denizli","Diyarbakır","Düzce","Edirne","Elazığ",
  "Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane",
  "Hakkari","Hatay","Iğdır","Isparta","İstanbul","İzmir","Kahramanmaraş",
  "Karabük","Karaman","Kars","Kastamonu","Kayseri","Kırıkkale","Kırklareli",
  "Kırşehir","Kilis","Kocaeli","Konya","Kütahya","Malatya","Manisa",
  "Mardin","Mersin","Muğla","Muş","Nevşehir","Niğde","Ordu","Osmaniye",
  "Rize","Sakarya","Samsun","Siirt","Sinop","Sivas","Şanlıurfa","Şırnak",
  "Tekirdağ","Tokat","Trabzon","Tunceli","Uşak","Van","Yalova","Yozgat",
  "Zonguldak"
];

const COLLECTAPI_BASE =
  "https://api.collectapi.com/gasPrice/fromCity"; // ?city={SEHIR}[web:54]

function getCollectApiKey() {
  const key = process.env.COLLECTAPI_KEY;
  if (!key) {
    console.error("COLLECTAPI_KEY env missing");
  }
  return key;
}

// CollectAPI response örneği (özet):
// {
//   "success": true,
//   "result": [
//     {
//       "city": "İstanbul",
//       "name": "OPET",
//       "district": "BAĞCILAR",
//       "gasoline": "42,50",
//       "diesel": "40,20",
//       "lpg": "22,10"
//     },
//     ...
//   ]
// }

async function fetchCityFromCollectAPI(cityName) {
  const apiKey = getCollectApiKey();
  if (!apiKey) return [];

  const url = `${COLLECTAPI_BASE}?city=${encodeURIComponent(cityName)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "content-type": "application/json",
        authorization: `apikey ${apiKey}`, // CollectAPI bu formatı istiyor[web:54]
      },
    });

    if (!res.ok) {
      console.error("CollectAPI city error", cityName, res.status);
      return [];
    }

    const json = await res.json().catch(() => null);
    if (!json || !json.success || !Array.isArray(json.result)) {
      return [];
    }
    return json.result;
  } catch (e) {
    console.error("CollectAPI fetch error", cityName, e);
    return [];
  }
}

///////////////////////////
// TÜM ŞEHİRLERİ ÇEK + KV YE YAZ
///////////////////////////

// KV'de tutulan yapı:
//
// {
//   allFirmPrices: {
//     OPET: {
//       ISTANBUL__BAGCILAR_1: { city, district, stationName, benzin, motorin, lpg },
//       ...
//     },
//     SHELL: {...},
//     ...
//   },
//   cityAverages: {
//     ISTANBUL: { benzin, motorin, lpg },
//     ISPARTA: { ... },
//     ...
//   },
//   sources: ["collectapi"],
//   lastUpdate: ISO_STRING
// }

function buildStructuresFromCollectData(allCityResults) {
  const allFirmPrices = {};
  const cityBuckets = {};

  let stationIdCounter = 0;

  for (const cityResult of allCityResults) {
    for (const item of cityResult) {
      const brandName = (item.name || "").toString().trim().toUpperCase();
      if (!brandName) continue;

      const cityRaw = item.city || "";
      const districtRaw = item.district || "";
      const cityKey = normalizeCityKey(cityRaw);
      const districtKey = normalizeCityKey(districtRaw);
      const locKey = districtKey && districtKey !== cityKey
        ? `${cityKey}__${districtKey}_${++stationIdCounter}`
        : `${cityKey}_${++stationIdCounter}`;

      const benzin = parsePrice(item.gasoline);
      const motorin = parsePrice(item.diesel);
      const lpg = parsePrice(item.lpg);

      if (!allFirmPrices[brandName]) allFirmPrices[brandName] = {};
      allFirmPrices[brandName][locKey] = {
        brand: brandName,
        city: cityKey,
        district: districtKey,
        stationName: item.name || "",
        benzin,
        motorin,
        lpg,
      };

      if (!cityBuckets[cityKey]) {
        cityBuckets[cityKey] = { benzin: [], motorin: [], lpg: [] };
      }
      if (benzin != null) cityBuckets[cityKey].benzin.push(benzin);
      if (motorin != null) cityBuckets[cityKey].motorin.push(motorin);
      if (lpg != null) cityBuckets[cityKey].lpg.push(lpg);
    }
  }

  const cityAverages = {};
  for (const [cityKey, bucket] of Object.entries(cityBuckets)) {
    cityAverages[cityKey] = {
      benzin: bucket.benzin.length
        ? bucket.benzin.reduce((a, b) => a + b, 0) / bucket.benzin.length
        : null,
      motorin: bucket.motorin.length
        ? bucket.motorin.reduce((a, b) => a + b, 0) / bucket.motorin.length
        : null,
      lpg: bucket.lpg.length
        ? bucket.lpg.reduce((a, b) => a + b, 0) / bucket.lpg.length
        : null,
    };
  }

  return { allFirmPrices, cityAverages };
}

async function scrapeAndStoreAllPrices() {
  const allCityResults = [];

  for (const city of TURKEY_CITIES) {
    await sleep(400); // CollectAPI rate limit'i için biraz bekle[web:54]
    const result = await fetchCityFromCollectAPI(city);
    if (result.length > 0) {
      allCityResults.push(result);
    }
  }

  const { allFirmPrices, cityAverages } =
    buildStructuresFromCollectData(allCityResults);

  const dataToStore = {
    allFirmPrices,
    cityAverages,
    sources: ["collectapi"],
    lastUpdate: new Date().toISOString(),
  };

  await kvSetJson("fuel:prices", dataToStore);
  return dataToStore;
}

///////////////////////////
// API HANDLER'LARI
///////////////////////////

async function handleHealth(_req, res) {
  const kvData = await kvGetJson("fuel:prices");
  const hasData =
    kvData &&
    kvData.allFirmPrices &&
    Object.keys(kvData.allFirmPrices).length > 0;

  res.status(200).json({
    ok: true,
    hasData,
    lastUpdate: kvData?.lastUpdate || null,
    sources: kvData?.sources || [],
  });
}

async function handlePrices(req, res) {
  const kvData = await kvGetJson("fuel:prices");

  if (!kvData) {
    return res.status(200).json({
      allFirmPrices: {},
      cityAverages: {},
      lastUpdate: null,
      sources: [],
    });
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;

  const allFirmPrices = kvData.allFirmPrices || {};
  const cityAverages = kvData.cityAverages || {};

  if (!cityKey) {
    return res.status(200).json({
      allFirmPrices,
      cityAverages,
      lastUpdate: kvData.lastUpdate || null,
      sources: kvData.sources || [],
    });
  }

  // belirli şehir için filtre
  const filteredFirmPrices = {};
  for (const [brand, locations] of Object.entries(allFirmPrices)) {
    for (const [locKey, data] of Object.entries(locations)) {
      if (data.city === cityKey) {
        if (!filteredFirmPrices[brand]) filteredFirmPrices[brand] = {};
        filteredFirmPrices[brand][locKey] = data;
      }
    }
  }

  res.status(200).json({
    allFirmPrices: filteredFirmPrices,
    cityAverages:
      cityKey && cityAverages[cityKey]
        ? { [cityKey]: cityAverages[cityKey] }
        : {},
    lastUpdate: kvData.lastUpdate || null,
    sources: kvData.sources || [],
  });
}

async function handleUpdate(_req, res) {
  const result = await scrapeAndStoreAllPrices();
  res.status(200).json({ ok: true, ...result });
}

///////////////////////////
// MAIN EXPORT
///////////////////////////

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);

  return handlePrices(req, res);
};
s
