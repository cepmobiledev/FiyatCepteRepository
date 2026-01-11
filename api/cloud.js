// cloud.js - Yasal benzinlik sitelerinden fiyatları scrape eden Vercel Serverless API
// Routes: /api/health, /api/prices, /api/update, /api/source

// ---------------- KV (Upstash/Vercel KV REST) ----------------
async function redisCmd(args) {
  // Hem klasik hem Upstash env isimlerini destekle
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('KV env missing', { url, token });
    return { ok: false, result: null, error: 'KV env missing' };
  }

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
    .replace(/Ä°/g, 'I')
    .replace(/Ä/g, 'G')
    .replace(/Ãœ/g, 'U')
    .replace(/Å/g, 'S')
    .replace(/Ã–/g, 'O')
    .replace(/Ã‡/g, 'C')
    .replace(/[^A-Z0-9]/g, '');
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

// ---------------- Scraper Fonksiyonları ----------------
// Her marka için ayrı fonksiyonlar
// Template: Her fonksiyon ilgili sitenin HTML'inden fiyatları çeker ve şehir/fiyat/marka bilgisi döner

async function fetchPetrolOfisiPrices() {
  // Petrol Ofisi scraping
  // https://www.petrolofisi.com.tr/akaryakit-fiyatlari
  try {
    const response = await fetch('https://www.petrolofisi.com.tr/akaryakit-fiyatlari', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // <tr class="price-row district-..." data-disctrict-name="ANKARA">
    // <td>ANKARA</td>
    // <td><span class="with-tax">54.00</span>...</td> (benzin)
    // <td><span class="with-tax">55.58</span>...</td> (motorin)
    // ... diğer sütunlar ...
    // <td><span class="with-tax">29.29</span>...</td> (LPG/otogaz)  <--- 7. sütun!
    const cityPattern = /price-row[^>]+data-disctrict-name="([^"\n]+)"[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
      // Tüm <span class="with-tax">...</span> değerlerini sırayla al
      const tdMatches = [...match[0].matchAll(/<span class="with-tax">(\d+\.\d+)<\/span>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1]) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1]) : null;
      // 7. sütun varsa LPG olarak al
      const lpg = tdMatches[6] ? parseMaybeNumber(tdMatches[6][1]) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = cityName.toUpperCase();
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

