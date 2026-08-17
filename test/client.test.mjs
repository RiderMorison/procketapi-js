// Поведение клиента против настоящего HTTP-сервера.
//
// Заглушкой, а не моком fetch: проверять надо то, что поедет к пользователю,
// включая заголовки и разбор кодов ответа.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { PRocket, PRocketAuthError, PRocketRateLimitError, AdResult } from '../src/index.js';

/**
 * Поднимает сервер, отвечающий по сценарию. `handler` получает номер попытки,
 * начиная с 1, — так проверяются повторы.
 */
async function withStub(handler, run) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf-8');
    seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    handler(seen.length, res, seen[seen.length - 1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const quiet = { error() {}, warn() {}, log() {} };

test('без ключа конструктор бросает сразу', () => {
  assert.throws(() => new PRocket(), /key is required/i);
  assert.throws(() => new PRocket(''), /key is required/i);
  assert.throws(() => new PRocket(123), /key is required/i);
});

test('ключ уходит и в Authorization, и в Auth', async () => {
  await withStub(
    (_n, res) => json(res, 200, { passed: true, reason: 'no_offers', offers: [] }),
    async (baseUrl, seen) => {
      const procket = new PRocket('prk_live_test', { baseUrl, logger: quiet });
      await procket.check(42);
      // Два имени намеренно: сервер принимает оба, и клиенты чужих сервисов
      // ищут то одно, то другое.
      assert.equal(seen[0].headers.authorization, 'Bearer prk_live_test');
      assert.equal(seen[0].headers.auth, 'prk_live_test');
      assert.equal(seen[0].url, '/api/v2/check');
      assert.equal(seen[0].body.user_id, 42);
    }
  );
});

test('undefined-поля не уезжают в теле', async () => {
  await withStub(
    (_n, res) => json(res, 200, { passed: true, offers: [] }),
    async (baseUrl, seen) => {
      const procket = new PRocket('k', { baseUrl, logger: quiet });
      await procket.check(1);
      // languageCode не передан — ключа не должно быть вовсе, иначе сервер
      // получает language_code: null и пишет его в аналитику как значение.
      assert.ok(!('language_code' in seen[0].body));
      assert.ok(!('is_premium' in seen[0].body));
    }
  );
});

test('401 гасит клиента до перезапуска', async () => {
  await withStub(
    (_n, res) => json(res, 401, { error: 'sdk_key_invalid' }),
    async (baseUrl, seen) => {
      const procket = new PRocket('bad', { baseUrl, logger: quiet });
      await procket.check(1);
      await procket.check(2);
      await procket.check(3);
      // Один запрос на три вызова: неверный ключ не должен превращаться
      // в поток 401 в чужом логе.
      assert.equal(seen.length, 1);
      assert.equal(procket.keyRejected, true);
    }
  );
});

test('при throwOnError 401 бросается наружу', async () => {
  await withStub(
    (_n, res) => json(res, 401, {}),
    async (baseUrl) => {
      const procket = new PRocket('bad', { baseUrl, throwOnError: true, logger: quiet });
      await assert.rejects(() => procket.check(1), PRocketAuthError);
    }
  );
});

test('5xx повторяется, и удачная попытка засчитывается', async () => {
  await withStub(
    (n, res) => (n < 3 ? json(res, 503, {}) : json(res, 200, { passed: true, offers: [] })),
    async (baseUrl, seen) => {
      const procket = new PRocket('k', { baseUrl, retries: 3, logger: quiet });
      const result = await procket.check(7);
      assert.equal(seen.length, 3);
      assert.equal(result.passed, true);
    }
  );
});

test('когда попытки кончились, бот не падает, а пропускает', async () => {
  await withStub(
    (_n, res) => json(res, 503, {}),
    async (baseUrl) => {
      const procket = new PRocket('k', { baseUrl, retries: 2, logger: quiet });
      const result = await procket.check(7);
      // Главное обещание клиента: недоступность PRocket стоит одного показа,
      // а не всего бота.
      assert.equal(result.passed, true);
      assert.equal(result.reason, 'unavailable');
    }
  );
});

test('429 отдаёт retryAfter, когда просили бросать', async () => {
  await withStub(
    (_n, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
      res.end('{}');
    },
    async (baseUrl) => {
      const procket = new PRocket('k', { baseUrl, retries: 1, throwOnError: true, logger: quiet });
      await assert.rejects(
        () => procket.check(1),
        (error) => error instanceof PRocketRateLimitError && error.retryAfter === 7
      );
    }
  );
});

test('нечитаемый ответ не роняет бота', async () => {
  await withStub(
    (_n, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{не json');
    },
    async (baseUrl) => {
      const procket = new PRocket('k', { baseUrl, retries: 1, logger: quiet });
      const result = await procket.check(1);
      assert.equal(result.passed, true);
    }
  );
});

test('таблица кодов показа совпадает с документацией', () => {
  // Клиенты разбирают их числами, а не текстом, поэтому значения зафиксированы.
  assert.deepEqual(AdResult, {
    SUCCESS: 1, REVOKED_TOKEN: 2, USER_FORBIDDEN: 3, TOO_MANY_REQUESTS: 4,
    BOT_API_ERROR: 5, OTHER_ERROR: 6, AD_LIMITED: 7, NO_ADS: 8,
    BOT_NOT_ENABLED: 9, BANNED: 10, IN_REVIEW: 11
  });
});

test('хвостовой слеш в baseUrl не удваивается', async () => {
  await withStub(
    (_n, res) => json(res, 200, { passed: true, offers: [] }),
    async (baseUrl, seen) => {
      const procket = new PRocket('k', { baseUrl: `${baseUrl}///`, logger: quiet });
      await procket.check(1);
      assert.equal(seen[0].url, '/api/v2/check');
    }
  );
});
