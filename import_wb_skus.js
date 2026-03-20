/**
 * Импортирует WB артикулы из viplinza product_info.php
 * и добавляет поле `wb` к документам в коллекции products.
 *
 * Запуск: node import_wb_skus.js
 */

import 'dotenv/config';
import { createHash } from 'crypto';
import { connectDB, mongoose } from './src/db.js';

const SECRET   = process.env.VIPLINZA_SIGN_SECRET;
const BASE_URL = 'https://viplinza.ru/export/product_info.php';

function makeSign() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return createHash('md5').update(date + SECRET).digest('hex');
}

async function fetchPage(sign, page, retries = 3) {
  const url = `${BASE_URL}?sign=${sign}&p=${page}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'lens-search/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt < retries - 1) {
        console.warn(`  [warn] page ${page} attempt ${attempt + 1} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  await connectDB(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const col  = mongoose.connection.collection('products');
  const sign = makeSign();

  let page    = 1;
  let total   = 0;
  let updated = 0;

  while (true) {
    process.stdout.write(`Fetching page ${page}... `);
    const data = await fetchPage(sign, page);

    if (!Array.isArray(data) || data.length === 0) {
      console.log('empty — done.');
      break;
    }

    total += data.length;

    // Оставляем только записи с хотя бы одним WB артикулом
    const withWb = data.filter(p => {
      const wb = p.article_wb;
      return wb && (wb.ip?.length || wb.ooo?.length || wb.viplinza?.length);
    });

    if (withWb.length > 0) {
      const ops = withWb.map(p => ({
        updateMany: {
          filter: { barcode: String(p.barcode) },
          update: {
            $set: {
              wb: {
                ip:       p.article_wb.ip       ?? [],
                ooo:      p.article_wb.ooo      ?? [],
                viplinza: p.article_wb.viplinza ?? [],
              },
            },
          },
        },
      }));

      const result = await col.bulkWrite(ops, { ordered: false });
      updated += result.modifiedCount;
      console.log(`${data.length} items, ${withWb.length} with WB → ${result.modifiedCount} updated`);
    } else {
      console.log(`${data.length} items, 0 with WB`);
    }

    page++;
  }

  console.log(`\nDone! Fetched: ${total}, products updated: ${updated}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
