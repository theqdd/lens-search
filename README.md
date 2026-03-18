# Lens Search API

> Production-ready NLP search service for contact lens products. Parses free-form customer queries in Russian/English, extracts optical parameters, and queries a 90k+ product MongoDB catalog — all in under 5 seconds.

```
"Добрый день, нужны мультифокальные линзы -3.5 HIGH 2.5"
        ↓  claude-sonnet-4 (HydraAI)
{ lens_type: "multifocal", power: "-3.50", add: "+2.50" }
        ↓  MongoDB (indexed)
7 products matched across 4 brands
```

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 22 | Native `fetch`, ESM, top performance |
| Web framework | Fastify 5 | 2× faster than Express, built-in schema validation |
| NLP parsing | Claude Sonnet 4 via [HydraAI](https://hydraai.ru) | Handles typos, Russian slang, mixed formats |
| Fallback NLP | Anthropic SDK (claude-haiku) | Automatic failover if primary is down |
| Database | MongoDB 8.0 | Flexible schema, text search, compound indexes |
| Reverse proxy | Caddy 2 | Automatic HTTPS, zero-config TLS |
| OS | Ubuntu 24.04 LTS | UFW firewall, systemd process management |

---

## Features

- **Fault-tolerant NLP** — primary parser (HydraAI) fails → automatic fallback to Anthropic SDK
- **In-memory LRU cache** — identical queries served instantly (1000 entries, 1h TTL), zero API cost on repeated requests
- **Smart type resolution** — contact lens catalog has inconsistent `Тип линз` values across brands; the search engine checks three fields (`type`, `category_name`, `params.Тип линз`) to guarantee correct results
- **Addition normalization** — maps numeric additions (`+2.50`) to categorical values (`Высокая(High)`) AND searches `+X.XX D/N` format simultaneously — covers all brand naming conventions
- **Human-readable response** — `query_readable` field surfaces parsed parameters in plain Russian for UI display
- **Rate limiting** — 60 req/min per IP via `@fastify/rate-limit`
- **Bearer auth** — all endpoints except `/health` require `Authorization: Bearer <token>`

---

## API

### `POST /search`

**Request**
```json
{
  "query": "оазис мультифокальные двухнедельные -2.5",
  "limit": 20
}
```

**Response**
```json
{
  "query": "оазис мультифокальные двухнедельные -2.5",
  "query_readable": "Бренд: acuvue | Модель: oasys | Тип: Мультифокальные | Оптическая сила: -2.50 | Срок замены: Двухнедельные",
  "parsed": {
    "model_hint": "oasys",
    "brand_hint": "acuvue",
    "lens_type": "multifocal",
    "power": "-2.50",
    "replacement": "biweekly"
  },
  "count": 5,
  "products": [
    {
      "_id": "662910b3...",
      "barcode": "888290752454",
      "brand": "Acuvue",
      "model": "Acuvue Oasys Multifocal",
      "name": "Acuvue Oasys Multifocal 8.4;-2.50;Средняя от +1.50D до +1.75D",
      "params": { ... }
    }
  ]
}
```

**Headers**
```
Authorization: Bearer <API_SECRET>
Content-Type: application/json
```

### `GET /health`
```json
{ "status": "ok", "time": "2026-03-18T00:10:08.413Z" }
```

---

## Parsed Parameters

The NLP layer extracts the following fields from free-form text:

| Field | Description | Example |
|---|---|---|
| `model_hint` | Model keywords (normalized, lowercase) | `"oasys multifocal"` |
| `brand_hint` | Brand name | `"acuvue"` |
| `lens_type` | `sphere` / `toric` / `multifocal` / `colored` | `"multifocal"` |
| `power` | Optical power `+X.XX` / `-X.XX` | `"-3.50"` |
| `cylinder` | Cylinder (toric lenses) | `"-1.25"` |
| `axis` | Axis 0–180 (toric lenses) | `180` |
| `add` | Addition: `low` / `mid` / `high` or `+X.XX` | `"high"` |
| `bc` | Base curve | `8.6` |
| `dia` | Diameter | `14.2` |
| `replacement` | `daily` / `biweekly` / `monthly` / `quarterly` | `"biweekly"` |
| `color` | Color (colored lenses) | `"карий"` |

---

## Architecture

```
Client
  │  HTTPS
  ▼
Caddy 2 (reverse proxy, TLS termination)
  │  HTTP localhost:3000
  ▼
Fastify (Node.js 22)
  ├── Auth hook (Bearer token)
  ├── Rate limiter (60 rpm/IP)
  ├── POST /search
  │     ├── LRU Cache (hit → return instantly)
  │     ├── HydraAI claude-sonnet-4 (parse query)
  │     │     └── fallback: Anthropic claude-haiku
  │     └── MongoDB query (indexed)
  └── GET /health
        └── (no auth)

MongoDB 8.0 (localhost:27017, auth required)
  └── lensdb.products (91 681 documents)
        ├── text index: model + brand + name
        ├── idx_type, idx_power, idx_cylinder
        ├── idx_axis, idx_add, idx_lens_type
        ├── idx_category_name
        └── compound: idx_type_power, idx_toric, idx_multifocal
```

---

## Getting Started

### Prerequisites
- Node.js 22+
- MongoDB 8.0 (localhost, auth enabled)
- HydraAI API key **or** Anthropic API key

### Install

```bash
git clone https://github.com/theqdd/lens-search.git
cd lens-search
npm install
cp .env.example .env
# Fill in .env with your keys
```

### Configure `.env`

```env
MONGO_URI=mongodb://lensapp:PASSWORD@127.0.0.1:27017/lensdb?authSource=lensdb
PORT=3000
HOST=127.0.0.1
HYDRA_API_KEY=sk-hydra-ai-...
ANTHROPIC_API_KEY=sk-ant-...        # optional, used as fallback
PARSER_PROVIDER=hydra               # hydra | anthropic
API_SECRET=your_secret_token_here
NODE_ENV=production
```

### Run

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

### Production deployment (systemd)

```bash
# Copy service file
cp deploy/lens-search.service /etc/systemd/system/
systemctl enable --now lens-search

# Caddy (reverse proxy)
cp deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

---

## Performance

Tested on a single-core VPS (1 vCPU / 1GB RAM):

| Metric | Value |
|---|---|
| NLP parse time (HydraAI) | ~4–6 s (network-bound) |
| MongoDB query time | < 10 ms |
| Cached query response | < 5 ms |
| Cost per unique query | ~0.07 ₽ (~$0.001) |
| Cost for cached hit | **₽0** |

Cache hit rate increases significantly in production as common queries (popular models, power ranges) repeat across users.

---

## Roadmap

- [ ] Streaming responses (SSE) for faster perceived latency
- [ ] Query result caching in Redis for multi-instance deployments
- [ ] `/search/suggest` endpoint for autocomplete
- [ ] Periodic catalog sync from source API
- [ ] Prometheus metrics endpoint

---

## License

MIT
