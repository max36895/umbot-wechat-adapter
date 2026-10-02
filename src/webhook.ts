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

/**
 * Максимальная длина XML-тела (в символах), которое разбирает `parseWeChatXml`.
 * Сообщения WeChat занимают единицы килобайт; более длинное тело — не сообщение платформы.
 */
export const WECHAT_MAX_XML_LENGTH = 1024 * 1024;

const CDATA_START = '<![CDATA[';
const CDATA_END = ']]>';
const TAG_NAME_REG = /^[A-Za-z_][\w.-]*$/;
// Через эти ключи можно добраться до прототипа: это попытка инъекции, а не поле WeChat
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Разбирает содержимое корневого `<xml>` в пары «тег → значение» за один проход.
 * Каждый поиск идёт вперёд от текущей позиции, а незакрытый тег завершает разбор:
 * так время линейно от длины тела даже на специально собранном вредном вводе.
 * Вложенный элемент (например, `ScanCodeInfo`) сохраняется строкой со своей разметкой.
 */
function parseFlatXml(inner: string): Record<string, string> {
    const result: Record<string, string> = {};
    let pos = 0;
    while (pos < inner.length) {
        const open = inner.indexOf('<', pos);
        const openEnd = open === -1 ? -1 : inner.indexOf('>', open);
        if (openEnd === -1) {
            break;
        }
        const name = inner.slice(open + 1, openEnd);
        pos = openEnd + 1;
        if (!TAG_NAME_REG.test(name)) {
            continue;
        }
        const closeTag = `</${name}>`;
        let value: string;
        if (inner.startsWith(CDATA_START, pos)) {
            const cdataEnd = inner.indexOf(CDATA_END, pos + CDATA_START.length);
            if (cdataEnd === -1) {
                break;
            }
            value = inner.slice(pos + CDATA_START.length, cdataEnd);
            pos = cdataEnd + CDATA_END.length;
            if (!inner.startsWith(closeTag, pos)) {
                continue;
            }
        } else {
            const close = inner.indexOf(closeTag, pos);
            if (close === -1) {
                break;
            }
            value = inner.slice(pos, close).trim();
            pos = close;
        }
        pos += closeTag.length;
        if (!FORBIDDEN_KEYS.has(name)) {
            result[name] = value;
        }
    }
    return result;
}

/**
 * Разбирает XML-тело входящего сообщения WeChat в плоский объект.
 *
 * WeChat присылает поля одним уровнем внутри `<xml>`, поэтому полноценный XML-парсер
 * (и зависимость на него) не нужен. Значения в `<![CDATA[…]]>` разворачиваются,
 * `CreateTime` приводится к числу. `MsgId` — 64-битное целое: числом он остаётся,
 * только пока помещается в `Number.MAX_SAFE_INTEGER`, иначе — строкой (округлённые
 * соседние id совпали бы, и дедупликация отбросила бы новое сообщение как повтор).
 *
 * @param xml Сырое тело POST-запроса от WeChat
 * @returns Объект запроса либо `null`, если это не похоже на сообщение WeChat
 *   или тело длиннее {@link WECHAT_MAX_XML_LENGTH}
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
    if (!xml || typeof xml !== 'string' || xml.length > WECHAT_MAX_XML_LENGTH) {
        return null;
    }
    // Сначала снимаем корневой <xml>: иначе он попал бы в результат одним полем со всем телом
    const rootStart = xml.indexOf('<xml');
    const innerStart = rootStart === -1 ? -1 : xml.indexOf('>', rootStart) + 1;
    const innerEnd = xml.lastIndexOf('</xml>');
    if (innerStart <= 0 || innerEnd < innerStart) {
        return null;
    }
    const fields = parseFlatXml(xml.slice(innerStart, innerEnd));
    if (fields.ToUserName === undefined || fields.FromUserName === undefined) {
        return null;
    }
    const result: Record<string, unknown> = { ...fields };
    if (fields.CreateTime !== undefined && fields.CreateTime !== '') {
        const createTime = Number(fields.CreateTime);
        if (!isNaN(createTime)) {
            result.CreateTime = createTime;
        }
    }
    if (fields.MsgId !== undefined && fields.MsgId !== '') {
        const msgId = Number(fields.MsgId);
        if (Number.isSafeInteger(msgId)) {
            result.MsgId = msgId;
        }
    }
    return result as unknown as IWeChatRequestContent;
}

/**
 * Проверяет подпись запроса WeChat.
 *
 * Схема WeChat: `sha1(sort([token, timestamp, nonce]).join(''))` — это НЕ HMAC-SHA256
 * от тела, поэтому базовая проверка `BasePlatformAdapter.isCorrectQuery()` для WeChat
 * не подходит и переопределена в адаптере. Тело запроса подпись не покрывает: тройку
 * параметров, попавшую в чужой лог (например, лог прокси со строкой запроса), можно
 * приложить к любому телу. `maxAgeSec` ограничивает время, когда такая подстановка возможна.
 *
 * @param token Token из кабинета Official Account
 * @param signature Параметр `signature` из строки запроса
 * @param timestamp Параметр `timestamp` из строки запроса (секунды Unix)
 * @param nonce Параметр `nonce` из строки запроса
 * @param maxAgeSec Допустимое расхождение `timestamp` с текущим временем, сек; не задан или 0 — не проверяется
 * @returns `true`, если подпись совпала (и `timestamp` свежий, если задан `maxAgeSec`)
 *
 * @example
 * ```ts
 * verifyWeChatSignature(TOKEN, params.signature, params.timestamp, params.nonce, 300);
 * ```
 */
export function verifyWeChatSignature(
    token: string,
    signature: string | undefined | null,
    timestamp: string | undefined | null,
    nonce: string | undefined | null,
    maxAgeSec?: number,
): boolean {
    if (!token || !signature || !timestamp || !nonce) {
        return false;
    }
    if (maxAgeSec) {
        const age = Math.abs(Date.now() / 1000 - Number(timestamp));
        if (!Number.isFinite(age) || age > maxAgeSec) {
            return false;
        }
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
