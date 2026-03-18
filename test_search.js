#!/usr/bin/env node
import 'dotenv/config';
import { connectDB, mongoose } from './src/db.js';
import { parseQuery } from './src/parser.js';
import { searchProducts } from './src/search.js';

// Коллекция wb_skus для джойна по barcode
const WbSku = mongoose.model('WbSku', new mongoose.Schema({}, { strict: false, collection: 'wb_skus' }));

async function findWbArticles(barcodes) {
  const rows = await WbSku.find({ barcode: { $in: barcodes } }, { barcode:1, seller:1, wb_article:1, _id:0 }).lean();
  // Группируем по barcode → { seller: [articles] }
  const map = {};
  for (const r of rows) {
    if (!map[r.barcode]) map[r.barcode] = {};
    if (!map[r.barcode][r.seller]) map[r.barcode][r.seller] = [];
    map[r.barcode][r.seller].push(r.wb_article);
  }
  return map;
}

const QUERIES = [
  'Помогите найти линзы оазис мультифокальные на -2.5 HIGH',
  'нужны однодневные линзы acuvue для астигматизма -3 цилиндр -1.25 ось 180',
  'биофинити торик -4.75 цилиндр -2.25 ось 10',
  'Air Optix ночные силиконовые +1.5 ежемесячные',
  'dailies total 1 однодневки -6.0',
  'цветные линзы карие ежемесячные freshlook',
];

async function run() {
  await connectDB(process.env.MONGO_URI);

  for (const query of QUERIES) {
    const t0 = performance.now();

    const parsed   = await parseQuery(query);
    const products = await searchProducts(parsed, 5);
    const barcodes = products.map(p => p.barcode).filter(Boolean);
    const wbMap    = await findWbArticles(barcodes);

    const ms = (performance.now() - t0).toFixed(0);

    console.log('\n' + '═'.repeat(70));
    console.log(`❓ ${query}`);
    console.log(`🔍 Распознано: ${Object.entries(parsed).map(([k,v])=>`${k}=${v}`).join(' | ')}`);
    console.log(`⏱  ${ms} мс | найдено: ${products.length} товаров`);
    console.log('─'.repeat(70));

    if (products.length === 0) {
      console.log('   — ничего не найдено');
      continue;
    }

    for (const p of products) {
      const wb = wbMap[p.barcode] || {};
      const wbStr = Object.entries(wb)
        .map(([seller, arts]) => `${seller}: ${arts.join(', ')}`)
        .join(' | ');
      const power  = p.params?.['Оптическая сила'] ?? '';
      const add    = p.params?.['Аддидация линзы'] ?? '';
      const cyl    = p.params?.['Оптическая сила цилиндра'] ?? '';
      const axis   = p.params?.['Ось линзы'] ?? '';
      const extra  = [power, cyl && `цил ${cyl}`, axis && `ось ${axis}`, add].filter(Boolean).join(' ');

      console.log(`   📦 ${p.name}`);
      console.log(`      Штрихкод: ${p.barcode ?? '—'}  ${extra ? '| ' + extra : ''}`);
      console.log(`      WB артикулы: ${wbStr || '— нет в wb_skus'}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
