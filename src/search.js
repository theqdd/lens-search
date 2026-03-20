/**
 * Поисковый движок по коллекции products.
 *
 * Структура params (объект с русскими ключами):
 *   Оптическая сила           → "+0.25", "-2.50" (строка)
 *   Оптическая сила цилиндра  → "-1.25", "+0.75" (строка, не всегда 2 знака после запятой)
 *   Ось линзы                 → "010", "100", "180" (строка, может быть с нулём)
 *   Аддидация линзы           → "low"/"high"/"medium",
 *                                "Слабая(Low)"/"Высокая(High)"/"Средняя(Medium)",
 *                                "+1.00 D"/"+2.50 N"
 *   Радиус кривизны           → "8.6", "8.5" (строка)
 *   Диаметр                   → 14.2 (число)
 *   Тип линз                  → "Мультифокальные"|"Астигматические"|"Прозрачные"|"Цветные"
 *   Срок замены               → "Однодневные"|"Двухнедельные"|"На 1 Месяц"|"На 3 Месяца"
 *   Цвет                      → строка или null
 */

import { Product } from './product.model.js';

// ─── Нормализация значений ────────────────────────────────────────────────────

/**
 * Оптическая сила/цилиндр: нормализует к "+X.XX" / "-X.XX".
 * "-2.5" → "-2.50", "2.5" → "+2.50", "+1" → "+1.00"
 * Возвращает массив вариантов (с нулём и без), т.к. в БД встречаются оба формата.
 */
function normalizePowerVariants(val) {
  const num = parseFloat(String(val).trim());
  if (isNaN(num)) return [String(val)];
  const sign = num >= 0 && !String(val).trim().startsWith('-') ? '+' : '';
  const full  = `${sign}${num.toFixed(2)}`;           // "+2.50"
  const short = `${sign}${parseFloat(num.toFixed(2))}`; // "+2.5" (убирает лишний ноль)
  return full === short ? [full] : [full, short];
}

/**
 * Ось линзы: "10" → ["10", "010"], "100" → ["100"]
 */
function normalizeAxisVariants(val) {
  const n = parseInt(String(val));
  if (isNaN(n)) return [String(val)];
  const s = String(n);
  const padded = s.padStart(3, '0');
  return s === padded ? [s] : [s, padded];
}

/**
 * Аддидация: возвращает условие $or по всем вариантам написания.
 * "low"  → low | Слабая(Low)
 * "mid"  → medium | Средняя(Medium)
 * "high" → high | Высокая(High)
 * "+2.00" → regex /^\+2\.00/i
 */
// Диапазоны аддидации по числовому значению (D = диоптрии):
//   Low:  +0.75 – +1.25
//   Mid:  +1.50 – +1.75
//   High: +2.00 – +2.50
function numericAddToCategory(num) {
  if (num <= 1.25) return 'low';
  if (num <= 1.75) return 'mid';
  return 'high';
}

function additionQuery(val) {
  const v = String(val).trim().toLowerCase();
  const NAMED = {
    low:    ['low', 'Слабая(Low)'],
    mid:    ['medium', 'Средняя(Medium)', 'mid'],
    medium: ['medium', 'Средняя(Medium)', 'mid'],
    high:   ['high', 'Высокая(High)'],
  };
  if (NAMED[v]) {
    return { 'params.Аддидация линзы': { $in: NAMED[v] } };
  }

  // Числовое значение: пробуем оба подхода — категорию И regex-префикс
  const num = parseFloat(v.replace(',', '.'));
  const orClauses = [];

  // 1. Маппинг на категорию (low/mid/high + русские варианты)
  if (!isNaN(num)) {
    const cat = numericAddToCategory(Math.abs(num));
    orClauses.push(...NAMED[cat].map(s => ({ 'params.Аддидация линзы': s })));
  }

  // 2. Regex-префикс для брендов с форматом "+2.50 D" / "+2.50 N"
  const variants = normalizePowerVariants(val);
  for (const s of variants) {
    const escaped = s.replace(/[+.]/g, c => c === '+' ? '\\+' : '\\.');
    orClauses.push({ 'params.Аддидация линзы': { $regex: new RegExp('^' + escaped, 'i') } });
  }

  return { $or: orClauses };
}

