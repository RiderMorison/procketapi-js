# PRocket API — Node.js

Официальный клиент [PRocket](https://app.procket.club) для Telegram-ботов:
обязательная подписка, задания и показы.

```bash
npm install procketapi
```

Требуется Node.js 18+ (используется встроенный `fetch`).

---

## Обязательная подписка за две строки

### grammY

```js
import { Bot } from 'grammy';
import { PRocket } from 'procketapi';

const bot = new Bot('ТОКЕН_БОТА');
const procket = new PRocket('ВАШ_КЛЮЧ');

bot.on('message', async (ctx, next) => {
  const result = await procket.check(ctx.from.id, {
    bot,
    languageCode: ctx.from.language_code,
    isPremium: ctx.from.is_premium
  });
  if (!result.passed) return;   // спонсоры уже отправлены пользователю
  await next();
});

bot.command('start', (ctx) => ctx.reply('Доступ открыт'));

bot.callbackQuery('procket_check', async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await procket.check(ctx.from.id, { bot });
  await ctx.reply(result.passed ? 'Спасибо! Доступ открыт.' : 'Вы подписались не на всех спонсоров.');
});

bot.start();
```

Если пользователь не подписан и передан `bot`, клиент **сам** отправит
сообщение со спонсорами, клавиатурой и кнопкой «Проверить» — верстать ничего
не нужно.

Отдельного метода «проверить ещё раз» нет: **повторный вызов `check()` и есть
проверка**. Его же вешают на кнопку.

### node-telegram-bot-api

```js
import TelegramBot from 'node-telegram-bot-api';
import { PRocket } from 'procketapi';

const bot = new TelegramBot('ТОКЕН_БОТА', { polling: true });
const procket = new PRocket('ВАШ_КЛЮЧ');

bot.onText(/\/start/, async (msg) => {
  const result = await procket.check(msg.from.id, { bot, languageCode: msg.from.language_code });
  if (!result.passed) return;
  await bot.sendMessage(msg.chat.id, 'Доступ открыт');
});

bot.on('callback_query', async (query) => {
  if (query.data !== 'procket_check') return;
  await bot.answerCallbackQuery(query.id);
  const result = await procket.check(query.from.id, { bot });
  await bot.sendMessage(query.message.chat.id, result.passed ? 'Спасибо!' : 'Ещё не всё.');
});
```

### Telegraf

```js
import { Telegraf } from 'telegraf';
import { PRocket } from 'procketapi';

const bot = new Telegraf('ТОКЕН_БОТА');
const procket = new PRocket('ВАШ_КЛЮЧ');

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const result = await procket.check(ctx.from.id, { bot: ctx.telegram });
  if (!result.passed) return;
  return next();
});

bot.start((ctx) => ctx.reply('Доступ открыт'));
bot.launch();
```

---

## Задания

```js
const { tasks, message } = await procket.getTasks(userId, { limit: 5 });

if (message) {
  await bot.api.sendMessage(userId, message.text, {
    parse_mode: message.parse_mode,
    reply_markup: message.reply_markup
  });
}

// позже, по кнопке
const state = await procket.checkTask(tasks[0].ticket);
if (state.completed) await giveReward(userId, state.reward);
```

Состояния: `open`, `done`, `waiting`, `paid`, `expired`, `cancelled`, `reverted`.

---

## Показы и приветы

```js
import { AdResult } from 'procketapi';

const result = await procket.sendAd(userId, { hi: true });  // привет после /start

if (result.code === AdResult.USER_FORBIDDEN) await markBlocked(userId);
```

| Код | Константа | Значение |
|----|-----------|----------|
| 1 | `SUCCESS` | пост доставлен |
| 2 | `REVOKED_TOKEN` | токен бота недействителен |
| 3 | `USER_FORBIDDEN` | пользователь заблокировал бота |
| 4 | `TOO_MANY_REQUESTS` | превышен лимит |
| 5 | `BOT_API_ERROR` | ошибка Telegram |
| 6 | `OTHER_ERROR` | внутренняя ошибка |
| 7 | `AD_LIMITED` | лимит показов исчерпан |
| 8 | `NO_ADS` | нет подходящей рекламы |
| 9 | `BOT_NOT_ENABLED` | бот выключен в настройках |
| 10 | `BANNED` | бот заблокирован |
| 11 | `IN_REVIEW` | бот на модерации |

`hi: true` вызывать только после `/start` нового пользователя и не чаще раза
в сутки на человека.

---

## Вебхуки

```js
import express from 'express';
import { verifyWebhook, WebhookSignatureError } from 'procketapi';

const app = express();

// raw, не express.json(): подпись считается по исходным байтам, и разбор
// JSON с обратной сборкой её ломает — порядок ключей не сохраняется.
app.post('/procket/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    verifyWebhook(req.body, req.get('X-Procket-Signature'), process.env.PROCKET_SECRET);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return res.sendStatus(403);
    throw error;
  }

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.type === 'task.completed') {
    giveReward(event.data.user_id, event.data.reward, event.data.ticket);
  }
  res.json({ ok: true });
});
```

Проверять подпись обязательно. Повтор доставки после таймаута — штатная
ситуация, поэтому проверяйте, что `ticket` ещё не оплачен, иначе награда
начислится дважды.

---

## Справочник

```js
new PRocket(key, {
  baseUrl: 'https://app.procket.club',
  timeout: 10000,
  retries: 3,
  throwOnError: false
});
```

| Метод | Возвращает |
|-------|-----------|
| `await check(userId, { bot, languageCode, isPremium, limit, message, send })` | `{ passed, reason, offers, message, attachedUntil }` |
| `await getTasks(userId, { limit, languageCode, isPremium })` | `{ tasks, completed, message }` |
| `await checkTask(ticket)` | `{ state, completed, reward, currency }` |
| `await sendAd(userId, { hi })` | `{ code, ok, description }` |
| `await reset(userId)` | `number` — сколько привязок закрыто |
| `await me()` | данные бота, баланс, вебхук, лимиты |

### Своё оформление сообщения

```js
await procket.check(userId, {
  bot,
  message: {
    rows: 2,                              // кнопок в ряд
    text: '<b>Подпишитесь</b>, $name',    // $name, {count}, {reward}, {currency}
    button_channel: 'Подписаться',
    button_check: 'Готово ✅'
  }
});
```

### Поведение при сбоях

По умолчанию клиент **не роняет бота**: при недоступности PRocket `check()`
возвращает `passed: true`. Владелец теряет один показ вместо всех сразу.

`401` не повторяется — после отказа клиент замолкает до перезапуска, чтобы
неверный ключ не превратился в поток ошибок в логе.

Строгое поведение включается через `throwOnError: true`.

---

Полная документация API: <https://procketapi.best>

## Лицензия

MIT
