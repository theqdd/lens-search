#!/usr/bin/env python3
"""
Импортирует артикулы Wildberries из product_info.php в коллекцию lensdb.wb_skus.

Структура wb_skus:
  { barcode, seller, wb_article, product_id, product_name }

Продавцы: ip, ooo, viplinza
"""
import urllib.request, urllib.parse, json, hashlib, time, os
from datetime import date
from pathlib import Path
from pymongo import MongoClient, UpdateOne

# Читаем .env из lens-search
_env_path = Path(__file__).parent / 'lens-search' / '.env'
for _line in _env_path.read_text().splitlines():
    if '=' in _line and not _line.startswith('#'):
        _k, _, _v = _line.partition('=')
        os.environ.setdefault(_k.strip(), _v.strip())

SIGN_SECRET = os.environ["VIPLINZA_SIGN_SECRET"]
BASE_URL    = "https://viplinza.ru/export/product_info.php"
MONGO_URI   = os.environ["MONGO_URI"]
SELLERS     = ["ip", "ooo", "viplinza"]

def make_sign():
    today = date.today().strftime("%Y-%m-%d")
    return hashlib.md5((today + SIGN_SECRET).encode()).hexdigest()

def fetch_page(page, retries=3):
    sign = make_sign()
    url  = f"{BASE_URL}?sign={sign}&p={page}"
    req  = urllib.request.Request(url)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            print(f"  [warn] p={page} attempt {attempt+1}: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed page {page}")

def main():
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    col    = client["lensdb"]["wb_skus"]

    # Индексы
    col.create_index([("barcode", 1), ("seller", 1)], name="idx_barcode_seller")
    col.create_index([("wb_article", 1)],              name="idx_wb_article", unique=True, sparse=True)
    col.create_index([("seller", 1)],                  name="idx_seller")

    page = 1
    total_upserted = 0

    while True:
        data = fetch_page(page)
        if not data:
            break

        ops = []
        for item in data:
            barcode = item.get("barcode", "")
            if not barcode:
                continue
            for seller in SELLERS:
                articles = item.get("article_wb", {}).get(seller, [])
                for wb_article in articles:
                    if not wb_article:
                        continue
                    doc = {
                        "barcode":      barcode,
                        "seller":       seller,
                        "wb_article":   str(wb_article),
                        "product_id":   item.get("product_id"),
                        "product_name": item.get("name", ""),
                    }
                    ops.append(UpdateOne(
                        {"wb_article": str(wb_article)},
                        {"$set": doc},
                        upsert=True
                    ))

        if ops:
            result = col.bulk_write(ops, ordered=False)
            total_upserted += result.upserted_count + result.modified_count

        print(f"  p={page} | товаров: {len(data)} | всего в wb_skus: {total_upserted}", flush=True)

        if len(data) < 5000:
            break
        page += 1

    print(f"\nГотово! Всего записей в wb_skus: {col.count_documents({})}")
    print("По продавцам:")
    for s in SELLERS:
        print(f"  {s}: {col.count_documents({'seller': s})}")
    client.close()

if __name__ == "__main__":
    main()
