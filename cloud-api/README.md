# Cloud API

Bu klasör, ana yakıt fiyatı API'sinden verileri çekip saklayan ve mobil uygulamanıza sunan bir Express sunucusu içerir.

## Özellikler
- `/update` (POST): Tüm şehirlerin fiyatlarını ana API'den çeker ve kaydeder.
- `/prices` (GET): Kayıtlı tüm fiyatları ve son güncelleme zamanını döner.

## Kurulum
1. `npm install`
2. `npm start`

## Notlar
- `SENIN_KEYIN` kısmını kendi RapidAPI anahtarınız ile değiştirin.
- Otomatik güncelleme için bir cron-job veya cloud fonksiyonu ekleyebilirsiniz.
