/**
 * Умный парсер запросов покупателей.
 * Использует Anthropic SDK (claude-haiku-4-5).
 *
 * Примеры входящих запросов:
 *   "Помогите найти линзы оазис мультифокальные на -2.5"
 *   "контактные линзы для астигматизма ось 180 цилиндр -1.25"
 */

import Anthropic from '@anthropic-ai/sdk';

// ─── Константы ──────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты — эксперт по контактным линзам. Распарси запрос покупателя и извлеки параметры для поиска в базе данных.

Если запрос НЕ связан с поиском контактных линз (вопрос о погоде, приветствие, посторонняя тема) — верни {"off_topic": true} и ничего больше.

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

// ─── Клиенты провайдеров ──────────────────────────────────────────────────────

const HYDRA_BASE_URL = 'https://api.hydraai.ru/v1';
const HYDRA_MODEL    = 'claude-sonnet-4';

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropicClient;
}

// ─── Follow-up prompt (с контекстом переписки) ───────────────────────────────

const FOLLOWUP_SYSTEM = `Ты — ассистент менеджера магазина контактных линз.
Менеджер изучает результаты поиска и задаёт уточняющий вопрос боту.
Тебе дана история переписки и новый вопрос менеджера.

Если вопрос НЕ связан с поиском линз (посторонняя тема, вопрос не по адресу) — верни {"off_topic": true} и ничего больше.

Верни ТОЛЬКО JSON с параметрами поиска. Сохраняй параметры из предыдущего поиска если менеджер их не меняет явно.
Поля (все опциональны):
- model_hint, brand_hint, lens_type (sphere|toric|multifocal|colored)
- power (+X.XX / -X.XX), cylinder (-X.XX), axis (0-180)
- add (low|mid|high или +X.XX), color, bc, dia
- replacement (daily|biweekly|monthly|quarterly)`;

async function callAI(systemPrompt, messages) {
  // Переключатель: PARSER_PROVIDER=hydra (по умолчанию) или anthropic
  const useHydra = (process.env.PARSER_PROVIDER || 'hydra') !== 'anthropic';

  try {
    if (useHydra) {
      const res = await fetch(`${HYDRA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.HYDRA_API_KEY}` },
        body: JSON.stringify({ model: HYDRA_MODEL, max_tokens: 256, temperature: 0,
          messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HydraAI ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return extractJSON(data.choices[0].message.content);
    } else {
      const msg = await getAnthropicClient().messages.create({
        model: ANTHROPIC_MODEL, max_tokens: 256, system: systemPrompt, messages,
      });
      return extractJSON(msg.content[0].text);
    }
  } catch (err) {
    console.error(`[parser] AI call failed: ${err.message}`);
    return {};
  }
}

// ─── Публичный API ───────────────────────────────────────────────────────────

export async function parseQuery(text) {
  const key = text.trim().toLowerCase();

  const cached = cacheGet(key);
  if (cached) return cached;

  const parsed = await callAI(SYSTEM_PROMPT, [{ role: 'user', content: text }]);
  cacheSet(key, parsed);
  return parsed;
}

/**
 * Парсит уточняющий вопрос менеджера с учётом контекста переписки.
 * @param {Array<{role:'user'|'assistant', content:string}>} history — история чата
 * @param {string} followUpText — новый вопрос менеджера
 * @returns {Promise<object>} — параметры поиска
 */
export async function parseFollowUp(history, followUpText) {
  const messages = [...history, { role: 'user', content: followUpText }];
  return callAI(FOLLOWUP_SYSTEM, messages);
}
