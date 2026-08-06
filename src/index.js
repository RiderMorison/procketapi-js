/**
 * PRocket API — официальный клиент для Node.js.
 *
 *     import { PRocket } from 'procketapi';
 *
 *     const procket = new PRocket('ВАШ_КЛЮЧ');
 *
 *     bot.on('message', async (msg) => {
 *       if (!(await procket.check(msg.from.id, { bot }))) return;
 *       // пользователь подписан
 *     });
 *
 * Две строки на обязательную подписку. Текст, клавиатура и кнопка «Проверить»
 * приходят с сервера готовыми, поэтому у клиента нет места, где это можно
 * собрать неправильно.
 */

export class PRocketError extends Error {}

/** 401. Ключ не принят — повторять бессмысленно. */
export class PRocketAuthError extends PRocketError {}

/** 429. Превышен лимит запросов. */
export class PRocketRateLimitError extends PRocketError {
  constructor(message, retryAfter = 1) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** Сеть недоступна или ответ нечитаем. */
export class PRocketRequestError extends PRocketError {}

/** 5xx. Дефект на нашей стороне. */
export class PRocketServerError extends PRocketError {}

const DEFAULT_BASE_URL = 'https://app.procket.club';

/** Коды результата показа — та же таблица, что в документации. */
export const AdResult = {
  SUCCESS: 1,
  REVOKED_TOKEN: 2,
  USER_FORBIDDEN: 3,
  TOO_MANY_REQUESTS: 4,
  BOT_API_ERROR: 5,
  OTHER_ERROR: 6,
  AD_LIMITED: 7,
  NO_ADS: 8,
  BOT_NOT_ENABLED: 9,
  BANNED: 10,
  IN_REVIEW: 11
};

export class PRocket {
  /**
   * @param {string} key ключ из раздела «Интеграция» в мини-аппе
   * @param {object} [options]
   * @param {string} [options.baseUrl]  адрес сервера
   * @param {number} [options.timeout]  таймаут одного запроса, мс
   * @param {number} [options.retries]  попыток при 5xx и сетевой ошибке
   * @param {boolean} [options.throwOnError] бросать вместо мягкой деградации
   *
   * По умолчанию клиент не роняет бота: при недоступности PRocket `check()`
   * возвращает «пропустить». Владелец теряет один показ вместо всех сразу.
   */
  constructor(key, options = {}) {
    if (!key || typeof key !== 'string') throw new Error('PRocket key is required');
    this.key = key.trim();
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = Number(options.timeout) || 10_000;
    this.retries = Math.max(1, Number(options.retries) || 3);
    this.throwOnError = Boolean(options.throwOnError);
    this.logger = options.logger || console;
    // Ключ отвергнут — гасим все последующие запросы до перезапуска, чтобы
    // неверный ключ не превратился в поток 401 в чужом логе.
    this.keyRejected = false;
  }

