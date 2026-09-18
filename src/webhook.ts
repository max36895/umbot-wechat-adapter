import { createHash, timingSafeEqual } from 'crypto';
import { IWeChatRequestContent } from './IWeChatPlatform';

/**
 * Хелперы транспортного слоя WeChat.
 *
 * WeChat присылает вебхук в XML и подписывает его параметрами строки запроса
 * (`signature`, `timestamp`, `nonce`), а ядро umbot принимает только JSON-тело
 * POST-запроса. Поэтому разбор XML и проверка подписи выполняются до передачи
 * запроса в `bot.webhookEvent()` — этими функциями.
 *
 * @see https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html
 */

const CDATA_REG = /^<!\[CDATA\[([\s\S]*)]]>$/;
const NODE_REG = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
const ROOT_REG = /<xml[^>]*>([\s\S]*)<\/xml>/;

/**
 * Разбирает XML-тело входящего сообщения WeChat в плоский объект.
 *
 * WeChat присылает ровно один уровень вложенности внутри `<xml>`, поэтому
 * полноценный XML-парсер (и зависимость на него) не нужен. Значения в `<![CDATA[…]]>`
 * разворачиваются, числовые поля (`CreateTime`, `MsgId`) приводятся к числу.
 *
 * @param xml Сырое тело POST-запроса от WeChat
 * @returns Объект запроса либо `null`, если это не похоже на сообщение WeChat
 *
 * @example
 * ```ts
 * const query = parseWeChatXml(rawBody);
 * if (query) {
 *     await bot.webhookEvent(query, { 'x-wechat-signature': signature });
 * }
 * ```
 */
export function parseWeChatXml(xml: string): IWeChatRequestContent | null {
    if (!xml || typeof xml !== 'string' || !xml.includes('<xml')) {
        return null;
    }
    // Сначала снимаем корневой <xml>: иначе ленивый поиск полей матчит сам корень
    // и возвращает одно «поле» xml со всем телом внутри.
    const root = ROOT_REG.exec(xml);
    if (!root) {
        return null;
    }
    const result: Record<string, unknown> = {};
    for (const match of root[1].matchAll(NODE_REG)) {
        const key = match[1];
        // Служебные ключи прототипа в имени тега означают попытку инъекции,
        // а не поле протокола WeChat.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            continue;
        }
        const raw = (match[2] ?? '').trim();
        const cdata = CDATA_REG.exec(raw);
        const value = cdata ? cdata[1] : raw;
        result[key] =
            (key === 'CreateTime' || key === 'MsgId') && value !== '' && !isNaN(Number(value))
                ? Number(value)
                : value;
    }
    if (result.ToUserName === undefined || result.FromUserName === undefined) {
        return null;
    }
    return result as unknown as IWeChatRequestContent;
}

/**
 * Проверяет подпись запроса WeChat.
 *
 * Схема WeChat: `sha1(sort([token, timestamp, nonce]).join(''))` — это НЕ HMAC-SHA256
 * от тела, поэтому базовая проверка `BasePlatformAdapter.isCorrectQuery()` для WeChat
 * не подходит и переопределена в адаптере.
 *
 * @param token Token из кабинета Official Account
 * @param signature Параметр `signature` из строки запроса
 * @param timestamp Параметр `timestamp` из строки запроса
 * @param nonce Параметр `nonce` из строки запроса
 * @returns `true`, если подпись совпала
 */
export function verifyWeChatSignature(
    token: string,
    signature: string | undefined | null,
    timestamp: string | undefined | null,
    nonce: string | undefined | null,
): boolean {
    if (!token || !signature || !timestamp || !nonce) {
        return false;
    }
    const expected = createHash('sha1')
        .update([token, String(timestamp), String(nonce)].sort().join(''))
        .digest('hex');
    try {
        const received = Buffer.from(String(signature));
        const expectedBuffer = Buffer.from(expected);
        if (received.length !== expectedBuffer.length) {
            return false;
        }
        return timingSafeEqual(received, expectedBuffer);
    } catch {
        return false;
    }
}

/**
 * Обрабатывает GET-запрос верификации URL из кабинета WeChat.
 *
 * WeChat проверяет вебхук GET-запросом с `signature/timestamp/nonce/echostr`
 * и ждёт в ответ ровно `echostr`. Ядро umbot принимает только POST, поэтому
 * этот запрос обрабатывается транспортным слоем.
 *
 * @param token Token из кабинета Official Account
 * @param params Параметры строки запроса
 * @returns Строку `echostr` при успешной проверке либо `null`
 *
 * @example
 * ```ts
 * const echo = handleWeChatVerification(TOKEN, req.query);
 * if (echo !== null) {
 *     res.end(echo);
 *     return;
 * }
 * ```
 */
export function handleWeChatVerification(
    token: string,
    params: Record<string, string | string[] | undefined>,
): string | null {
    const first = (value: string | string[] | undefined): string | undefined =>
        Array.isArray(value) ? value[0] : value;
    const echostr = first(params.echostr);
    if (!echostr) {
        return null;
    }
    if (
        !verifyWeChatSignature(
            token,
            first(params.signature),
            first(params.timestamp),
            first(params.nonce),
        )
    ) {
        return null;
    }
    return echostr;
}
