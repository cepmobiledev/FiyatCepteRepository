# Cloud Servis Önerisi ve Kurulum

## Önerilen Servisler

### 1. Vercel (Ücretsiz ve Kolay)
- Node.js projelerini kolayca deploy edebilirsiniz.
- Otomatik olarak her push'ta güncellenir.
- Küçük projeler için ücretsizdir.
- [https://vercel.com/](https://vercel.com/)

### 2. Render.com (Ücretsiz Planı Var)
- Node.js sunucusu için kolay deploy.
- Otomatik cron-job desteği ile günlük güncelleme yapılabilir.
- [https://render.com/](https://render.com/)

### 3. Railway.app (Kolay ve Hızlı)
- Node.js projeleri için hızlı deploy.
- [https://railway.app/](https://railway.app/)

## Kurulum Adımları (Vercel için örnek)
1. [Vercel'e](https://vercel.com/) ücretsiz kaydolun.
2. Proje klasörünüzü (cloud-api) bir GitHub reposuna yükleyin.
3. Vercel'de "New Project" diyerek GitHub reposunu seçin.
4. Ortam değişkenlerine RapidAPI anahtarınızı ekleyin (örn: X_RAPIDAPI_KEY).
5. Deploy'a tıklayın.
6. Size verilen URL'yi uygulamanızda kullanın.

## Otomatik Güncelleme
- Render.com veya Railway'de cron-job ile `auto-update.js` dosyasını her gün çalıştırabilirsiniz.
- Vercel'de otomatik zamanlayıcı için ek servisler (örn. GitHub Actions, EasyCron) kullanılabilir.

Sorularınız olursa detaylı yardımcı olabilirim!