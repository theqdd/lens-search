import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { connectDB, mongoose } from './db.js';
import { parseFollowUp } from './parser.js';
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

  const { parseQuery } = await import('./parser.js');
  const parsed = await parseQuery(query);

  if (parsed?.off_topic) {
    return reply.code(422).send({
      error: 'Запрос не относится к поиску контактных линз',
      query,
    });
  }

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

const PYRUS_FORM_ID      = parseInt(process.env.PYRUS_FORM_ID     || '0');
const PYRUS_FIELD_SELLER = parseInt(process.env.PYRUS_FIELD_SELLER || '8');

const AI_COST_PER_REQUEST = 0.07;
const BOT_EMAIL = process.env.PYRUS_LOGIN;

function webhookLogCol() {
  return mongoose.connection.collection('webhook_log');
}

// Строит HTML-комментарий с результатами поиска
function buildResultComment(allProducts, mainIds, wbMap, seller, readable, withArts, withoutArts, tAiMs, tDbMs, tTotal) {
  const SEP          = '<br>─────────────────────────<br>';
  const sellerLabel  = seller ? seller.toUpperCase() : 'все';
  const lines        = [];
  let artCount       = 0;

  for (const p of [...allProducts.filter(p => wbMap[p.barcode]?.length), ...allProducts.filter(p => !wbMap[p.barcode]?.length)]) {
    if (artCount >= 10) break;
    const isMain = mainIds.has(p._id);
    const repl   = p.params?.['Срок замены'] ?? '';
    const arts   = wbMap[p.barcode] ?? [];
    const bc     = p.barcode ?? '—';

    const wbLink = arts.length
      ? arts.map(a => `<a href='https://www.wildberries.ru/catalog/${a}/detail.aspx?targetUrl=MI'>${a}</a>`).join(', ')
      : `нет у ${sellerLabel}`;
    const bcLink = bc !== '—'
      ? `<a href='https://viplinza.ru/crm2/productwait.php?barcode=${bc}'>${bc}</a>`
      : bc;

    const n        = lines.length + 1;
    const nameLine = isMain
      ? `<b>${n}. ${p.name}</b>`
      : `${n}. <i>[аналог] ${p.name}</i>`;

    lines.push(`${nameLine}<br>${repl}  ${bcLink} | ${wbLink}`);
    artCount += arts.length || 1;
  }

  if (!lines.length) return null;

  const footer = `${sellerLabel} • найдено: ${withArts.length + withoutArts.length} (${withArts.length} с арт.) • AI ~${AI_COST_PER_REQUEST.toFixed(2)}₽ ${tAiMs}мс • DB ${tDbMs}мс • ${tTotal}мс`;
  return SEP + lines.join(SEP) + `<br>${footer}`;
}

// Извлекает историю переписки для контекста follow-up
function buildChatHistory(comments) {
  const history = [];
  for (const c of comments) {
    const isBot = c.author?.type === 'bot' || c.author?.email === BOT_EMAIL;
    const raw   = (c.text || '').replace(/<[^>]+>/g, '').trim();
    if (!raw) continue;
    history.push({ role: isBot ? 'assistant' : 'user', content: raw.slice(0, 400) });
  }
  return history;
}

// Основной поиск + аналоги + wb_skus lookup
async function runSearch(parsed, seller) {
  const extParsed = { ...parsed };
  delete extParsed.brand_hint;
  delete extParsed.model_hint;
  const hasExt = parsed.lens_type && (parsed.power != null || parsed.add != null);

  const tDb0 = Date.now();
  const [mainProducts, extRaw] = await Promise.all([
    searchProducts(parsed, 20),
    hasExt ? searchProducts(extParsed, 20) : Promise.resolve([]),
  ]);

  const mainIds = new Set(mainProducts.map(p => p._id));
  const seen    = new Set(mainProducts.map(p => p.barcode).filter(Boolean));
  const allProducts = [...mainProducts];
  for (const p of extRaw) {
    if (p.barcode && !seen.has(p.barcode)) { seen.add(p.barcode); allProducts.push(p); }
  }

  const barcodes = allProducts.map(p => p.barcode).filter(Boolean);
  const wbQuery  = { barcode: { $in: barcodes } };
  if (seller) wbQuery.seller = seller;

  const wbSkus = barcodes.length
    ? await mongoose.connection.collection('wb_skus')
        .find(wbQuery, { projection: { barcode: 1, wb_article: 1, _id: 0 } })
        .toArray()
    : [];
  const tDbMs = Date.now() - tDb0;

  const wbMap = {};
  for (const s of wbSkus) { if (!wbMap[s.barcode]) wbMap[s.barcode] = []; wbMap[s.barcode].push(s.wb_article); }

  const withArts    = allProducts.filter(p => wbMap[p.barcode]?.length);
  const withoutArts = allProducts.filter(p => !wbMap[p.barcode]?.length);

  return { allProducts, mainIds, wbMap, withArts, withoutArts, tDbMs };
}

