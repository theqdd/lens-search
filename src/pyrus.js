/**
 * Pyrus API client
 *
 * Аутентификация: POST https://accounts.pyrus.com/api/v4/auth
 * Токен действителен 24 часа — кэшируем, обновляем автоматически.
 *
 * Используется в webhook-обработчике:
 *   1. Принять POST /webhook/pyrus
 *   2. Проверить form_id
 *   3. Извлечь поля 5 (вопрос) и 7 (модель)
 *   4. Прогнать через поиск
 *   5. Отправить результат комментарием в задачу
 */

import { createHmac, timingSafeEqual } from 'crypto';

const AUTH_URL = 'https://accounts.pyrus.com/api/v4/auth';
const API_BASE  = 'https://api.pyrus.com/v4';

// ─── Токен (кэш) ─────────────────────────────────────────────────────────────

let _token = null;
let _tokenExp = 0; // unix ms

async function getToken() {
  // Обновляем если истёк или истекает через 5 минут
  if (_token && Date.now() < _tokenExp - 5 * 60 * 1000) return _token;

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login:        process.env.PYRUS_LOGIN,
      security_key: process.env.PYRUS_KEY,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pyrus auth failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  _token = data.access_token;

  // Декодируем exp из JWT payload (base64url) без внешних зависимостей
  try {
    const payload = JSON.parse(Buffer.from(_token.split('.')[1], 'base64url').toString());
    _tokenExp = payload.exp * 1000;
  } catch {
    _tokenExp = Date.now() + 23 * 60 * 60 * 1000; // fallback: 23 часа
  }

  return _token;
}

// ─── API вызовы ───────────────────────────────────────────────────────────────

async function apiRequest(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 401) {
    // Сбрасываем кэш и повторяем один раз
    _token = null;
    return apiRequest(method, path, body);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Pyrus API error: ${data.error}`);
  return data;
}

/**
 * Публикует комментарий в задачу Pyrus.
 * @param {number|string} taskId
 * @param {string} text  — plain text или HTML (если html=true)
 * @param {{ html?: boolean }} opts
 */
export async function postComment(taskId, text, { html = false } = {}) {
  const body = html ? { formatted_text: text } : { text };
  return apiRequest('POST', `/tasks/${taskId}/comments`, body);
}

// ─── Верификация подписи вебхука ─────────────────────────────────────────────

/**
 * Pyrus подписывает тело вебхука через HMAC-SHA1 ключом security_key.
 * Подпись приходит в заголовке X-Pyrus-Sig.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = createHmac('sha1', process.env.PYRUS_KEY)
    .update(rawBody)
    .digest('hex');
  const sig = signature.toLowerCase();
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// ─── Парсинг полей из вебхука ─────────────────────────────────────────────────

/**
 * Извлекает значение поля по id из массива fields задачи.
 * Поддерживает вложенные структуры {value: {text: ...}} и простые строки.
 */
export function getFieldValue(fields, fieldId) {
  const field = fields?.find(f => f.id === fieldId || f.id === String(fieldId));
  if (!field) return null;
  const v = field.value;
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.text ?? v.value ?? JSON.stringify(v);
  return String(v);
}