// Маппинг типов линз — проверяем три поля: type, category_name, params.Тип линз
// Поле `type` — самое надёжное, остальные используются как fallback из-за
// несогласованности исходных данных (напр. Oasys Multifocal имеет Тип линз="Прозрачные")
const TYPE_FILTER = {
  multifocal: { $or: [
    { type: 'Мультифокальные' },
    { category_name: 'Мультифокальные' },
    { 'params.Тип линз': 'Мультифокальные' },
  ]},
  toric: { $or: [
    { type: { $in: ['Астигматические', 'Астигматическая'] } },
    { category_name: { $in: ['Астигматические', 'Астигматическая'] } },
    { 'params.Тип линз': 'Астигматические' },
  ]},
  colored: { $or: [
    { type: 'Цветные' },
    { 'params.Тип линз': 'Цветные' },
    { 'params.Цвет': { $ne: null, $nin: ['', '00', '0001', '0002'] } },
  ]},
  sphere: { $or: [
    { type: { $in: ['Сферические', 'Прозрачные', 'Монофокальная', 'Стигматическая'] } },
    { 'params.Тип линз': 'Прозрачные' },
  ]},
  spherical: { $or: [
    { type: { $in: ['Сферические', 'Прозрачные', 'Монофокальная', 'Стигматическая'] } },
    { 'params.Тип линз': 'Прозрачные' },
  ]},
};

// Маппинг периодов замены
const REPLACEMENT_MAP = {
  daily:      'Однодневные',
  weekly:     'Недельные',
  biweekly:   'Двухнедельные',
  monthly:    'На 1 Месяц',
  quarterly:  'На 3 Месяца',
};

// ─── Построение MongoDB-запроса ───────────────────────────────────────────────

function buildQuery(p) {
  const $and = [];

  // Тип линзы — ищем по params.Тип линз ИЛИ category_name (данные непоследовательны)
  const typeFilter = p.lens_type ? TYPE_FILTER[p.lens_type.toLowerCase()] : null;
  if (typeFilter) {
    $and.push(typeFilter);
  }

  // Оптическая сила
  if (p.power != null) {
    const variants = normalizePowerVariants(p.power);
    $and.push({ 'params.Оптическая сила': variants.length === 1 ? variants[0] : { $in: variants } });
  }

  // Цилиндр (торические)
  if (p.cylinder != null) {
    const variants = normalizePowerVariants(p.cylinder);
    $and.push({ 'params.Оптическая сила цилиндра': variants.length === 1 ? variants[0] : { $in: variants } });
  }

  // Ось
  if (p.axis != null) {
    const variants = normalizeAxisVariants(p.axis);
    $and.push({ 'params.Ось линзы': variants.length === 1 ? variants[0] : { $in: variants } });
  }

  // Аддидация (мультифокальные)
  if (p.add != null) {
    $and.push(additionQuery(p.add));
  }

  // Радиус кривизны
  if (p.bc != null) {
    $and.push({ 'params.Радиус кривизны': String(p.bc) });
  }

  // Диаметр
  if (p.dia != null) {
    $and.push({ 'params.Диаметр': Number(p.dia) });
  }

  // Срок замены
  if (p.replacement) {
    const mapped = REPLACEMENT_MAP[p.replacement.toLowerCase()];
    if (mapped) $and.push({ 'params.Срок замены': mapped });
  }

  // Цвет — нормализуем русское прилагательное к основе:
  // "карие" → "кари", "голубые" → "голуб", "зеленые" → "зелен"
  if (p.color) {
    const colorStem = p.color
      .replace(/[иы]е$/, '')  // карие → кари, голубые → голуб
      .replace(/ой$/, '')     // голубой → голуб
      .replace(/ий$/, '');    // карий → кари
    const colorRegex = colorStem.length >= 3 ? colorStem : p.color;
    $and.push({ 'params.Цвет': { $regex: colorRegex, $options: 'i' } });
  }

  // Название модели / бренд — text search
  if (p.model_hint || p.brand_hint) {
    const terms = [p.model_hint, p.brand_hint].filter(Boolean).join(' ');
    $and.push({ $text: { $search: terms } });
  }

  return $and.length > 0 ? { $and } : null;
}

// ─── Публичная функция поиска ─────────────────────────────────────────────────

const PROJECTION = {
  _id: 1, name: 1, model: 1, brand: 1, barcode: 1, wb: 1,
  'params.Оптическая сила': 1,
  'params.Оптическая сила цилиндра': 1,
  'params.Ось линзы': 1,
  'params.Аддидация линзы': 1,
  'params.Тип линз': 1,
  'params.Срок замены': 1,
  'params.Упаковка': 1,
  'params.Радиус кривизны': 1,
  'params.Диаметр': 1,
  'params.Цвет': 1,
};

export async function searchProducts(parsedParams, limit = 20) {
  const query = buildQuery(parsedParams);
  if (!query) return [];

  const hasText = parsedParams.model_hint || parsedParams.brand_hint;

  if (hasText) {
    return Product
      .find(query, { ...PROJECTION, score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
  }

  return Product.find(query, PROJECTION).limit(limit).lean();
}
