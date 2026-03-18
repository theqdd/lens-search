import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { connectDB } from './db.js';
import { parseQuery } from './parser.js';
import { searchProducts } from './search.js';
import { postComment, verifyWebhookSignature, getFieldValue } from './pyrus.js';

// Форматирует распознанные параметры в читаемую строку на русском
function formatParsedReadable(p) {
  const parts = [];
  const TYPE_RU = { multifocal: 'Мультифокальные', toric: 'Астигматические', colored: 'Цветные', sphere: 'Сферические', spherical: 'Сферические' };
  const ADD_RU  = { low: 'Слабая', mid: 'Средняя', medium: 'Средняя', high: 'Высокая' };
  const REPL_RU = { daily: 'Однодневные', biweekly: 'Двухнедельные', monthly: 'На 1 месяц', quarterly: 'На 3 месяца' };

  if (p.brand_hint)   parts.push(`Бренд: ${p.brand_hint}`);
  if (p.model_hint)   parts.push(`Модель: ${p.model_hint}`);
  if (p.lens_type)    parts.push(`Тип: ${TYPE_RU[p.lens_type] ?? p.lens_type}`);
  if (p.power != null)    parts.push(`Оптическая сила: ${p.power}`);
  if (p.cylinder != null) parts.push(`Цилиндр: ${p.cylinder}`);
  if (p.axis != null)     parts.push(`Ось: ${p.axis}°`);
  if (p.add != null)      parts.push(`Аддидация: ${ADD_RU[String(p.add).toLowerCase()] ?? p.add}`);
  if (p.bc != null)       parts.push(`Радиус кривизны: ${p.bc}`);
  if (p.dia != null)      parts.push(`Диаметр: ${p.dia}`);
  if (p.replacement)      parts.push(`Срок замены: ${REPL_RU[p.replacement] ?? p.replacement}`);
  if (p.color)            parts.push(`Цвет: ${p.color}`);
  return parts.join(' | ');
}

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
  },
  trustProxy: true, // Caddy стоит перед нами
});

// Raw body — нужен для верификации подписи вебхука Pyrus
await app.register(rawBody, { global: false, encoding: 'utf8' });

// Rate limiting: 60 запросов в минуту с одного IP
await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    error: 'Too Many Requests',
    message: 'Слишком много запросов. Попробуйте через минуту.',
  }),
});

// Проверка Bearer токена
const API_SECRET = process.env.API_SECRET;

app.addHook('onRequest', async (req, reply) => {
  // Публичные эндпоинты без Bearer токена
  if (req.url === '/health' || req.url === '/webhook/pyrus') return;

  if (!API_SECRET) return;

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_SECRET) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// Healthcheck
app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
}));

// Основной поиск
app.post('/search', {
  schema: {
    body: {
      type: 'object',
      required: ['query'],
      properties: {
        query:  { type: 'string', minLength: 3, maxLength: 500 },
        limit:  { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
}, async (req, reply) => {
  const { query, limit = 20 } = req.body;

  // Парсим запрос через Claude
  const parsed = await parseQuery(query);

  if (!parsed || Object.keys(parsed).length === 0) {
    return reply.code(422).send({
      error: 'Не удалось распознать параметры запроса',
      query,
    });
  }

  const products = await searchProducts(parsed, limit);

  return {
    query,
    query_readable: formatParsedReadable(parsed),
    parsed,
    count: products.length,
    products,
  };
});

// ─── Pyrus webhook ───────────────────────────────────────────────────────────
// Pyrus отправляет POST когда создаётся/обновляется задача формы.
// Мы фильтруем по form_id, берём поля 5 и 7, прогоняем через поиск
// и возвращаем результат комментарием в задачу.

const PYRUS_FORM_ID     = parseInt(process.env.PYRUS_FORM_ID     || '0');
const PYRUS_FIELD_Q     = parseInt(process.env.PYRUS_FIELD_QUESTION || '5');
const PYRUS_FIELD_MODEL = parseInt(process.env.PYRUS_FIELD_MODEL  || '7');

// Дедупликация: не обрабатываем одну задачу дважды за 60 сек
const recentTasks = new Map();

app.post('/webhook/pyrus', {
  config: { rawBody: true }, // нужен для проверки подписи
}, async (req, reply) => {
  // 1. Проверяем подпись
  const sig = req.headers['x-pyrus-sig'];
  const rawBody = req.rawBody ?? JSON.stringify(req.body);
  if (sig && !verifyWebhookSignature(rawBody, sig)) {
    return reply.code(403).send({ error: 'Invalid signature' });
  }

  const payload = req.body;
  const task = payload?.task;

  // 2. Проверяем что задача из нужной формы
  if (!task || task.form_id !== PYRUS_FORM_ID) {
    return reply.send({ ok: true }); // не наша форма — молча игнорируем
  }

  const taskId = task.id;

  // 3. Дедупликация
  if (recentTasks.has(taskId)) {
    return reply.send({ ok: true, skipped: 'duplicate' });
  }
  recentTasks.set(taskId, Date.now());
  setTimeout(() => recentTasks.delete(taskId), 60_000);

  // 4. Извлекаем текст вопроса и модели из полей формы
  const fields       = task.fields ?? [];
  const questionText = getFieldValue(fields, PYRUS_FIELD_Q);
  const modelText    = getFieldValue(fields, PYRUS_FIELD_MODEL);

  if (!questionText && !modelText) {
    return reply.send({ ok: true, skipped: 'no query fields' });
  }

  // Объединяем оба поля в один поисковый запрос
  const searchQuery = [questionText, modelText].filter(Boolean).join(' ');

  // 5. Асинхронно — отвечаем Pyrus сразу (он ждёт ответ не более 10с),
  //    а поиск и комментарий выполняем в фоне
  reply.send({ ok: true });

  // 6. Поиск + комментарий в фоне
  setImmediate(async () => {
    try {
      const parsed   = await parseQuery(searchQuery);
      const products = await searchProducts(parsed, 10);

      let comment;
      if (!parsed || Object.keys(parsed).length === 0 || products.length === 0) {
        comment = `🔍 По запросу "${searchQuery}" подходящих линз не найдено.`;
      } else {
        const readable = formatParsedReadable(parsed);
        const lines = products.map((p, i) => {
          const power = p.params?.['Оптическая сила'] ?? '';
          const add   = p.params?.['Аддидация линзы'] ?? '';
          const extra = [power, add].filter(Boolean).join(', ');
          return `${i + 1}. ${p.name}  |  Штрихкод: ${p.barcode ?? '—'}${extra ? '  |  ' + extra : ''}`;
        }).join('\n');
        comment = `🔍 Распознано: ${readable}\n\nНайдено товаров: ${products.length}\n\n${lines}`;
      }

      await postComment(taskId, comment);
    } catch (err) {
      console.error(`[pyrus] task ${taskId} failed:`, err.message);
    }
  });
});

// Запуск
async function start() {
  try {
    await connectDB(process.env.MONGO_URI);
    app.log.info('MongoDB connected');

    await app.listen({
      port: parseInt(process.env.PORT || '3000'),
      host: process.env.HOST || '127.0.0.1',
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
