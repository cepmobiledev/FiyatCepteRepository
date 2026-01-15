import axios from 'axios';
import * as cheerio from 'cheerio';

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  BASE_URL: 'https://www.aytemiz.com.tr/akaryakit-fiyatlari/arsiv-fiyat-listesi',
  TIMEOUT: 15000,
  RETRY_COUNT: 3,
  RETRY_DELAY: 2000,
  REQUEST_DELAY: 200,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const CITIES = [
  'ADANA', 'ADIYAMAN', 'AFYON', 'AGRI', 'AKSARAY', 'AMASYA', 'ANKARA', 'ANTALYA',
  'ARDAHAN', 'ARTVIN', 'AYDIN', 'BALIKESIR', 'BARTIN', 'BATMAN', 'BAYBURT',
  'BILECIK', 'BINGOL', 'BITLIS', 'BOLU', 'BURDUR', 'BURSA', 'CANAKKALE',
  'CANKIRI', 'CORUM', 'DENIZLI', 'DIYARBAKIR', 'DUZCE', 'EDIRNE', 'ELAZIG',
  'ERZINCAN', 'ERZURUM', 'ESKISEHIR', 'GAZIANTEP', 'GIRESUN', 'GUMUSHANE',
  'HAKKARI', 'HATAY', 'IGDIR', 'ISPARTA', 'ISTANBUL', 'IZMIR', 'K.MARAS',
  'KARABUK', 'KARAMAN', 'KARS', 'KASTAMONU', 'KAYSERI', 'KILIS', 'KIRIKKALE',
  'KIRKLARELI', 'KIRSEHIR', 'KOCAELI', 'KONYA', 'KUTAHYA', 'MALATYA', 'MANISA',
  'MARDIN', 'MERSIN', 'MUGLA', 'MUS', 'NEVSEHIR', 'NIGDE', 'ORDU', 'OSMANIYE',
  'RIZE', 'SAKARYA', 'SAMSUN', 'SANLIURFA', 'SIIRT', 'SINOP', 'SIRNAK', 'SIVAS',
  'TEKIRDAG', 'TOKAT', 'TRABZON', 'TUNCELI', 'USAK', 'VAN', 'YALOVA', 'YOZGAT',
  'ZONGULDAK'
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Sleep utility for delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse Turkish decimal format to float
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.trim().replace(',', '.');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Calculate average of an array of numbers
 */
function calculateAverage(numbers) {
  if (!numbers || numbers.length === 0) return null;
  const validNumbers = numbers.filter(n => n !== null && !isNaN(n));
  if (validNumbers.length === 0) return null;
  const sum = validNumbers.reduce((a, b) => a + b, 0);
  return parseFloat((sum / validNumbers.length).toFixed(2));
}

/**
 * Retry mechanism for failed requests
 */
async function retryRequest(requestFn, retries = CONFIG.RETRY_COUNT) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retry ${i + 1}/${retries} after error: ${error.message}`);
      await sleep(CONFIG.RETRY_DELAY * (i + 1));
    }
  }
}

// ============================================================================
// AYTEMIZ SCRAPER
// ============================================================================

/**
 * Get latest available date from Aytemiz archive
 */
async function getLatestDate() {
  return retryRequest(async () => {
    const response = await axios.get(CONFIG.BASE_URL, {
      headers: { 'User-Agent': CONFIG.USER_AGENT },
      timeout: CONFIG.TIMEOUT
    });
    
    const $ = cheerio.load(response.data);
    const latestDate = $('#ContentPlaceHolder1_C002_ddlLpg option').first().attr('value');
    
    if (!latestDate) {
      throw new Error('Tarih seçeneği bulunamadı');
    }
    
    return latestDate;
  });
}

/**
 * Fetch fuel prices (Akaryakıt Pompa Fiyat) for a city
 */
async function fetchFuelPrices(city, date) {
  return retryRequest(async () => {
    const formData = new URLSearchParams({
      'ContentPlaceHolder1_C002_rdbPriceType': '0', // 0 = Akaryakıt Pompa Fiyat
      'ContentPlaceHolder1_C002_ddlLpg': date,
      'ContentPlaceHolder1_C002_selCities': city,
      'ContentPlaceHolder1_C002_btnSorgula': 'Sorgula'
    });

    const response = await axios.post(CONFIG.BASE_URL, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': CONFIG.USER_AGENT,
        'Referer': CONFIG.BASE_URL
      },
      timeout: CONFIG.TIMEOUT
    });

    return response.data;
  });
}

/**
 * Fetch LPG prices (LPG Pompa Fiyat) for a city
 */
async function fetchLPGPrices(city, date) {
  return retryRequest(async () => {
    const formData = new URLSearchParams({
      'ContentPlaceHolder1_C002_rdbPriceType': '1', // 1 = LPG Pompa Fiyat
      'ContentPlaceHolder1_C002_ddlLpg': date,
      'ContentPlaceHolder1_C002_selCities': city,
      'ContentPlaceHolder1_C002_btnSorgula': 'Sorgula'
    });

    const response = await axios.post(CONFIG.BASE_URL, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': CONFIG.USER_AGENT,
        'Referer': CONFIG.BASE_URL
      },
      timeout: CONFIG.TIMEOUT
    });

    return response.data;
  });
}

/**
 * Parse fuel prices from HTML response
 */
function parseFuelPrices(html, city) {
  const $ = cheerio.load(html);
  const table = $('#ContentPlaceHolder1_C002_gvList');
  
  if (table.length === 0) {
    throw new Error(`Tablo bulunamadı: ${city}`);
  }

  // Get all header columns
  const headers = [];
  table.find('tr').first().find('th').each((i, el) => {
    headers.push($(el).text().trim());
  });

  console.log(`${city} - Kolonlar:`, headers);

  // Parse data rows (skip header row)
  const districts = [];
  const rows = table.find('tr').slice(1);
  
  rows.each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length === 0) return;

    const districtName = $(cols.eq(0)).text().trim();
    const rowData = {
      district: districtName,
      prices: {}
    };

    // Parse each column
    cols.each((colIndex, col) => {
      if (colIndex === 0) return; // Skip district name
      const value = parsePrice($(col).text());
      const headerName = headers[colIndex];
      if (headerName && value !== null) {
        rowData.prices[headerName] = value;
      }
    });

    districts.push(rowData);
  });

  if (districts.length === 0) {
    throw new Error(`${city} için veri bulunamadı`);
  }

  // Calculate averages for each fuel type
  const fuelTypes = {};
  headers.forEach((header, index) => {
    if (index === 0) return; // Skip "İLÇE" column
    const prices = districts.map(d => d.prices[header]).filter(p => p !== null);
    if (prices.length > 0) {
      fuelTypes[header] = calculateAverage(prices);
    }
  });

  return {
    city,
    districtCount: districts.length,
    districts,
    averages: fuelTypes
  };
}

/**
 * Parse LPG prices from HTML response
 */
function parseLPGPrices(html, city) {
  const $ = cheerio.load(html);
  const table = $('#ContentPlaceHolder1_C002_gvList');
  
  if (table.length === 0) {
    throw new Error(`LPG tablosu bulunamadı: ${city}`);
  }

  const headers = [];
  table.find('tr').first().find('th').each((i, el) => {
    headers.push($(el).text().trim());
  });

  console.log(`${city} - LPG Kolonlar:`, headers);

  const districts = [];
  const rows = table.find('tr').slice(1);
  
  rows.each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length === 0) return;

    const districtName = $(cols.eq(0)).text().trim();
    const lpgPrice = parsePrice($(cols.eq(1)).text());

    if (lpgPrice !== null) {
      districts.push({
        district: districtName,
        lpg: lpgPrice
      });
    }
  });

  if (districts.length === 0) {
    throw new Error(`${city} için LPG verisi bulunamadı`);
  }

  const lpgPrices = districts.map(d => d.lpg);
  const avgLPG = calculateAverage(lpgPrices);

  return {
    city,
    districtCount: districts.length,
    districts,
    average: avgLPG
  };
}

/**
 * Scrape all prices for a single city
 */
async function scrapeCityPrices(city, date) {
  console.log(`\n📍 ${city} fiyatları çekiliyor...`);
  
  try {
    // Fetch fuel prices (Akaryakıt Pompa Fiyat)
    console.log(`  ⛽ Akaryakıt fiyatları alınıyor...`);
    const fuelHtml = await fetchFuelPrices(city, date);
    const fuelData = parseFuelPrices(fuelHtml, city);
    
    await sleep(CONFIG.REQUEST_DELAY);
    
    // Fetch LPG prices
    console.log(`  🔥 LPG fiyatları alınıyor...`);
    const lpgHtml = await fetchLPGPrices(city, date);
    const lpgData = parseLPGPrices(lpgHtml, city);

    // Combine results
    const result = {
      city,
      success: true,
      fuel: {
        districtCount: fuelData.districtCount,
        districts: fuelData.districts,
        averages: fuelData.averages
      },
      lpg: {
        districtCount: lpgData.districtCount,
        districts: lpgData.districts,
        average: lpgData.average
      },
      // Simplified output for API
      summary: {
        benzin95: fuelData.averages['K#Benzin 95 Oktan OPTIMUM'] || fuelData.averages['Motorin'] || null,
        motorin: fuelData.averages['Motorin'] || fuelData.averages['Motorin OPTIMUM'] || null,
        lpg: lpgData.average
      }
    };

    console.log(`  ✅ ${city} tamamlandı - ${fuelData.districtCount} ilçe`);
    return result;

  } catch (error) {
    console.error(`  ❌ ${city} hatası: ${error.message}`);
    return {
      city,
      success: false,
      error: error.message
    };
  }
}

/**
 * Main scraper function for all cities
 */