  async request(path, payload) {
    if (this.keyRejected) return null;

    const url = `${this.baseUrl}${path}`;
    const body = {};
    for (const [name, value] of Object.entries(payload || {})) {
      if (value !== undefined && value !== null) body[name] = value;
    }

    let delay = 1000;
    let lastError = null;

    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.key}`,
            Auth: this.key,
            'User-Agent': 'procketapi-js/1.0'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (response.status === 401) {
          this.keyRejected = true;
          // ASCII: сообщение попадает в чужую консоль, и не всякая из них
          // умеет UTF-8.
          this.logger.error('PRocket: API key rejected. Check the key in the Mini App.');
          return this.fail(new PRocketAuthError('API key rejected'));
        }
        if (response.status === 404) return this.fail(new PRocketError(`Not found: ${path}`));
        if (response.status === 422) {
          const data = await this.json(response);
          return this.fail(new PRocketError(data?.message || 'Invalid request'));
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('Retry-After')) || 1;
          if (attempt + 1 < this.retries) {
            await sleep(retryAfter * 1000);
            continue;
          }
          return this.fail(new PRocketRateLimitError('Rate limited', retryAfter));
        }
        if (response.status >= 500) {
          lastError = new PRocketServerError(`Server error ${response.status}`);
          if (attempt + 1 < this.retries) {
            await sleep(delay);
            delay *= 2;
            continue;
          }
          return this.fail(lastError);
        }
        return await this.json(response);
      } catch (error) {
        lastError = new PRocketRequestError(String(error?.message || error));
        if (attempt + 1 < this.retries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    return this.fail(lastError || new PRocketRequestError('Request failed'));
  }

  async json(response) {
    try {
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      return this.fail(new PRocketRequestError(`Bad JSON: ${error?.message || error}`));
    }
  }

  fail(error) {
    if (this.throwOnError && error) throw error;
    if (error) this.logger.warn(`PRocket: ${error.message}`);
    return null;
  }

  /**
   * Проверить обязательную подписку.
   *
   * Возвращает объект с полем `passed`. Если пользователь не подписан и
   * передан `bot`, клиент сам отправит сообщение со спонсорами и кнопкой
   * «Проверить».
   *
   * Отдельного метода «проверить ещё раз» нет: повторный вызов `check()` и
   * есть проверка — его же вешают на кнопку.
   */
  async check(userId, options = {}) {
    const data = await this.request('/api/v2/check', {
      user_id: userId,
      limit: options.limit ?? 3,
      language_code: options.languageCode,
      is_premium: options.isPremium,
      message: options.message,
      user_name: options.userName
    });

    // Пустой ответ = сервис недоступен. Пропускаем: бот важнее офферов.
    if (!data) return { passed: true, reason: 'unavailable', offers: [], message: null };

    const result = {
      passed: Boolean(data.passed ?? data.skip),
      reason: String(data.reason || ''),
      description: String(data.description || ''),
      offers: Array.isArray(data.offers) ? data.offers : [],
      message: data.message || null,
      attachedUntil: data.attached_until || null,
      raw: data
    };

    if (!result.passed && options.send !== false && options.bot && result.message) {
      await this.send(options.bot, userId, result.message);
    }
    return result;
  }

  /**
   * Отправить готовое сообщение любым известным клиентом Telegram.
   * Никогда не бросает: сбой отправки спонсоров не должен ронять хендлер.
   */
  async send(bot, userId, message) {
    const payload = {
      parse_mode: message.parse_mode || 'HTML',
      reply_markup: message.reply_markup
    };
    try {
      // node-telegram-bot-api и telegraf: sendMessage(chatId, text, extra)
      if (typeof bot.sendMessage === 'function') {
        await bot.sendMessage(userId, message.text, payload);
        return;
      }
      // grammY: bot.api.sendMessage(chatId, text, extra)
      if (bot.api && typeof bot.api.sendMessage === 'function') {
        await bot.api.sendMessage(userId, message.text, payload);
        return;
      }
      // telegraf context: ctx.telegram.sendMessage(...)
      if (bot.telegram && typeof bot.telegram.sendMessage === 'function') {
        await bot.telegram.sendMessage(userId, message.text, payload);
        return;
      }
      this.logger.warn('PRocket: bot object has no sendMessage()');
    } catch (error) {
      this.logger.warn(`PRocket: failed to send sponsor message: ${error?.message || error}`);
    }
  }

  /** Выдать пользователю задания. Награда начисляется за выполнение. */
  async getTasks(userId, options = {}) {
    const data = await this.request('/api/v2/tasks', {
      user_id: userId,
      limit: options.limit ?? 5,
      language_code: options.languageCode,
      is_premium: options.isPremium,
      message: options.message
    });
    if (!data) return { tasks: [], completed: false, message: null };
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : (data.result || []),
      completed: Boolean(data.completed),
      message: data.message || null,
      attachedUntil: data.attached_until || null,
      raw: data
    };
  }

  /** Состояние одного задания по тикету из `offer.ticket`. */
  async checkTask(ticket) {
    const data = await this.request('/api/v2/check_task', { ticket });
    if (!data) return { state: '', completed: false, reward: 0, currency: '' };
    const state = String(data.state || data.result || '');
    return {
      state,
      completed: Boolean(data.completed ?? ['done', 'paid'].includes(state)),
      reward: Number(data.reward || 0),
      currency: String(data.currency || ''),
      raw: data
    };
  }

  /**
   * Показать пользователю рекламный пост. Сервер отправит его сам через
   * токен вашего бота.
   *
   * @param {object} [options]
   * @param {boolean} [options.hi] режим привета: только после `/start` нового
   *   пользователя и не чаще раза в сутки на человека.
   */
  async sendAd(userId, options = {}) {
    const data = await this.request('/api/v2/ad/send', {
      user_id: userId,
      hi: Boolean(options.hi),
      language_code: options.languageCode
    });
    if (!data) return { code: AdResult.OTHER_ERROR, ok: false, description: 'Request failed' };
    const code = Number(data.SendPostResult ?? data.result ?? AdResult.OTHER_ERROR);
    return { code, ok: Boolean(data.ok ?? code === AdResult.SUCCESS), description: String(data.description || ''), raw: data };
  }

  /** Закрыть открытые привязки пользователя. Нужен, когда он начал заново. */
  async reset(userId) {
    const data = await this.request('/api/v2/reset', { user_id: userId });
    return Number(data?.reset || 0);
  }

  /** Бот, баланс владельца, вебхук и лимиты. */
  async me() {
    return this.request('/api/v2/me', {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { verifyWebhook, WebhookSignatureError } from './webhook.js';
export default PRocket;
