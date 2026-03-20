/**
 * Нормализует поле ltype_norm для всех документов в products.
 * Пересоздаёт text index как compound с ltype_norm-префиксом:
 *   { ltype_norm: 1, name: 'text', model: 'text', brand: 'text' }
 *
 * Это позволяет MongoDB сканировать только документы нужного типа при
 * text-поиске (например, multifocal ~1K вместо всех 90K).
 *
 * Безопасно перезапускать (idempotent). Запускается после import_products.py.
 * Запуск: node scripts/normalize-ltype.js
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
const BATCH_SIZE = 500;

function normalizeLtype(doc) {
  const t   = (doc.type || '').toLowerCase();
  const cat = (doc.category_name || '').toLowerCase();
  const pt  = ((doc.params && doc.params['Тип линз']) || '').toLowerCase();
  const color = doc.params && doc.params['Цвет'];
  const hasRealColor = color && !['', '00', '0001', '0002', null].includes(String(color));
  const all = [t, cat, pt];

  if (all.some(s => s.includes('мультифокал'))) return 'multifocal';
  if (all.some(s => s.includes('астигмат')))    return 'toric';
  if (hasRealColor || all.some(s => s.includes('цветн') || s.includes('color'))) return 'colored';
  if (all.some(s => ['сфери', 'прозрачн', 'монофокал', 'стигматиче', 'бифокал', 'офисн'].some(k => s.includes(k)))) return 'sphere';
  return 'other'; // diagnostics, glasses parts, solutions, etc.
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const col = client.db('lensdb').collection('products');

  // 1. Обновляем ltype_norm для всех документов
  console.log('Setting ltype_norm...');
  const cursor = col.find({}, { projection: { type: 1, category_name: 1, 'params.Тип линз': 1, 'params.Цвет': 1 } });

  let batch = [];
  let updated = 0;

  for await (const doc of cursor) {
    const ltype = normalizeLtype(doc);
    batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { ltype_norm: ltype } } } });
    if (batch.length >= BATCH_SIZE) {
      await col.bulkWrite(batch, { ordered: false });
      updated += batch.length;
      process.stdout.write(`\r  ${updated} updated...`);
      batch = [];
    }
  }
  if (batch.length) {
    await col.bulkWrite(batch, { ordered: false });
    updated += batch.length;
  }
  console.log(`\nltype_norm set on ${updated} documents`);

  // 2. Пересоздаём text index как compound с ltype_norm-префиксом
  console.log('Recreating text index as compound (ltype_norm + text)...');
  try {
    await col.dropIndex('text_search');
    console.log('  Old index dropped.');
  } catch {
    console.log('  Old index not found, skipping drop.');
  }

  await col.createIndex(
    { ltype_norm: 1, name: 'text', model: 'text', brand: 'text' },
    {
      name: 'text_search',
      weights: { brand: 5, model: 10, name: 3 },
      default_language: 'none',
    },
  );
  console.log('  Compound text index created.');

  // 3. Индекс на ltype_norm для фильтрации без text-поиска
  await col.createIndex({ ltype_norm: 1 }, { name: 'idx_ltype_norm' });
  console.log('  idx_ltype_norm created.');

  // Итоговая сводка по типам
  const dist = await col.aggregate([
    { $group: { _id: '$ltype_norm', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();
  console.log('\nDistribution:');
  dist.forEach(d => console.log(`  ${d._id}: ${d.count}`));

  await client.close();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