// ─── Обработка одного события вебхука ────────────────────────────────────────
// Принимает документ из webhook_log, выполняет поиск и отправляет комментарий.
// Вызывается как из вебхука напрямую, так и из retry-loop.

async function processWebhookEvent(doc) {
  const col = webhookLogCol();
  const { task_id: taskId, comment_id: commentId, task_snapshot: task, seller } = doc;

  // Помечаем как "в обработке" и инкрементируем счётчик попыток
  await col.updateOne(
    { _id: doc._id },
    { $set: { status: 'processing', updated_at: new Date() }, $inc: { attempts: 1 } },
  );

  const tStart = Date.now();
  try {
    const comments = task.comments ?? [];

    // Находим триггерный комментарий по ID
    const trigIdx = comments.findIndex(c => String(c.id) === commentId);
    const trigComment = trigIdx !== -1 ? comments[trigIdx] : null;

    if (!trigComment) {
      await col.updateOne({ _id: doc._id }, { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } });
      return;
    }

    // Убираем упоминание @Бот из текста
    const followUpMsg = (trigComment.text || '')
      .replace(/бот\s*/gi, '')
      .trim();

    if (!followUpMsg) {
      await col.updateOne({ _id: doc._id }, { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } });
      return;
    }

    // История — все комментарии до триггерного
    const history = buildChatHistory(comments.slice(0, trigIdx));

    const tAi0  = Date.now();
    const parsed = await parseFollowUp(history, followUpMsg);
    const tAiMs = Date.now() - tAi0;

    console.log(`[pyrus] task ${taskId}: "${followUpMsg}" → ${JSON.stringify(parsed)}`);

    if (parsed?.off_topic) {
      await postComment(taskId, 'Я бот поиска контактных линз. Напишите, какие линзы вы ищете — бренд, тип, оптическую силу и другие параметры.');
      await col.updateOne({ _id: doc._id }, { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } });
      return;
    }

    if (!parsed || !Object.keys(parsed).length) {
      await postComment(taskId, 'Не удалось распознать параметры запроса. Уточните, пожалуйста: какой бренд, тип линз и оптическую силу ищете?');
      await col.updateOne({ _id: doc._id }, { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } });
      return;
    }

    const { allProducts, mainIds, wbMap, withArts, withoutArts, tDbMs } =
      await runSearch(parsed, seller);

    if (!allProducts.length) {
      await postComment(taskId, 'По запросу подходящих линз не найдено.');
      await col.updateOne({ _id: doc._id }, { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } });
      return;
    }

    const tTotal  = Date.now() - tStart;
    const comment = buildResultComment(
      allProducts, mainIds, wbMap, seller,
      formatParsedReadable(parsed),
      withArts, withoutArts, tAiMs, tDbMs, tTotal,
    );
    if (comment) await postComment(taskId, comment, { html: true });

    await col.updateOne(
      { _id: doc._id },
      { $set: { status: 'done', processed_at: new Date(), updated_at: new Date() } },
    );

  } catch (err) {
    console.error(`[pyrus] task ${taskId}:${commentId} failed:`, err.message);
    await col.updateOne(
      { _id: doc._id },
      { $set: { status: 'failed', error: err.message, updated_at: new Date() } },
    );
  }
}

// ─── Retry-loop: повторяет необработанные события ─────────────────────────────
// Запускается каждые 2 минуты. Подхватывает события зависшие в pending
// (напр. сервер упал до обработки) или завершившиеся ошибкой (failed).

