# FiyatCepte Cloud API (Vercel)

Bu klasör Vercel'e deploy edilecek minimal serverless API repo'sudur.

## Endpoints

- `GET /api/health`
- `GET /api/source?token=...&type=gasoline|diesel|lpg&city=ankara`
- `GET /api/update?token=...`
- `GET /api/prices`
- `GET /api/prices?city=Istanbul`

## Gerekli Environment Variables (Vercel)

Vercel Dashboard → Project → Settings → Environment Variables:

- `COLLECTAPI_KEY`
- `UPDATE_TOKEN`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Opsiyonel:
- `COLLECTAPI_BASE_URL` (default: `https://api.collectapi.com/gasPrice`)
- `COLLECTAPI_CONCURRENCY` (default: `3`) — 81 şehir * 3 istek olduğu için düşük tut.
- `COLLECTAPI_RETRIES` (default: `2`) — 429/5xx hatalarında tekrar deneme.

## Deploy

1. Bu klasörü (`github-upload/`) GitHub'a repo olarak yükle.
2. Vercel → New Project → repo'yu seç.
3. Root Directory repo root olacak.
4. Deploy.

## Test

- Health: `/api/health`
- Upstream debug: `/api/source?token=...&type=lpg&city=ankara`
- KV doldur: `/api/update?token=...`
- KV oku: `/api/prices` veya `/api/prices?city=ankara`
