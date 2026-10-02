# WeChat Adapter for umbot

[![npm version](https://img.shields.io/npm/v/umbot-wechat-adapter.svg)](https://www.npmjs.com/package/umbot-wechat-adapter)
[![npm downloads](https://img.shields.io/npm/dm/umbot-wechat-adapter.svg)](https://www.npmjs.com/package/umbot-wechat-adapter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![umbot](https://img.shields.io/badge/umbot-adapter-blue)](https://github.com/max36895/universal_bot-ts)

> **TL;DR:** `umbot-wechat-adapter` connects a **WeChat Official Account** to the [umbot](https://github.com/max36895/universal_bot-ts)
> framework: the same commands, steps, buttons, cards and user data you already wrote for Telegram or Alice, now on WeChat.

## 📖 About

The adapter maps WeChat's message and event model onto umbot's `BotController`: text, recognised voice, images, video,
location, links and account events (`subscribe` / `unsubscribe` / `SCAN` / `CLICK` / `VIEW` / `LOCATION`). Replies are
sent through the **Customer Service API** (`message/custom/send`) instead of the passive XML reply.

### Key Features

- 🔄 **Unified API:** write `bot.addCommand(...)` / `bot.addEvent(...)` once — it works on WeChat too.
- 🧭 **Event mapping:** WeChat events become umbot's `TEventType` (`subscribed`, `callback`, `photo`, `voice`, …).
- 🔐 **Real WeChat signature:** SHA1 over the sorted `token/timestamp/nonce` triple, not the framework's default HMAC.
- 🧩 **Helpers included:** XML parsing, signature check and URL verification for your HTTP layer.
- 🖼 **Media:** images and voice with `media_id` caching in `ImageTokens` / `SoundTokens`; an expired `media_id`
  (WeChat keeps uploads for 3 days) is re-uploaded automatically.
- 🔑 **Stable `access_token`:** fetched with `stable_token`, shared by parallel requests, refreshed on `40001` /
  `42001` — several bot instances do not revoke each other's tokens.
- 🛡️ **Type-Safe:** written in TypeScript, `strict: true`.

## 📋 Requirements

- Node.js `>= 20.19.0`
- `umbot ^3.1.0` (peer dependency; deduplication of WeChat retries needs `umbot >= 3.1.3`)
- A WeChat Official Account with `Token`, `AppID` and `AppSecret`

## 🚀 Quick Start

### 1. Installation

```bash
npm install umbot umbot-wechat-adapter
```

### 2. Wiring the adapter

```ts
import { Bot } from 'umbot';
import { WeChatAdapter } from 'umbot-wechat-adapter';

export const bot = new Bot()
    .use(
        new WeChatAdapter(process.env.WECHAT_TOKEN, {
            app_id: process.env.WECHAT_APP_ID,
            app_secret: process.env.WECHAT_APP_SECRET,
        }),
    )
    .addCommand('hello', ['hi', 'привет'], (userCommand, ctx) => {
        ctx.text = `Hello from umbot! You said: ${userCommand}`;
        ctx.buttons.addBtn('Каталог');
    });
```

### 3. The HTTP layer (required)

> ⚠️ **`bot.start()` does not work with WeChat.** umbot's built-in server accepts only `POST` with a JSON body,
> while WeChat sends **XML** and verifies the URL with a **`GET`**. Wire the endpoint yourself and hand umbot a
> parsed object — the adapter ships the three helpers you need.

```ts
import { createServer } from 'http';
import { URL } from 'url';
import {
    handleWeChatVerification,
    parseWeChatXml,
    verifyWeChatSignature,
    WECHAT_MAX_XML_LENGTH,
} from 'umbot-wechat-adapter';
import { bot } from './bot';

const TOKEN = process.env.WECHAT_TOKEN!;

createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const params = Object.fromEntries(url.searchParams);

    // 1. URL verification from the Official Account console (GET + echostr)
    if (req.method === 'GET') {
        const echo = handleWeChatVerification(TOKEN, params);
        res.statusCode = echo ? 200 : 403;
        res.end(echo ?? 'forbidden');
        return;
    }

    // 2. Incoming message: check the signature from the query string BEFORE reading the body,
    //    so a stranger cannot make the server read and parse large bodies
    if (!verifyWeChatSignature(TOKEN, params.signature, params.timestamp, params.nonce, 300)) {
        res.statusCode = 401;
        res.end('');
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > WECHAT_MAX_XML_LENGTH) {
            res.statusCode = 413;
            res.end('');
            return;
        }
        chunks.push(chunk as Buffer);
    }
    const query = parseWeChatXml(Buffer.concat(chunks).toString('utf8'));
    if (!query) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
    }

    // 3. Acknowledge at once with an empty body: WeChat waits at most 5 seconds and accepts an empty
    //    reply without retrying. The answer itself goes to the user through the Customer Service API.
    res.statusCode = 200;
    res.end('');

    // The adapter only sees headers, so forward the signature triple as headers.
    bot.webhookEvent(query, {
        'x-wechat-signature': params.signature,
        'x-wechat-timestamp': params.timestamp,
        'x-wechat-nonce': params.nonce,
    }).catch((error) => console.error('WeChat webhook failed', error));
}).listen(3000);
```

**Why acknowledge first.** WeChat closes the connection and repeats the delivery (up to three times) if it gets no
response within 5 seconds, while `bot.webhookEvent()` resolves only after the reply has been sent through the
Customer Service API (`access_token`, media upload, sending). A slow reply would come back as duplicates.

**Serverless** (a cloud function stops right after the response): `await bot.webhookEvent(...)` and then return an
empty body. Repeated deliveries of the same message are recognised by `MsgId` (events — by sender, time and event
type) and processed once — umbot `>= 3.1.3` does this through the adapter's `getDeliveryId()`. Always answer WeChat
with an empty body, not with `result.body`: for a repeated delivery it is `'ok'`, and WeChat expects either an
empty string or a passive XML reply.

The same three headers work behind Express, Fastify or a serverless function — only the way you read
`req.query` / `req.body` changes.

## ⚙️ Configuration

```ts
new WeChatAdapter(token, options);
```

| Parameter                   | Type    | Required | Description                                                                            |
| --------------------------- | ------- | -------- | -------------------------------------------------------------------------------------- |
| `token`                     | string  | ✅       | Token from the Official Account console. Used for signature verification.              |
| `options.app_id`            | string  | ✅       | AppID. Required to obtain `access_token`.                                              |
| `options.app_secret`        | string  | ✅       | AppSecret.                                                                             |
| `options.signature_max_age` | number  | ❌       | Max age of the signature `timestamp`, seconds. Default `300`; `0` disables the check.  |
| `options.encoding_aes_key`  | string  | ❌       | Reserved: message encryption (Safe Mode) is not implemented yet.                       |
| `options.fetch_user_info`   | boolean | ❌       | **Deprecated**, does nothing: `user/info` has not returned nicknames since 2021-12-27. |

The values also land in `appConfig.tokens.wechat`, so they can be set through `bot.setAppConfig()` instead.

**Why the signature age matters.** WeChat signs only `token`, `timestamp` and `nonce`, not the body. A signature
that leaked (for example, a proxy log with the query string) could otherwise be attached to any body and impersonate
any user. With `signature_max_age` it is accepted only for 5 minutes; keep the server clock in sync (NTP).

## 🧭 Event mapping

| WeChat                          | `ctx.eventType` | Notes                                                     |
| ------------------------------- | --------------- | --------------------------------------------------------- |
| `text`                          | `message`       | —                                                         |
| `voice`                         | `voice`         | `ctx.userCommand` = `Recognition` (speech recognition on) |
| `image`                         | `photo`         | `ctx.userMeta` = `{ PicUrl, MediaId }`                    |
| `video` / `shortvideo`          | `video`         | `ctx.userMeta` = `{ MediaId, ThumbMediaId }`              |
| `location`                      | `location`      | `ctx.userMeta` = coordinates + `Label`                    |
| `link`                          | `message`       | `ctx.userMeta` = `{ Url, Title, Description }`            |
| event `subscribe`               | `subscribed`    | `ctx.userCommand = 'start'`, `messageId = 0`              |
| event `subscribe` with QR scene | `start`         | scene + ticket in `ctx.payload`                           |
| event `unsubscribe`             | `unsubscribed`  | `skipAutoReply` — nothing can be sent any more            |
| event `CLICK` / `SCAN`          | `callback`      | `EventKey` normalised into `ctx.userCommand`              |
| event `VIEW`                    | `callback`      | `skipAutoReply`                                           |
| event `LOCATION`                | `location`      | background location report                                |

Unknown message types and service events (`TEMPLATESENDJOBFINISH`, …) set `skipAutoReply` and are answered with
an empty `200` — returning an error would make WeChat retry the delivery.

Because `CLICK` uses `pUtils.normalizeActionPayload`, a menu item whose key is `buy` (or `{"command":"buy"}`)
triggers `bot.addAction('buy', …)` / `bot.addCommand('buy', …)` with no manual parsing.

## 🎛 Buttons

The Customer Service API has **no inline keyboard** — the only menu is the static Official Account menu created
separately through `menu/create`. So buttons set by your business logic are appended to the reply as a text list:

```ts
ctx.text = 'Выберите раздел';
ctx.buttons.addBtn('Каталог');
ctx.buttons.addBtn('Поддержка', 'https://example.com/help');
```

```text
Выберите раздел

• Каталог
• Поддержка: https://example.com/help
```

Up to 8 buttons are rendered.

To build the static menu, `WeChatButton.menuButtonsProcessing()` turns umbot buttons into the `menu/create` body:
a link becomes a `view` item, any other button a `click` item whose `key` is the button payload (or title) — a
tap comes back as a `CLICK` event and reaches `addAction` / `addCommand`. WeChat allows 3 top-level items, names up
to 16 bytes and keys up to 128 bytes; extra items are dropped and long names cut.

```ts
const buttons = new Buttons(appContext);
buttons.addBtn('Каталог', null, 'catalog');
buttons.addBtn('Сайт', 'https://example.com');
const menu = buttons.getButtons(WeChatButton.menuButtonsProcessing);
// POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=... with `menu` as the body
```

`WeChatButton.buttonProcessing()` is deprecated: its result is not the `menu/create` format.

## 🖼 Media

```ts
ctx.card.addImage('/path/to/photo.jpg', 'Название');
ctx.sound.sounds = [{ key: '#hello#', sounds: ['/path/to/audio.mp3'] }];
```

- Images: PNG, JPEG, GIF up to 10 MB. Voice: **AMR or MP3** up to 2 MB and 60 seconds.
- WeChat's `media/upload` accepts **file uploads only** — a URL is skipped with a warning, so download remote files first.
- `media_id` is cached in `ImageTokens` / `SoundTokens`, so with a DB adapter connected a file is uploaded once. WeChat
  keeps an upload for **3 days**: when it rejects a cached `media_id` (`40007`), the adapter drops it from the cache,
  uploads the file again and resends.
- Image titles are added to the reply text rather than sent as separate messages (see the message quota below).
- `ctx.tts` is sent as **text**, not voice: Yandex SpeechKit produces OGG/Opus, and WeChat accepts only AMR and MP3.
  For voice, put an AMR/MP3 file into `ctx.sound.sounds`.

## 🔌 `controller.api`

```ts
await ctx.api.sendPhoto('/path/to/photo.jpg', { caption: 'Подпись' });
await ctx.api.sendAudio('/path/to/audio.mp3');
ctx.api.can('sendDocument'); // false — WeChat CS API has no arbitrary files
```

Supported: `sendPhoto`, `sendAudio`. `sendDocument`, `sendVideo` and `answerCallback` log a warning and return `null`.

## ⚠️ Limitations

- `bot.start()` is not usable — see [The HTTP layer](#3-the-http-layer-required).
- Message encryption (Safe Mode / `encoding_aes_key`) is not implemented; use the plaintext mode.
- No inline keyboard: buttons are rendered as text.
- **Message quota** of the Customer Service API: after a user message the bot may send up to **5** messages within
  48 hours; after subscribing, a menu tap or a QR scan — up to **3** within a minute. A reply is one text message plus
  one per image and per sound; the adapter logs a warning when a reply exceeds the quota.
- Text of one message is limited to **2048 bytes** UTF-8 (about 1000 Cyrillic or 680 Chinese characters); longer
  text is cut with `...`.
- WeChat Mini Programs are not supported (different auth flow).

## 🧪 Development

```bash
npm install
npm run bt      # build + test
npm run lint
```

## 🔗 Ecosystem

This package is part of the umbot ecosystem:

- [umbot](https://github.com/max36895/universal_bot-ts) — the core universal bot framework (Telegram, VK, MAX, Viber, Alice, …).
- umbot-wechat-adapter — WeChat Official Account adapter (this package).
- [umbot-knex-adapter](https://github.com/max36895/umbot-knex-adapter) — SQL database adapter.

## 📄 License

Distributed under the MIT License. See LICENSE.md for more information.