async function retryPendingEvents() {
  try {
    const col = webhookLogCol();
    // Берём события старше 90 секунд с менее чем 3 попытками
    const cutoff = new Date(Date.now() - 90_000);
    const docs = await col.find({
      status: { $in: ['pending', 'failed'] },
      attempts: { $lt: 3 },
      updated_at: { $lt: cutoff },
    }).limit(5).toArray();

    for (const doc of docs) {
      console.log(`[retry] task ${doc.task_id}:${doc.comment_id}, attempt ${(doc.attempts ?? 0) + 1}`);
      processWebhookEvent(doc).catch(err => {
        console.error(`[retry] task ${doc.task_id} error:`, err.message);
      });
    }
  } catch (err) {
    console.error('[retry loop] error:', err.message);
  }
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

const WEBHOOK_PROXY_SECRET = process.env.WEBHOOK_PROXY_SECRET;

app.post('/webhook/pyrus', {
  config: { rawBody: true },
}, async (req, reply) => {
  // 1. Проверяем секрет прокси-сервера
  if (WEBHOOK_PROXY_SECRET && req.headers['x-proxy-secret'] !== WEBHOOK_PROXY_SECRET) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  // 2. Проверяем подпись Pyrus
  const sig        = req.headers['x-pyrus-sig'];
  const rawBodyStr = req.rawBody ?? JSON.stringify(req.body);
  if (sig && !verifyWebhookSignature(rawBodyStr, sig)) {
    return reply.code(403).send({ error: 'Invalid signature' });
  }

  const task = req.body?.task;
  // Принимаем только задачи нашей формы
  if (!task || task.form_id !== PYRUS_FORM_ID) return reply.send({ ok: true });

  const taskId   = task.id;
  const comments = task.comments ?? [];
  const fields   = task.fields   ?? [];

  // 2. Последний комментарий — триггер события
  const lastComment   = comments[comments.length - 1];
  const isLastFromBot = lastComment?.author?.type === 'bot' ||
                        lastComment?.author?.email === BOT_EMAIL;

  if (isLastFromBot) return reply.send({ ok: true, skipped: 'bot_comment' });

  // 3. Реагируем только на явное упоминание @Бот
  const lastPlain = lastComment?.text || '';
  const lastFmt   = lastComment?.formatted_text || '';
  const isMention = /<span[^>]+data-type="user-mention"[^>]*>\s*Бот\s*<\/span>/i.test(lastFmt) ||
                    /[@@]бот\b/i.test(lastPlain) ||
                    lastComment?.added_subscribers?.some(
                      s => s.email === BOT_EMAIL || s.type === 'bot',
                    );

  if (!isMention) return reply.send({ ok: true, skipped: 'no_mention' });

  const commentId = String(lastComment?.id ?? 'init');
  const seller    = (getFieldValue(fields, PYRUS_FIELD_SELLER) || '').trim().toLowerCase();

  // 4. Дедупликация через MongoDB
  const col      = webhookLogCol();
  const existing = await col.findOne(
    { task_id: taskId, comment_id: commentId },
    { projection: { status: 1, attempts: 1 } },
  );

  // Пропускаем если уже обработано или в процессе
  if (existing?.status === 'done' || existing?.status === 'processing') {
    return reply.send({ ok: true, skipped: existing.status });
  }
  // Пропускаем если pending и уже была хотя бы одна попытка (retry loop подхватит)
  if (existing?.status === 'pending' && (existing.attempts ?? 0) > 0) {
    return reply.send({ ok: true, skipped: 'pending' });
  }
  // Пропускаем если исчерпали попытки
  if (existing?.status === 'failed' && (existing.attempts ?? 0) >= 3) {
    return reply.send({ ok: true, skipped: 'max_attempts' });
  }

  // 5. Сохраняем событие в MongoDB (upsert)
  const doc = await col.findOneAndUpdate(
    { task_id: taskId, comment_id: commentId },
    {
      $setOnInsert: { task_id: taskId, comment_id: commentId, created_at: new Date(), attempts: 0 },
      $set: {
        status: 'pending',
        form_id: task.form_id,
        seller,
        task_snapshot: task,
        updated_at: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // Отвечаем Pyrus немедленно, обрабатываем асинхронно
  reply.send({ ok: true });

  setImmediate(() => {
    processWebhookEvent(doc).catch(err => {
      console.error(`[pyrus] task ${taskId}:${commentId} error:`, err.message);
    });
  });
});

// Запуск
async function start() {
  try {
    await connectDB(process.env.MONGO_URI);
    app.log.info('MongoDB connected');

    // Индексы для webhook_log
    const col = webhookLogCol();
    await col.createIndex({ task_id: 1, comment_id: 1 }, { unique: true });
    await col.createIndex({ status: 1, updated_at: 1 });

    // Запускаем retry-loop: каждые 2 минуты проверяем необработанные события
    setInterval(retryPendingEvents, 2 * 60_000);

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
