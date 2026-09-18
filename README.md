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
sent through the **Customer Service API** (`message/custom/send`), so there is no 5-second passive-reply window to fight.

### Key Features

- 🔄 **Unified API:** write `bot.addCommand(...)` / `bot.addEvent(...)` once — it works on WeChat too.
- 🧭 **Event mapping:** WeChat events become umbot's `TEventType` (`subscribed`, `callback`, `photo`, `voice`, …).
- 🔐 **Real WeChat signature:** SHA1 over the sorted `token/timestamp/nonce` triple, not the framework's default HMAC.
- 🧩 **Helpers included:** XML parsing, signature check and URL verification for your HTTP layer.
- 🖼 **Media:** images and voice with `media_id` caching in `ImageTokens` / `SoundTokens`.
- 🗣 **TTS:** `controller.tts` is synthesised through Yandex SpeechKit and sent as a voice message.
- 🛡️ **Type-Safe:** written in TypeScript, `strict: true`.

## 📋 Requirements

- Node.js `>= 20.19.0`
- `umbot >= 3.1.0` (peer dependency)
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
import { handleWeChatVerification, parseWeChatXml } from 'umbot-wechat-adapter';
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

    // 2. Incoming message: XML body + signature in the query string
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const query = parseWeChatXml(Buffer.concat(chunks).toString('utf8'));
    if (!query) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
    }

    // The adapter only sees headers, so forward the signature triple as headers.
    const result = await bot.webhookEvent(query, {
        'x-wechat-signature': params.signature,
        'x-wechat-timestamp': params.timestamp,
        'x-wechat-nonce': params.nonce,
    });

    res.statusCode = result.statusCode;
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
}).listen(3000);
```

The same three headers work behind Express, Fastify or a serverless function — only the way you read
`req.query` / `req.body` changes.

## ⚙️ Configuration

```ts
new WeChatAdapter(token, options);
```

| Parameter                 | Type    | Required | Description                                                                   |
| ------------------------- | ------- | -------- | ----------------------------------------------------------------------------- |
| `token`                   | string  | ✅       | Token from the Official Account console. Used for signature verification.     |
| `options.app_id`          | string  | ✅       | AppID. Required to obtain `access_token`.                                     |
| `options.app_secret`      | string  | ✅       | AppSecret.                                                                     |
| `options.fetch_user_info` | boolean | ❌       | Fetch the sender nickname via `user/info` into `ctx.nlu.thisUser`. Off by default. |
| `options.encoding_aes_key`| string  | ❌       | Reserved: message encryption (Safe Mode) is not implemented yet.               |

The values also land in `appConfig.tokens.wechat`, so they can be set through `bot.setAppConfig()` instead.

`fetch_user_info` is opt-in on purpose: it adds one HTTP round trip per incoming message and `user/info` has a
hard daily quota. Results are cached in process memory (`WeChatAdapter.clearUserCache()` resets it).

## 🧭 Event mapping

| WeChat                          | `ctx.eventType` | Notes                                                    |
| ------------------------------- | --------------- | -------------------------------------------------------- |
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
`200 OK` — returning an error would make WeChat retry the delivery.

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

Up to 8 buttons are rendered; `WeChatButton.buttonProcessing()` is exported for those building the static menu.

## 🖼 Media and 🗣 TTS

```ts
ctx.card.addImage('/path/to/photo.jpg', 'Название');
ctx.sound.sounds = [{ key: '#hello#', sounds: ['/path/to/audio.mp3'] }];
```

`media_id` is cached in `ImageTokens` / `SoundTokens`, so with a DB adapter connected a file is uploaded once.
WeChat's `media/upload` accepts **file uploads only** — a URL is skipped with a warning, so download remote files first.

TTS requires `appConfig.tokens.wechat.speech_kit_token` (Yandex SpeechKit); without it `ctx.tts` is sent as plain text.

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
- Customer Service API requires the user to have messaged the account within the last 48 hours.
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
