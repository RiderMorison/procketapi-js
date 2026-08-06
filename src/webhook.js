/**
 * Проверка подписи вебхука.
 *
 * Проверять обязательно. Без этого любой, кто узнал адрес вашего обработчика,
 * пришлёт поддельное «задание выполнено» — и вы начислите награду за него.
 */

import crypto from 'node:crypto';

const DEFAULT_TOLERANCE = 300; // 5 минут

export class WebhookSignatureError extends Error {}

/**
 * Проверить заголовок `X-Procket-Signature`.
 *
 * @param {Buffer|string} body тело запроса **в исходном виде**. Не разбирайте
 *   JSON до проверки и не собирайте его обратно: подпись считается по байтам,
 *   и любая перестановка ключей её ломает.
 * @param {string} signatureHeader значение вида `t=1234567890,v1=abc...`
 * @param {string} secret секрет вебхука из карточки интеграции
 * @param {number} [tolerance] допустимый возраст запроса в секундах
 * @returns {true}
 * @throws {WebhookSignatureError}
 */
export function verifyWebhook(body, signatureHeader, secret, tolerance = DEFAULT_TOLERANCE) {
  if (!signatureHeader) throw new WebhookSignatureError('Missing X-Procket-Signature header');

  let timestamp = '';
  let provided = '';
  for (const part of String(signatureHeader).split(',')) {
    const [name, value] = part.trim().split('=');
    if (name === 't') timestamp = value;
    if (name === 'v1') provided = value;
  }
  if (!timestamp || !provided) throw new WebhookSignatureError('Malformed X-Procket-Signature header');

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) throw new WebhookSignatureError('Malformed timestamp');

  // Метка времени входит в подписываемую строку, а не лежит рядом, поэтому
  // подменить её, сохранив подпись, нельзя. Отказ по возрасту закрывает
  // переигрывание перехваченного запроса.
  if (Math.abs(Date.now() / 1000 - sentAt) > tolerance) {
    throw new WebhookSignatureError('Signature timestamp is outside the tolerance window');
  }

  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), payload]);
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  // timingSafeEqual бросает на разной длине, поэтому длину сверяем отдельно;
  // само сравнение обязано быть постоянным по времени, иначе подпись
  // подбирается по времени ответа.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new WebhookSignatureError('Signature mismatch');
  }
  return true;
}