async function fetchOpetPrices() {
  // Opet scraping
  // https://www.opet.com.tr/akaryakit-fiyatlari
  try {
    const response = await fetch('https://www.opet.com.tr/akaryakit-fiyatlari', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // <tr data-city="ANKARA">
    // <td>ANKARA</td>
    // <td>54.00</td> (benzin)
    // <td>55.58</td> (motorin)
    // <td>45.22</td> (lpg)
    const cityPattern = /<tr[^>]*data-city="([^"]+)"[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      const tdMatches = [...match[0].matchAll(/<td>(\d+[\.,]\d+)<\/td>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1].replace(',', '.')) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1].replace(',', '.')) : null;
      const lpg = tdMatches.length > 0 ? parseMaybeNumber(tdMatches[tdMatches.length - 1][1].replace(',', '.')) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

async function fetchShellPrices() {
  // Shell scraping
  // https://www.shell.com.tr/tuketici-istasyonlari/akaryakit-fiyatlari.html
  try {
    const response = await fetch('https://www.shell.com.tr/tuketici-istasyonlari/akaryakit-fiyatlari.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // Shell sitesinde şehir bazında tablo: <tr><td>ANKARA</td><td>54.00</td><td>55.58</td><td>45.22</td></tr>
    const cityPattern = /<tr[^>]*>\s*<td>([^<]+)<\/td>[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      const tdMatches = [...match[0].matchAll(/<td>(\d+[\.,]\d+)<\/td>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1].replace(',', '.')) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1].replace(',', '.')) : null;
      const lpg = tdMatches.length > 0 ? parseMaybeNumber(tdMatches[tdMatches.length - 1][1].replace(',', '.')) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

async function fetchBPPrices() {
  // BP scraping
  // https://www.bp.com.tr/tr_tr/turkey/home/urunler/akaryakit-fiyatlari.html
  try {
    const response = await fetch('https://www.bp.com.tr/tr_tr/turkey/home/urunler/akaryakit-fiyatlari.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // BP sitesinde şehir bazında tablo: <tr><td>ANKARA</td><td>54.00</td><td>55.58</td><td>45.22</td></tr>
    const cityPattern = /<tr[^>]*>\s*<td>([^<]+)<\/td>[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      const tdMatches = [...match[0].matchAll(/<td>(\d+[\.,]\d+)<\/td>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1].replace(',', '.')) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1].replace(',', '.')) : null;
      const lpg = tdMatches.length > 0 ? parseMaybeNumber(tdMatches[tdMatches.length - 1][1].replace(',', '.')) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

async function fetchTotalPrices() {
  // Total scraping
  // https://www.totalenergies.com.tr/akaryakit-fiyatlari
  try {
    const response = await fetch('https://www.totalenergies.com.tr/akaryakit-fiyatlari', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // Total sitesinde şehir bazında tablo: <tr><td>ANKARA</td><td>54.00</td><td>55.58</td><td>45.22</td></tr>
    const cityPattern = /<tr[^>]*>\s*<td>([^<]+)<\/td>[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      const tdMatches = [...match[0].matchAll(/<td>(\d+[\.,]\d+)<\/td>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1].replace(',', '.')) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1].replace(',', '.')) : null;
      const lpg = tdMatches.length > 0 ? parseMaybeNumber(tdMatches[tdMatches.length - 1][1].replace(',', '.')) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

async function fetchAytemizPrices() {
  // Aytemiz scraping
  // https://www.aytemiz.com.tr/akaryakit-fiyatlari
  try {
    const response = await fetch('https://www.aytemiz.com.tr/akaryakit-fiyatlari', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) return {};
    const html = await response.text();
    const pricesByCity = {};
    // Aytemiz sitesinde şehir bazında tablo: <tr><td>ANKARA</td><td>54,00</td><td>55,58</td><td>45,22</td></tr>
    const cityPattern = /<tr[^>]*>\s*<td>([^<]+)<\/td>[\s\S]*?<\/tr>/g;
    let match;
    while ((match = cityPattern.exec(html)) !== null) {
      let cityName = match[1].trim();
      cityName = cityName.replace(/\s*\([^)]+\)/, '').trim();
      const tdMatches = [...match[0].matchAll(/<td>(\d+[\.,]\d+)<\/td>/g)];
      const benzin = tdMatches[0] ? parseMaybeNumber(tdMatches[0][1].replace(',', '.')) : null;
      const motorin = tdMatches[1] ? parseMaybeNumber(tdMatches[1][1].replace(',', '.')) : null;
      const lpg = tdMatches.length > 0 ? parseMaybeNumber(tdMatches[tdMatches.length - 1][1].replace(',', '.')) : null;
      if (benzin != null || motorin != null || lpg != null) {
        const cityKey = normalizeCityKey(cityName);
        if (!pricesByCity[cityKey]) pricesByCity[cityKey] = {};
        if (benzin != null) pricesByCity[cityKey].benzin = benzin;
        if (motorin != null) pricesByCity[cityKey].motorin = motorin;
        if (lpg != null) pricesByCity[cityKey].lpg = lpg;
      }
    }
    return pricesByCity;
  } catch {
    return {};
  }
}

// ... Diğer markalar eklenebilir ...

// ---------------- Toplu Scrape ve KV'ye Kaydetme ----------------
// Şehir bazında ortalama fiyat hesaplama
function calculateCityAverages(allResults) {
  const cityMap = {};
  // Her markanın fiyatlarını şehir bazında topla
  for (const marka in allResults) {
    const prices = allResults[marka];
    for (const city in prices) {
      if (!cityMap[city]) cityMap[city] = { benzin: [], motorin: [], lpg: [] };
      if (prices[city].benzin != null) cityMap[city].benzin.push(prices[city].benzin);
      if (prices[city].motorin != null) cityMap[city].motorin.push(prices[city].motorin);
      if (prices[city].lpg != null) cityMap[city].lpg.push(prices[city].lpg);
    }
  }
  // Ortalama hesapla
  const cityAverages = {};
  for (const city in cityMap) {
    cityAverages[city] = {
      benzin: cityMap[city].benzin.length ? (cityMap[city].benzin.reduce((a, b) => a + b, 0) / cityMap[city].benzin.length) : null,
      motorin: cityMap[city].motorin.length ? (cityMap[city].motorin.reduce((a, b) => a + b, 0) / cityMap[city].motorin.length) : null,
      lpg: cityMap[city].lpg.length ? (cityMap[city].lpg.reduce((a, b) => a + b, 0) / cityMap[city].lpg.length) : null,
    };
  }
  return cityAverages;
}
async function scrapeAndStoreAllPrices() {
  const allResults = {};
  const sources = [];
  // Her markadan fiyatları çek
  const petrolOfisi = await fetchPetrolOfisiPrices();
  if (petrolOfisi && Object.keys(petrolOfisi).length > 0) {
    allResults['PETROLOFISI'] = petrolOfisi;
    sources.push('petrolofisi');
  }
  const opet = await fetchOpetPrices();
  if (opet && Object.keys(opet).length > 0) {
    allResults['OPET'] = opet;
    sources.push('opet');
  }
  const shell = await fetchShellPrices();
  if (shell && Object.keys(shell).length > 0) {
    allResults['SHELL'] = shell;
    sources.push('shell');
  }
  const bp = await fetchBPPrices();
  if (bp && Object.keys(bp).length > 0) {
    allResults['BP'] = bp;
    sources.push('bp');
  }
  const total = await fetchTotalPrices();
  if (total && Object.keys(total).length > 0) {
    allResults['TOTAL'] = total;
    sources.push('total');
  }
  const aytemiz = await fetchAytemizPrices();
  if (aytemiz && Object.keys(aytemiz).length > 0) {
    allResults['AYTEMIZ'] = aytemiz;
    sources.push('aytemiz');
  }
  const sunpet = await fetchSunpetPrices();
  if (sunpet && Object.keys(sunpet).length > 0) {
    allResults['SUNPET'] = sunpet;
    sources.push('sunpet');
  }
  const alpet = await fetchAlpetPrices();
  if (alpet && Object.keys(alpet).length > 0) {
    allResults['ALPET'] = alpet;
    sources.push('alpet');
  }
  const lukoil = await fetchLukoilPrices();
  if (lukoil && Object.keys(lukoil).length > 0) {
    allResults['LUKOIL'] = lukoil;
    sources.push('lukoil');
  }
  // ... Diğer markalar için de aynı şekilde ekleyebilirsin ...
  // ... Diğer markalar ...

  // KV'ye her firmanın fiyatlarını ayrı ayrı kaydet
  const dataToStore = {
    allFirmPrices: allResults,
    lastUpdate: new Date().toISOString(),
    sources,
  };
  await kvSetJson('fuel:prices', dataToStore);
  return dataToStore;
}

// ---------------- Handlers ----------------
async function handleHealth(_req, res) {
  // KV ve veri durumu kontrolü
  let lastUpdate = null;
  let hasData = false;
  const kvData = await kvGetJson('fuel:prices');
  if (kvData && typeof kvData === 'object') {
    hasData = Boolean(kvData.prices && typeof kvData.prices === 'object' && Object.keys(kvData.prices).length > 0);
    lastUpdate = kvData.lastUpdate ?? null;
  }
  return res.status(200).json({ ok: true, hasData, lastUpdate });
}
async function handlePrices(req, res) {
  // KV'den fiyatları çek
  const kvData = await kvGetJson('fuel:prices');
  if (kvData && typeof kvData === 'object') {
    const prices = kvData.allFirmPrices && typeof kvData.allFirmPrices === 'object' ? kvData.allFirmPrices : {};
    const lastUpdate = kvData.lastUpdate ?? null;
    return res.status(200).json({ prices, lastUpdate });
  }
  return res.status(200).json({ prices: {}, lastUpdate: null });
}
async function handleUpdate(req, res) {
  // ... Scrape ve KV'ye kaydet ...
  const result = await scrapeAndStoreAllPrices();
  return res.status(200).json({ ok: true, result });
}

module.exports = async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (p.endsWith('/health')) return handleHealth(req, res);
  if (p.endsWith('/prices')) return handlePrices(req, res);
  if (p.endsWith('/update')) return handleUpdate(req, res);
  return handlePrices(req, res);
};
