import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { connectDB } from './db.js';
import { parseQuery } from './parser.js';
import { searchProducts } from './search.js';

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
  // Healthcheck без токена
  if (req.url === '/health') return;

  if (!API_SECRET) return; // токен не настроен — пропускаем

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
