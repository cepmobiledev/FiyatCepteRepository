// Otomatik veri güncelleme için örnek cron-job scripti
import fetch from "node-fetch";

async function updatePrices() {
  const response = await fetch("http://localhost:3000/update", { method: "POST" });
  if (response.ok) {
    console.log("Fiyatlar güncellendi");
  } else {
    console.error("Güncelleme başarısız");
  }
}

updatePrices();
