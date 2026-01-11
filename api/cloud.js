// cloud.js
// Vercel Serverless API
// Routes:
//   GET /api/health
//   GET /api/prices
//   GET /api/update
//
// Amaç:
// - Petrol Ofisi, Opet, Shell, Total, BP, Aytemiz sitelerinden şehir/ilçe bazlı fiyatları çek
// - KV'de sakla: tüm ham veriler + şehir ortalamaları
// - Uygulamaya JSON formatında sun: { cityAverages, allFirmPrices, lastUpdate, sources }

///////////////////////////
// KV BAĞLANTISI (UPSTASH / VERCEL KV)
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
      console.error("KV error", json.error);
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

function normalizeDistrictKey(input) {
  if (!input) return "";
  return normalizeCityKey(input);
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

// şehir + ilçe key üretimi
function makeLocationKey(city, district) {
  const c = normalizeCityKey(city);
  const d = normalizeDistrictKey(district || "");
  return d && d !== c ? `${c}__${d}` : c; // ISTANBUL__BAGCILAR gibi
}

///////////////////////////
// MARKA BAZLI SCRAPER'LAR
///////////////////////////

// Not: HTML yapıları zamanla değişebilir; regex'ler bozulursa güncellemek gerekir.
// Şu an mantık şöyle:
// - mümkünse şehir/ilçe tablosu bul
// - benzin, motorin, lpg kolonlarını sıraya göre parse et
// - { [locationKey]: { city, district, benzin, motorin, lpg } } döndür

//// 1) PETROL OFISI ////////////////////////
async function fetchPetrolOfisiPrices() {
  try {
    const res = await fetch(
      "https://www.petrolofisi.com.tr/akaryakit-fiyatlari",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
      }
    );
    if (!res.ok) return {};

    const html = await res.text();

    const prices = {};
    const rowRegex =
      /<tr[^>]*class="price-row[^"]*"[^>]*data-district-name="([^"]+)"[^>]*>[\s\S]*?<\/tr>/gi;

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const locationNameRaw = match[1].trim();
      // örn: "İstanbul (Avrupa) / Bağcılar"
      let cityName = locationNameRaw;
      let districtName = "";
      const parts = locationNameRaw.split("/");
      if (parts.length === 2) {
        cityName = parts[0].trim();
        districtName = parts[1].trim();
      }

      const rowHtml = match[0];
      const priceSpans = [...rowHtml.matchAll(
        /<span[^>]*class="with-tax"[^>]*>([^<]+)<\/span>/gi
      )];

      const benzin = priceSpans[0]
        ? parsePrice(priceSpans[0][1])
        : null;
      const motorin = priceSpans[1]
        ? parsePrice(priceSpans[1][1])
        : null;
      const lpg = priceSpans[6] ? parsePrice(priceSpans[6][1]) : null;

      if (benzin != null || motorin != null || lpg != null) {
        const key = makeLocationKey(cityName, districtName);
        prices[key] = {
          brand: "PETROL_OFISI",
          city: normalizeCityKey(cityName),
          district: normalizeDistrictKey(districtName),
          benzin,
          motorin,
          lpg,
        };
      }
    }

    return prices;
  } catch (e) {
    console.error("PetrolOfisi error", e);
    return {};
  }
}

//// 2) OPET ////////////////////////
async function fetchOpetPrices() {
  try {
    const res = await fetch("https://www.opet.com.tr/akaryakit-fiyatlari", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return {};

    const html = await res.text();
    const prices = {};

    const rowRegex = /<tr[^>]*data-city="([^"]+)"[^>]*>[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const cityRaw = match[1].trim();
      const cityName = cityRaw.replace(/\s*\([^)]*\)/, "").trim(); // İstanbul (Avrupa) → İstanbul
      const rowHtml = match[0];

      const tds = [...rowHtml.matchAll(/<td[^>]*>([^<]+)<\/td>/gi)];
      if (tds.length < 3) continue;

      // TD0: şehir, TD1: benzin, TD2: motorin, TD3: lpg (varsa)
      const benzin = parsePrice(tds[1][1]);
      const motorin = parsePrice(tds[2][1]);
      const lpg = tds[3] ? parsePrice(tds[3][1]) : null;

      if (benzin != null || motorin != null || lpg != null) {
        const key = makeLocationKey(cityName, "");
        prices[key] = {
          brand: "OPET",
          city: normalizeCityKey(cityName),
          district: "",
          benzin,
          motorin,
          lpg,
        };
      }
    }

    return prices;
  } catch (e) {
    console.error("Opet error", e);
    return {};
  }
}

