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

Если запрос НЕ связан с поиском контактных линз — верни {"off_topic": true} и ничего больше.

Верни ТОЛЬКО JSON без пояснений. Все поля опциональны:
- model_hint: ключевые слова модели (латиница, строчные, без бренда и цифровых параметров)
- brand_hint: бренд строчными
- lens_type: sphere | toric | multifocal | colored
- power: оптическая сила "+X.XX" или "-X.XX"
- cylinder: цилиндр "-X.XX" или "+X.XX"
- axis: ось 0–180 (целое число)
- add: аддидация "low" | "mid" | "high" или "+X.XX"
- color: цвет линзы (строка)
- bc: базовая кривизна (8.6)
- dia: диаметр (14.2)
- replacement: daily | biweekly | monthly | quarterly

ПРАВИЛА:
- power ВСЕГДА со знаком и 2 знаками: "3" → "+3.00", "минус 2.5" → "-2.50", "плюс 1" → "+1.00"
- Если сила не упомянута явно — НЕ добавляй power
- Если есть цилиндр или ось → lens_type: "toric" (даже если не сказано "астигматизм")
- Если есть аддидация → lens_type: "multifocal"
- model_hint: только модель, бренд всегда в brand_hint

СИНОНИМЫ БРЕНДОВ:
- acuvue: акувью, акювью, acquvue, johnson, джонсон, j&j
- alcon: алкон, алькон
- coopervision: купервижн, купер вижн, купер, coopervision
- bausch lomb: баш и ломб, б+л, б&л, bausch, lomb, бауш, баш ломб, bl
- interojo: интерожо
- hema: хема
- seed: сид
- ocu soft: окусофт

СИНОНИМЫ МОДЕЛЕЙ (→ латиница для model_hint):
- оазис, oazis → oasys
- тотал, тотал30 → total30
- эйр оптикс, airoptix → air optix
- биофинити, biofinity → biofinity
- дейли, дайли → dailies
- май дей, майдей → myday
- фрешлук, фреш лук → freshlook
- пюр вижн, пюревижн → purevision
- кларити, клэрити → clariti
- ультра (bausch) → ultra
- биотру, биотrue → biotrue
- софлинз → soflens
- 1 дей мойст, 1-дей → 1-day acuvue moist
- дефайн → acuvue define
- оазис однодневные → oasys 1-day
- дейли аквакомфорт → dailies aquacomfort
- прокlear → proclear
- аир оптикс аква → air optix aqua

ПЕРИОД ЗАМЕНЫ:
- однодневные, 1 день, 1-day, daily → daily
- двухнедельные, 2 недели, biweekly → biweekly
- месячные, на месяц, monthly, 30 дней → monthly
- квартальные, на 3 месяца, quarterly → quarterly

АДДИДАЦИЯ:
- низкая/слабая/low, +0.75–+1.25 → "low"
- средняя/medium/mid, +1.50–+1.75 → "mid"
- высокая/strong/high, +2.00+ → "high"
- числовая ("+2.00 D", "аддидация 2.5") → соответствующий уровень или само значение "+2.00"

ПРИМЕРЫ СЛОЖНЫХ ЗАПРОСОВ:
"оазис мультифокальные на -3 средняя аддидация" → {"brand_hint":"acuvue","model_hint":"oasys multifocal","lens_type":"multifocal","power":"-3.00","add":"mid"}
"линзы для астигматизма ось 180 цилиндр 1.25 сила минус 2" → {"lens_type":"toric","axis":180,"cylinder":"-1.25","power":"-2.00"}
"алкон дейли аквакомфорт плюс плюс 1" → {"brand_hint":"alcon","model_hint":"dailies aquacomfort plus","power":"+1.00","replacement":"daily"}
"биофинити торик -4.5 цилиндр -0.75 ось 10" → {"brand_hint":"coopervision","model_hint":"biofinity toric","lens_type":"toric","power":"-4.50","cylinder":"-0.75","axis":10}
"фрешлук карие двухнедельные" → {"brand_hint":"coopervision","model_hint":"freshlook","lens_type":"colored","color":"карие","replacement":"biweekly"}
"б+л ультра -3" → {"brand_hint":"bausch lomb","model_hint":"ultra","power":"-3.00"}
"купер кларити торик -1.75 ц -0.75 о 090" → {"brand_hint":"coopervision","model_hint":"clariti toric","lens_type":"toric","power":"-1.75","cylinder":"-0.75","axis":90}
"линзы на плюс 2 для пресбиопии высокая аддидация" → {"lens_type":"multifocal","power":"+2.00","add":"high"}
"зеленые однодневные цветные" → {"lens_type":"colored","color":"зеленые","replacement":"daily"}`;


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
Менеджер смотрит результаты поиска и уточняет или меняет запрос.
Тебе дана история переписки и новый вопрос менеджера.

Если вопрос НЕ связан с поиском линз — верни {"off_topic": true} и ничего больше.

Верни ТОЛЬКО JSON с параметрами поиска. Сохраняй параметры предыдущего поиска если менеджер их явно не меняет.
Поля (все опциональны): model_hint, brand_hint, lens_type (sphere|toric|multifocal|colored),
power (+X.XX/-X.XX), cylinder, axis (0-180), add (low|mid|high|+X.XX), color, bc, dia, replacement (daily|biweekly|monthly|quarterly).

Синонимы брендов: акувью→acuvue, алкон→alcon, купервижн→coopervision, баш ломб/б+л→bausch lomb.
Синонимы моделей: оазис→oasys, биофинити→biofinity, дейли→dailies, фрешлук→freshlook, кларити→clariti, ультра→ultra, май дей→myday.
power ВСЕГДА со знаком и 2 знаками после запятой. Если есть цилиндр/ось → lens_type:"toric". Если аддидация → lens_type:"multifocal".`;

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
