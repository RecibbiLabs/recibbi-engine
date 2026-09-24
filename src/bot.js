'use strict';

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const config = require('./config');
const logger = require('./logger');
const providerKeys = require('./settings/providerKeys');

const API = config.telegram.apiUrl;

// Map a Telegram user to an identity: a configured tenant (or the server
// default) and a per-user id `tg_<telegram-user-id>`, so each Telegram user's
// receipts are isolated within the tenant.
function identityHeaders(telegramUserId) {
  const headers = {};
  if (config.telegram.tenantId) headers['X-Tenant-Id'] = config.telegram.tenantId;
  if (telegramUserId != null) headers['X-User-Id'] = `tg_${telegramUserId}`;
  return headers;
}

async function uploadToApi(fileLink, filename, mimeType, telegramUserId) {
  const imgRes = await fetch(fileLink);
  if (!imgRes.ok) throw new Error(`could not download telegram file (${imgRes.status})`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const form = new FormData();
  form.append('source', 'telegram');
  form.append('receipt', new Blob([buf], { type: mimeType || 'image/jpeg' }), filename || 'receipt.jpg');

  const res = await fetch(`${API}/api/receipts`, {
    method: 'POST',
    body: form,
    headers: identityHeaders(telegramUserId),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API responded ${res.status}`);
  return data; // { id, status, statusUrl, viewUrl }
}

/** Everything the bot answers, on one Telegraf instance. */
function register(bot) {
  bot.start((ctx) =>
    ctx.reply(
      'Send me a photo of a grocery receipt and I will extract the items, look up product images, and send you a link to the full breakdown.'
    )
  );
  bot.help((ctx) => ctx.reply('Just send a receipt photo (as a photo or as an image file).'));

  bot.on(message('photo'), async (ctx) => {
    try {
      await ctx.reply('Got it — processing your receipt…');
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const link = await ctx.telegram.getFileLink(largest.file_id);
      const data = await uploadToApi(link.href, `${largest.file_unique_id}.jpg`, 'image/jpeg', ctx.from && ctx.from.id);
      await ctx.reply(
        `Queued! View the breakdown here once it finishes:\n${data.viewUrl}\n\n(it updates live as items are enriched)`
      );
    } catch (err) {
      logger.error({ err: err.message }, 'telegram photo handler failed');
      await ctx.reply(`Sorry, something went wrong: ${err.message}`);
    }
  });

  bot.on(message('document'), async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
      return ctx.reply('Please send an image of the receipt (jpg/png).');
    }
    try {
      await ctx.reply('Got it — processing your receipt…');
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const data = await uploadToApi(link.href, doc.file_name || 'receipt.jpg', doc.mime_type, ctx.from && ctx.from.id);
      await ctx.reply(`Queued! View the breakdown here:\n${data.viewUrl}`);
    } catch (err) {
      logger.error({ err: err.message }, 'telegram document handler failed');
      await ctx.reply(`Sorry, something went wrong: ${err.message}`);
    }
  });
}

// --- The token is read per launch, not per boot ------------------------------
//
// The token can be saved from Settings -> Providers while this process is
// running, and a saved token wins over TELEGRAM_BOT_TOKEN
// (src/settings/providerKeys.js). So the bot WATCHES for it: every WATCH_MS it
// asks config for the token in use, and when that changed it stops the old
// instance and launches a new one. That is what the operator's card means by
// "used from the next photograph sent to the bot".
//
// WITH NO TOKEN IT WAITS rather than exiting. It used to exit(0), which under
// `restart: unless-stopped` is a container that restarts for ever -- and now a
// token can arrive without a restart, so waiting is also simply correct.
//
// getMe() is asked first, and its answer is recorded for the card: a token can
// be revoked in BotFather without anybody here touching it, and a bot that
// silently stopped answering is exactly the failure the card exists to show.

const WATCH_MS = Number(process.env.TELEGRAM_WATCH_MS) || 15000;

let bot = null;
let running = null; // the token `bot` was launched with ('' = waiting for one)

async function reconcile() {
  const token = config.telegram.token || '';
  if (token === running) return;

  if (bot) {
    bot.stop('token changed');
    bot = null;
    logger.info('telegram bot stopped: its token changed');
  }
  running = token;
  if (!token) {
    logger.warn('no Telegram bot token (none saved in Settings, no TELEGRAM_BOT_TOKEN); waiting for one');
    return;
  }

  const next = new Telegraf(token);
  try {
    await next.telegram.getMe();
    providerKeys.observe('telegram', token, 200);
  } catch (err) {
    const status = (err.response && err.response.error_code) || err.code;
    providerKeys.observe('telegram', token, Number(status) || 0, err.response && err.response.description);
    // Leave `running` at this token: retrying a refused token every few seconds
    // would only hammer the Bot API. A new token -- saved, or a restart with a
    // different .env -- is what changes the answer.
    logger.error({ status, err: err.message }, 'telegram refused the bot token; not launching');
    return;
  }
  register(next);
  bot = next;
  next
    .launch()
    .catch((err) => logger.error({ err: err.message }, 'telegram bot stopped with an error'));
  logger.info({ api: API }, 'telegram bot launched');
}

reconcile().catch((err) => logger.error({ err: err.message }, 'telegram bot could not start'));
const timer = setInterval(() => {
  reconcile().catch((err) => logger.error({ err: err.message }, 'telegram bot reconcile failed'));
}, WATCH_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer);
    if (bot) bot.stop(signal);
    process.exit(0);
  });
}