//// 3) SHELL ////////////////////////
async function fetchShellPrices() {
  try {
    const res = await fetch(
      "https://www.shell.com.tr/suruculer/shell-yakitlari/akaryakit-pompa-satis-fiyatlari.html",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
      }
    );
    if (!res.ok) return {};

    const html = await res.text();
    const prices = {};

    // Çok tablo olduğu için sadece şehir bazlı fiyat tablosunu hedefleyen kaba bir seçim:
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[0];
      const cells = [...rowHtml.matchAll(/<td[^>]*>([^<]+)<\/td>/gi)];
      if (cells.length < 4) continue;

      const cityName = cells[0][1].trim();
      // sayı içermeyen, “İstanbul (Avrupa)” gibi görünen satırlar muhtemelen şehir satırları
      if (!/[0-9]/.test(cityName)) {
        const benzin = parsePrice(cells[1][1]);
        const motorin = parsePrice(cells[2][1]);
        const lpg = cells[3] ? parsePrice(cells[3][1]) : null;

        if (benzin != null || motorin != null || lpg != null) {
          const cityClean = cityName.replace(/\s*\([^)]*\)/, "").trim();
          const key = makeLocationKey(cityClean, "");
          prices[key] = {
            brand: "SHELL",
            city: normalizeCityKey(cityClean),
            district: "",
            benzin,
            motorin,
            lpg,
          };
        }
      }
    }

    return prices;
  } catch (e) {
    console.error("Shell error", e);
    return {};
  }
}

//// 4) TOTAL ////////////////////////
async function fetchTotalPrices() {
  try {
    const res = await fetch(
      "https://www.totalenergies.com.tr/akaryakit-fiyatlari",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
      }
    );
    if (!res.ok) return {};

    const html = await res.text();
    const prices = {};

    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[0];
      const cells = [...rowHtml.matchAll(/<td[^>]*>([^<]+)<\/td>/gi)];
      if (cells.length < 3) continue;

      const cityName = cells[0][1].trim();
      if (!cityName || /\d/.test(cityName)) continue;

      const benzin = parsePrice(cells[1][1]);
      const motorin = parsePrice(cells[2][1]);
      const lpg = cells[3] ? parsePrice(cells[3][1]) : null;

      if (benzin != null || motorin != null || lpg != null) {
        const key = makeLocationKey(cityName, "");
        prices[key] = {
          brand: "TOTAL",
          city: normalizeCityKey(cityName),
          district: "",
          benzin,
          motorin,
          lpg,
        };
      }
    }

    return prices;
  } catch (e) {
    console.error("Total error", e);
    return {};
  }
}

//// 5) BP ////////////////////////
async function fetchBPPrices() {
  try {
    const res = await fetch(
      "https://www.bp.com.tr/tr_tr/turkey/home/urunler/akaryakit-fiyatlari.html",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
      }
    );
    if (!res.ok) return {};

    const html = await res.text();
    const prices = {};

    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[0];
      const cells = [...rowHtml.matchAll(/<td[^>]*>([^<]+)<\/td>/gi)];
      if (cells.length < 3) continue;

      const cityName = cells[0][1].trim();
      if (!cityName || /\d/.test(cityName)) continue;

      const benzin = parsePrice(cells[1][1]);
      const motorin = parsePrice(cells[2][1]);
      const lpg = cells[3] ? parsePrice(cells[3][1]) : null;

      if (benzin != null || motorin != null || lpg != null) {
        const key = makeLocationKey(cityName, "");
        prices[key] = {
          brand: "BP",
          city: normalizeCityKey(cityName),
          district: "",
          benzin,
          motorin,
          lpg,
        };
      }
    }

    return prices;
  } catch (e) {
    console.error("BP error", e);
    return {};
  }
}

