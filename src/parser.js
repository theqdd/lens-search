/**
 * Умный парсер запросов покупателей.
 *
 * Поддерживает два провайдера (выбирается через PARSER_PROVIDER в .env):
 *   - hydra      — HydraAI (OpenAI-совместимый), модель claude-sonnet-4  [по умолчанию]
 *   - anthropic  — Anthropic SDK, модель claude-haiku-4-5
 *
 * Примеры входящих запросов:
 *   "Помогите найти линзы оазис мультифокальные на -2.5"
 *   "контактные линзы для астигматизма ось 180 цилиндр -1.25"
 */

import Anthropic from '@anthropic-ai/sdk';

// ─── Константы ──────────────────────────────────────────────────────────────

const HYDRA_BASE_URL = 'https://api.hydraai.ru/v1';
const HYDRA_MODEL    = 'claude-sonnet-4';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты — эксперт по контактным линзам. Распарси запрос покупателя и извлеки параметры для поиска в базе данных.

Верни ТОЛЬКО JSON объект без пояснений. Поля (все опциональные):
- model_hint: ключевые слова названия модели (латиница, строчные, без бренда и параметров)
- brand_hint: бренд строчными (acuvue, alcon, coopervision, bausch lomb, johnson и т.д.)
- lens_type: тип линзы — одно из: sphere | toric | multifocal | colored
- power: оптическая сила строго в формате "+X.XX" или "-X.XX", например "-2.50", "+0.25"
- cylinder: цилиндр (торические) в формате "-X.XX" или "+X.XX", например "-1.25"
- axis: ось (торические) — целое число от 0 до 180
- add: аддидация (мультифокальные) — одно из: "low" | "mid" | "high" или числовое "+X.XX"
- color: цвет для цветных линз (строка)
- bc: базовая кривизна (число с точкой, например 8.6)
- dia: диаметр (число с точкой, например 14.2)
- replacement: период замены — одно из: daily | biweekly | monthly | quarterly

Правила нормализации:
- Оптическая сила ВСЕГДА со знаком и двумя знаками после запятой: "-2.5" → "-2.50", "2.5" → "+2.50"
- Если сила не упомянута — не добавляй поле power
- Аддидация: низкая/слабая/low → "low", средняя/medium → "mid", высокая/high → "high"
- Числовая аддидация ("+2.00", "2.5 дптр") → "+2.00" (со знаком, два знака)
- Названия моделей: "оазис" → "oasys", "акувью/acuvue" → бренд acuvue, "тотал" → "total",
  "эйр оптикс" → "air optix", "биофинити" → "biofinity", "дейли" → "dailies"
- model_hint содержит только слова модели, бренд выноси в brand_hint
- Для торических линз (астигматизм, астигматические, toric) ставь lens_type: "toric"
- Для мультифокальных (мультифокал, для пресбиопии, для чтения) ставь lens_type: "multifocal"`;


// ─── Кэш (простой LRU через Map) ────────────────────────────────────────────

const cache = new Map();
const CACHE_MAX = 1000;
const CACHE_TTL = 60 * 60 * 1000; // 1 час

function cacheGet(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { data, ts: Date.now() });
}

// ─── JSON извлечение из ответа модели ───────────────────────────────────────

function extractJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(clean);
}

// ─── Провайдер: HydraAI (OpenAI-compatible) ─────────────────────────────────

async function parseWithHydra(text) {
  const res = await fetch(`${HYDRA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.HYDRA_API_KEY}`,
    },
    body: JSON.stringify({
      model: HYDRA_MODEL,
      max_tokens: 256,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
    }),
    signal: AbortSignal.timeout(15000), // 15 сек таймаут
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HydraAI error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return extractJSON(data.choices[0].message.content);
}

// ─── Провайдер: Anthropic SDK ────────────────────────────────────────────────

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

async function parseWithAnthropic(text) {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });
  return extractJSON(message.content[0].text);
}

// ─── Публичный API ───────────────────────────────────────────────────────────

export async function parseQuery(text) {
  const key = text.trim().toLowerCase();

  const cached = cacheGet(key);
  if (cached) return cached;

  const provider = process.env.PARSER_PROVIDER || 'hydra';

  let parsed = {};
  try {
    parsed = provider === 'anthropic'
      ? await parseWithAnthropic(text)
      : await parseWithHydra(text);
  } catch (err) {
    // Если основной провайдер упал — пробуем запасной
    console.error(`[parser] ${provider} failed: ${err.message}, trying fallback`);
    try {
      parsed = provider === 'anthropic'
        ? await parseWithHydra(text)
        : await parseWithAnthropic(text);
    } catch (fallbackErr) {
      console.error(`[parser] fallback also failed: ${fallbackErr.message}`);
      parsed = {};
    }
  }

  cacheSet(key, parsed);
  return parsed;
}
