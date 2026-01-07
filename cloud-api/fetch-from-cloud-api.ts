// Bu dosya, mobil uygulamanızda cloud API'den fiyatları çekmek için örnek kod içerir.

export async function fetchPricesFromCloudAPI() {
  const response = await fetch("https://SENIN_CLOUD_API_URLIN/prices");
  if (!response.ok) throw new Error("Cloud API'den veri alınamadı");
  const data = await response.json();
  return data;
}