//// 6) AYTEMIZ ////////////////////////
async function fetchAytemizPrices() {
  try {
    const res = await fetch("https://www.aytemiz.com.tr/akaryakit-fiyatlari", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return {};

    const html = await res.text();
    const prices = {};

    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[0];
      const cells = [...rowHtml.matchAll(/<td[^>]*>([^<]+)<\/td>/gi)];
      if (cells.length < 4) continue;

      const cityName = cells[0][1].trim();
      if (!cityName || /\d/.test(cityName)) continue;

      const benzin = parsePrice(cells[1][1]);
      const motorin = parsePrice(cells[2][1]);
      const lpg = cells[3] ? parsePrice(cells[3][1]) : null;

      if (benzin != null || motorin != null || lpg != null) {
        const key = makeLocationKey(cityName, "");
        prices[key] = {
          brand: "AYTEMIZ",
          city: normalizeCityKey(cityName),
          district: "",
          benzin,
          motorin,
          lpg,
        };
      }
    }

    return prices;
  } catch (e) {
    console.error("Aytemiz error", e);
    return {};
  }
}

///////////////////////////
// TOPLU SCRAPE + ORTALAMA
///////////////////////////

// allFirmPrices yapısı:
// {
//   PETROL_OFISI: { "ISTANBUL__BAGCILAR": { city, district, benzin, motorin, lpg }, ... },
//   OPET: { "ISTANBUL": {...}, ... },
//   ...
// }

// cityAverages yapısı:
// {
//   ISTANBUL: { benzin: 45.20, motorin: 44.10, lpg: 22.30 },
//   ISPARTA: { ... },
//   ...
// }

function calculateCityAverages(allFirmPrices) {
  const cityBuckets = {};

  for (const [brand, locations] of Object.entries(allFirmPrices)) {
    for (const [locKey, data] of Object.entries(locations)) {
      if (!data || typeof data !== "object") continue;
      const cityKey = data.city || locKey.split("__")[0];

      if (!cityBuckets[cityKey]) {
        cityBuckets[cityKey] = {
          benzin: [],
          motorin: [],
          lpg: [],
        };
      }

      if (data.benzin != null) cityBuckets[cityKey].benzin.push(data.benzin);
      if (data.motorin != null) cityBuckets[cityKey].motorin.push(data.motorin);
      if (data.lpg != null) cityBuckets[cityKey].lpg.push(data.lpg);
    }
  }

  const cityAverages = {};
  for (const [city, bucket] of Object.entries(cityBuckets)) {
    cityAverages[city] = {
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

  return cityAverages;
}

async function scrapeAndStoreAllPrices() {
  const allFirmPrices = {};
  const sources = [];

  const tasks = [
    ["PETROL_OFISI", fetchPetrolOfisiPrices],
    ["OPET", fetchOpetPrices],
    ["SHELL", fetchShellPrices],
    ["TOTAL", fetchTotalPrices],
    ["BP", fetchBPPrices],
    ["AYTEMIZ", fetchAytemizPrices],
  ];

  for (const [brand, fn] of tasks) {
    try {
      await sleep(400); // biraz yavaşlat, siteleri boğma
      const result = await fn();
      if (result && Object.keys(result).length > 0) {
        allFirmPrices[brand] = result;
        sources.push(brand.toLowerCase());
      }
    } catch (e) {
      console.error(`${brand} scrape error`, e);
    }
  }

  const cityAverages = calculateCityAverages(allFirmPrices);

  const dataToStore = {
    allFirmPrices,
    cityAverages,
    sources,
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
    typeof kvData.allFirmPrices === "object" &&
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
    return res
      .status(200)
      .json({ prices: {}, cityAverages: {}, lastUpdate: null, sources: [] });
  }

  const url = new URL(req.url || "/", "http://localhost");
  const cityParam = url.searchParams.get("city");
  const cityKey = cityParam ? normalizeCityKey(cityParam) : null;

  const allFirmPrices = kvData.allFirmPrices || {};
  const cityAverages = kvData.cityAverages || {};

  if (!cityKey) {
    // tüm şehirler, tüm markalar
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
      const c = data.city || locKey.split("__")[0];
      if (c === cityKey) {
        if (!filteredFirmPrices[brand]) filteredFirmPrices[brand] = {};
        filteredFirmPrices[brand][locKey] = data;
      }
    }
  }

  res.status(200).json({
    allFirmPrices: filteredFirmPrices,
    cityAverages: cityKey && cityAverages[cityKey]
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
// MAIN EXPORT (ROUTER)
///////////////////////////

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");

  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p.endsWith("/health")) return handleHealth(req, res);
  if (p.endsWith("/prices")) return handlePrices(req, res);
  if (p.endsWith("/update")) return handleUpdate(req, res);

  // default /api/cloud → prices
  return handlePrices(req, res);
};
