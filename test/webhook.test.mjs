// Проверка подписи вебхука.
//
// Это единственное место в клиенте, где ошибка стоит денег: пропущенная
// подделка — это «задание выполнено», за которое владелец начислит награду.
// Поэтому проверяется не только удачный путь, но и каждый способ обойти
// проверку, который приходит в голову.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { verifyWebhook, WebhookSignatureError } from '../src/webhook.js';

const SECRET = 'whsec_test_value';

/** Подписывает так же, как сервер: HMAC по строке `<метка>.<тело>`. */
function sign(body, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test('корректная подпись принимается', () => {
  const body = JSON.stringify({ event: 'subscription.completed', user_id: 42 });
  assert.equal(verifyWebhook(body, sign(body), SECRET), true);
});

test('тело как Buffer даёт тот же результат, что и строка', () => {
  const body = JSON.stringify({ event: 'task.completed' });
  const header = sign(body);
  assert.equal(verifyWebhook(Buffer.from(body, 'utf8'), header, SECRET), true);
});

test('изменённое тело не проходит', () => {
  const body = JSON.stringify({ event: 'task.completed', reward: 1 });
  const header = sign(body);
  const tampered = JSON.stringify({ event: 'task.completed', reward: 1000 });
  assert.throws(() => verifyWebhook(tampered, header, SECRET), WebhookSignatureError);
});

test('чужой секрет не проходит', () => {
  const body = '{}';
  assert.throws(() => verifyWebhook(body, sign(body, 'whsec_other'), SECRET), WebhookSignatureError);
});

test('подмена метки времени ломает подпись', () => {
  const body = '{}';
  const header = sign(body);
  const moved = header.replace(/^t=\d+/, `t=${Math.floor(Date.now() / 1000) + 1}`);
  // Метка входит в подписываемую строку, поэтому переписать её, сохранив
  // подпись, нельзя — в этом весь смысл её включения.
  assert.throws(() => verifyWebhook(body, moved, SECRET), WebhookSignatureError);
});

test('устаревший запрос отклоняется', () => {
  const body = '{}';
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhook(body, sign(body, SECRET, old), SECRET), WebhookSignatureError);
});

test('запрос из будущего тоже отклоняется', () => {
  const body = '{}';
  const ahead = Math.floor(Date.now() / 1000) + 3600;
  assert.throws(() => verifyWebhook(body, sign(body, SECRET, ahead), SECRET), WebhookSignatureError);
});

test('окно допуска настраивается', () => {
  const body = '{}';
  const old = Math.floor(Date.now() / 1000) - 600;
  assert.throws(() => verifyWebhook(body, sign(body, SECRET, old), SECRET), WebhookSignatureError);
  assert.equal(verifyWebhook(body, sign(body, SECRET, old), SECRET, 1200), true);
});

test('отсутствующий и битый заголовок отклоняются', () => {
  const body = '{}';
  for (const header of ['', null, undefined, 'garbage', 't=123', 'v1=abc', 't=,v1=', 't=abc,v1=def']) {
    assert.throws(() => verifyWebhook(body, header, SECRET), WebhookSignatureError, `принял: ${header}`);
  }
});

test('подпись неверной длины не роняет процесс', () => {
  // timingSafeEqual бросает на разной длине буферов; длина обязана
  // проверяться до него, иначе клиент падает вместо отказа.
  const body = '{}';
  const timestamp = Math.floor(Date.now() / 1000);
  assert.throws(() => verifyWebhook(body, `t=${timestamp},v1=abc`, SECRET), WebhookSignatureError);
});

test('пустое тело подписывается и проверяется', () => {
  assert.equal(verifyWebhook('', sign(''), SECRET), true);
});

test('порядок ключей в теле имеет значение', () => {
  // Подпись считается по байтам, поэтому пересобранный JSON её ломает — ровно
  // об этом предупреждает докстрока, и это стоит зафиксировать тестом.
  const original = '{"a":1,"b":2}';
  const header = sign(original);
  assert.throws(() => verifyWebhook('{"b":2,"a":1}', header, SECRET), WebhookSignatureError);
});
