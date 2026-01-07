import express from "express";
import fetch from "node-fetch";
import { Low, JSONFile } from "lowdb";

const app = express();
const port = process.env.PORT || 3000;

// DB setup
const db = new Low(new JSONFile("db.json"));
await db.read();
db.data ||= { prices: {}, lastUpdate: null };

// Ana API'den veri çekme fonksiyonu
async function fetchFuelPrices(city) {
  const formattedCity = city.toUpperCase();
  try {
    const response = await fetch(
      `https://gas-price.p.rapidapi.com/prices?city=${formattedCity.toLowerCase()}`,
      {
        headers: {
          "X-RapidAPI-Key": "SENIN_KEYIN",
          "X-RapidAPI-Host": "gas-price.p.rapidapi.com",
        },
      }
    );
    if (!response.ok) throw new Error("API error");
    const json = await response.json();
    return json;
  } catch (e) {
    return null;
  }
}

// Fiyatları güncelle (tüm şehirler)
app.post("/update", async (req, res) => {
  const cities = ["ISTANBUL", "ANKARA", "IZMIR", "ISPARTA"];
  let updated = {};
  for (const city of cities) {
    const data = await fetchFuelPrices(city);
    if (data) updated[city] = data;
  }
  db.data.prices = updated;
  db.data.lastUpdate = new Date().toISOString();
  await db.write();
  res.json({ ok: true, updated });
});

// Fiyatları getir
app.get("/prices", async (req, res) => {
  await db.read();
  res.json({ prices: db.data.prices, lastUpdate: db.data.lastUpdate });
});

app.listen(port, () => {
  console.log(`Cloud API listening on port ${port}`);
});
