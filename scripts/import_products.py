#!/usr/bin/env python3
"""
Загружает товары из внешнего API и импортирует в MongoDB lensdb.products.
Использует bulk upsert по _id — безопасно перезапускать.
"""

import urllib.request
import urllib.error
import json
import time
import sys
import os
from pathlib import Path
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError

# Читаем .env из lens-search
_env_path = Path(__file__).parent / 'lens-search' / '.env'
for _line in _env_path.read_text().splitlines():
    if '=' in _line and not _line.startswith('#'):
        _k, _, _v = _line.partition('=')
        os.environ.setdefault(_k.strip(), _v.strip())

API_URL   = "http://84.38.180.73/api/v1/products"
API_TOKEN = os.environ["PRODUCTS_API_TOKEN"]
MONGO_URI = os.environ["MONGO_URI"]

# Только эти типы загружаем. Всё остальное (оправы, диагностика, клёпки и т.д.) — пропускаем.
ALLOWED_TYPES = {
    "Астигматические", "Астигматическая",
    "Мультифокальные",
    "Цветные",
    "Сферические", "Прозрачные", "Монофокальная", "Стигматическая",
    "Бифокальная", "Офисная",
    "Растворы", "Капли",
}

def fetch_page(page, retries=3):
    url = f"{API_URL}?p={page}"
    req = urllib.request.Request(url, headers={"Dildo-token": API_TOKEN})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            print(f"  [warn] page {page} attempt {attempt+1} failed: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch page {page} after {retries} retries")

def main():
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    col = client["lensdb"]["products"]

    # Узнаём общее число страниц
    first = fetch_page(1)
    total_pages = first["pageCount"]
    total_products = first["total"]
    print(f"Total: {total_products} products, {total_pages} pages")

    imported = 0
    start_page = 1

    # Если передан аргумент — продолжаем с нужной страницы
    if len(sys.argv) > 1:
        start_page = int(sys.argv[1])
        print(f"Resuming from page {start_page}")

    for page in range(start_page, total_pages + 1):
        data = fetch_page(page)
        products = data.get("products", [])
        if not products:
            break

        products = [p for p in products if p.get("type") in ALLOWED_TYPES]
        if not products:
            continue

        ops = [
            UpdateOne(
                {"_id": p["_id"]},
                {"$set": p},
                upsert=True
            )
            for p in products
        ]

        try:
            result = col.bulk_write(ops, ordered=False)
            imported += result.upserted_count + result.modified_count
        except BulkWriteError as e:
            print(f"  [warn] page {page} bulk write errors: {e.details['nErrors']}")
            imported += len(products) - e.details['nErrors']

        print(f"  page {page}/{total_pages} — {imported} upserted so far", flush=True)

    print(f"\nDone! Total upserted/updated: {imported}")
    client.close()

if __name__ == "__main__":
    main()
