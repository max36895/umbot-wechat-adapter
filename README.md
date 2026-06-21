# WeChat Adapter for umbot

[![npm version](https://img.shields.io/npm/v/umbot-wechat-adapter.svg)](https://www.npmjs.com/package/umbot-wechat-adapter)
[![npm downloads](https://img.shields.io/npm/dm/umbot-wechat-adapter.svg)](https://www.npmjs.com/package/umbot-wechat-adapter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![umbot](https://img.shields.io/badge/umbot-adapter-blue)](https://github.com/max36895/universal_bot-ts)

> **TL;DR:** `umbot-adapter-wechat` is a bridge between the **umbot** platform and **WeChat (Weixin)**. It allows developers to build WeChat bots using the unified umbot API, handling all WeChat-specific XML parsing, signature verification, and message routing under the hood.

## 📖 About

Building bots for WeChat requires dealing with its specific XML-based message format, cryptographic signature checks, and strict API rules. This adapter abstracts all that complexity away.

By using this adapter, you can write your bot logic once using **umbot** and deploy it to WeChat without changing your core business logic.

### Key Features

- 🔄 **Unified API:** Use standard umbot methods (`sendMessage`, `onMessage`, etc.).
- 🔐 **Auto-Verification:** Handles WeChat server URL verification and message signature validation automatically.
- 📦 **XML Parsing:** Transparently converts WeChat XML payloads into standard umbot JSON objects.
- 🚀 **Webhook & Polling:** Supports both passive webhook replies and active API calls.
- 🛡️ **Type-Safe:** Written in TypeScript with full type definitions.

---

## 🚀 Quick Start

### 1. Installation

Install the adapter and the core umbot platform via npm:

```bash
npm install umbot umbot-wechat-adapter
# or
yarn add umbot umbot-wechat-adapter
```

### 2. Basic Usage

Here is a minimal example of how to initialize the WeChat adapter and handle incoming text messages.

```ts
import { Bot } from 'umbot';
import { WeChatAdapter } from 'umbot-wechat-adapter';

// Initialize the adapter with your WeChat Official Account credentials
const wechatAdapter = new WeChatAdapter({
    token: process.env.WECHAT_TOKEN,
    appId: process.env.WECHAT_APP_ID,
    appSecret: process.env.WECHAT_APP_SECRET,
});

// Initialize umbot with the adapter
const bot = new Bot();
bot.use(wechatAdapter);

// Handle incoming text messages
bot.addCommand('hello', ['hi', 'hello'], (userCommand, ctx) => {
    ctx.text = `Hello from umbot! You said: ${userCommand}`;
});

// Start the bot (starts the webhook server or polling depending on config)
bot.start();
```

## ⚙️ Configuration

The WeChatAdapter requires specific credentials from your WeChat Official Account (Subscription or Service account).

| Parameter   | Type                   | Required | Description                                                                                |
| ----------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------ |
| token       | string                 | ✅       | The Token you set in the WeChat Official Account backend. Used for signature verification. |
| appId       | string                 | ✅       | Your WeChat AppID.                                                                         |
| appSecret   | string                 | ✅       | Your WeChat AppSecret. Used to fetch access tokens.                                        |
| mode        | 'webhook' \| 'polling' | ❌       | Connection mode. Defaults to 'webhook'.                                                    |
| webhookPath | string                 | ❌       | The path for the webhook endpoint. Defaults to '/wechat'.                                  |

## 🏗 Architecture & How it Works

1. Inbound Flow: WeChat sends an HTTP POST request with an XML payload to your server.
2. Adapter Processing: umbot-adapter-wechat intercepts the request, verifies the cryptographic signature, and parses the XML.
3. umbot Context: The parsed data is transformed into a standard umbot Context object and emitted as an event (e.g., message:text).
4. Outbound Flow: When you call ctx.reply(), the adapter formats the response, fetches/caches the WeChat access_token, and sends it via the WeChat API.

## ❓ FAQ & Troubleshooting

Q: I'm getting a Signature verification failed error.

A: This usually happens during the initial WeChat server setup. Ensure that:
The token in your adapter config exactly matches the Token in the WeChat backend.
Your server is publicly accessible and returning the correct echostr during the GET verification request.
Q: Does this adapter support WeChat Mini Programs?

A: Currently, this adapter is optimized for WeChat Official Accounts (Messaging). Mini Program support requires a different authentication flow and is planned for v2.0.
Q: How are Access Tokens managed?

A: The adapter automatically fetches the access_token using your appId and appSecret. It caches the token in memory and refreshes it 5 minutes before expiration to prevent API rate limits.

## 🔗 Ecosystem

This package is part of the umbot ecosystem:

- [umbot](https://github.com/max36895/universal_bot-ts) - The core universal bot framework (Telegram, VK, web, etc.).
- umbot-knex-adapter - SQL Database adapter (this package).

## 📄 License

Distributed under the MIT License. See LICENSE for more information.
