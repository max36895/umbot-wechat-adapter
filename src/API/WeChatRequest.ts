import {
    IWeChatResult,
    IWeChatMediaResult,
    IWeChatTokenResult,
    IWeChatUserInfo,
} from '../IWeChatPlatform';
import { AppContext, Request, Text } from 'umbot';
import { T_WECHAT } from '../constants';

/**
 * Формирует сообщение об ошибке запроса к API платформы.
 *
 * Дублирует хелпер ядра (`umbot/plugins`), чтобы адаптер собирался и с umbot 3.1.0–3.1.2,
 * где он ещё не был публичным.
 * @param error Текст ошибки или объект Error (`IRequestSend.err` — union из обоих)
 * @param path Имя класса/метода, из которого логируется ошибка
 * @param url URL запроса
 */
export function getErrorMsg(error: Error | string, path: string, url: string | null): string {
    return `[${path}]: Произошла ошибка при отправке запроса "${url}"\nОшибка: ${error}`;
}

/**
 * Формирует сообщение об ошибке при отсутствии токенов платформы.
 * @param platform Идентификатор платформы
 * @param methodName Имя метода, который попытался выполнить запрос без токена
 */
export function getErrorToken(platform: string, methodName: string): string {
    return `[${methodName}]: Не указан токен для платформы "${platform}". Убедитесь что приложение настроено корректно, и указаны все необходимые для работы токены.`;
}

const API_BASE = 'https://api.weixin.qq.com/cgi-bin';
const REQUEST_TIMEOUT = 5500;
// Токен обновляется за 5 минут до истечения, чтобы запрос не ушёл с токеном на грани срока
const TOKEN_REFRESH_MARGIN = 300;
// «Токен недействителен / истёк»: токен берётся заново, запрос повторяется один раз
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);

interface IWeChatTokenCache {
    token: string;
    time: number;
    expiresAt?: number;
}

interface IWeChatTokenStore {
    _access_token?: IWeChatTokenCache;
    [name: string]: unknown;
}

/**
 * Выполняющиеся запросы токена по хранилищам токенов: параллельные отправки ждут один
 * запрос, а не запрашивают каждая свой.
 */
const pendingTokens = new WeakMap<object, Promise<string | null>>();

/**
 * Класс для взаимодействия с WeChat Official Account API.
 *
 * access_token берётся методом `stable_token` в обычном режиме: повторный запрос не отзывает
 * уже выданный токен, поэтому несколько экземпляров бота не ломают токены друг другу.
 * Кэш живёт в `appContext.appConfig.tokens.wechat` и общий для всех экземпляров класса.
 * Если WeChat ответил, что токен недействителен (40001, 40014, 42001), токен сбрасывается
 * и запрос повторяется один раз.
 *
 * @example
 * ```ts
 * const wechat = new WeChatRequest(appContext);
 * await wechat.sendTextMessage('openid', 'Привет!');
 * const media = await wechat.uploadImage('/path/to/image.jpg');
 * ```
 */
export class WeChatRequest {
    readonly #request: Request;
    #error: object | string | null | undefined;
    #lastErrorCode: number | undefined;
    readonly #appContext: AppContext;

    /** Срок кэша access_token, если WeChat не вернул `expires_in`, сек */
    static readonly TOKEN_CACHE_DURATION = 6900;

    public constructor(appContext: AppContext) {
        this.#request = new Request(appContext);
        this.#request.maxTimeQuery = REQUEST_TIMEOUT;
        this.#error = null;
        this.#appContext = appContext;
    }

    /**
     * `errcode` последнего ответа WeChat с ошибкой; после успешного запроса — undefined.
     * Нужен, чтобы отличить, например, просроченный `media_id` (40007) от других ошибок.
     */
    public get lastErrorCode(): number | undefined {
        return this.#lastErrorCode;
    }

    #tokenStore(): IWeChatTokenStore {
        return (this.#appContext.appConfig.tokens[T_WECHAT] ?? {}) as IWeChatTokenStore;
    }

    /**
     * Возвращает access_token из кэша или запрашивает новый (один запрос на все параллельные вызовы).
     */
    async #getAccessToken(): Promise<string | null> {
        const store = this.#tokenStore();
        const cached = store._access_token;
        const expiresAt =
            cached?.expiresAt ?? (cached?.time ?? 0) + WeChatRequest.TOKEN_CACHE_DURATION * 1000;
        if (cached?.token && Date.now() < expiresAt) {
            return cached.token;
        }
        let pending = pendingTokens.get(store);
        if (!pending) {
            const created: Promise<string | null> = this.#fetchToken(store)
                .catch(() => null)
                .finally(() => {
                    if (pendingTokens.get(store) === created) {
                        pendingTokens.delete(store);
                    }
                });
            pending = created;
            pendingTokens.set(store, pending);
        }
        return pending;
    }

    /**
     * Запрашивает access_token методом `stable_token` (POST JSON, `force_refresh: false`).
     */
    async #fetchToken(store: IWeChatTokenStore): Promise<string | null> {
        const appId = store.app_id as string | undefined;
        const appSecret = store.app_secret as string | undefined;
        if (!appId || !appSecret) {
            this.#log(getErrorToken(T_WECHAT, 'getAccessToken'));
            return null;
        }
        // Отдельный Request: общий #request в этот момент может готовить другой вызов
        const request = new Request(this.#appContext);
        request.maxTimeQuery = REQUEST_TIMEOUT;
        request.header = Request.HEADER_JSON;
        request.post = {
            grant_type: 'client_credential',
            appid: appId,
            secret: appSecret,
            force_refresh: false,
        };
        const url = `${API_BASE}/stable_token`;
        const data = await request.send<IWeChatTokenResult>(url);
        const result = data.status ? (data.data as IWeChatTokenResult | undefined) : undefined;
        if (result?.access_token && !result.errcode) {
            WeChatRequest.#cacheToken(store, result);
            return result.access_token;
        }
        this.#error = result ?? null;
        this.#log(
            result?.errmsg ? `getAccessToken(): ${result.errmsg}` : data.err || 'getAccessToken()',
            url,
        );
        return null;
    }

    /**
     * Сохраняет токен в кэш со сроком `expires_in` минус запас на обновление.
     * Параллельные запросы токена объединены в один (`pendingTokens`), поэтому запись не гонится.
     */
    static #cacheToken(store: IWeChatTokenStore, result: IWeChatTokenResult): void {
        const expiresIn =
            result.expires_in > 0
                ? result.expires_in
                : WeChatRequest.TOKEN_CACHE_DURATION + TOKEN_REFRESH_MARGIN;
        const now = Date.now();
        store._access_token = {
            token: result.access_token,
            time: now,
            expiresAt: now + Math.max(expiresIn - TOKEN_REFRESH_MARGIN, 60) * 1000,
        };
    }

    /**
     * Сбрасывает кэш, если в нём всё ещё тот токен, который WeChat отверг.
     */
    #invalidateToken(token: string): void {
        const store = this.#tokenStore();
        if (store._access_token?.token === token) {
            delete store._access_token;
        }
    }

    /**
     * Выполняет запрос к API с access_token. При ошибке токена берёт новый и повторяет один раз.
     * @param method Путь метода (можно с query: `media/upload?type=image`)
     * @param prepare Заполняет запрос (тело, файл, метод) — вызывается перед каждой попыткой:
     *   Request очищает поля после отправки
     * @param isSuccess Признак успешного ответа
     * @returns Ответ WeChat или null при ошибке
     */
    async #callApi<T extends Partial<IWeChatResult>>(
        method: string,
        prepare: (request: Request) => void,
        isSuccess: (result: T) => boolean,
    ): Promise<T | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.#getAccessToken();
            if (!token) {
                return null;
            }
            prepare(this.#request);
            const separator = method.includes('?') ? '&' : '?';
            const data = await this.#request.send<T>(
                `${API_BASE}/${method}${separator}access_token=${encodeURIComponent(token)}`,
            );
            if (!data.status || !data.data) {
                this.#lastErrorCode = undefined;
                this.#log(data.err);
                return null;
            }
            const result = data.data as T;
            if (isSuccess(result)) {
                this.#lastErrorCode = undefined;
                return result;
            }
            this.#error = result;
            this.#lastErrorCode = result.errcode;
            if (attempt === 0 && TOKEN_ERROR_CODES.has(result.errcode ?? 0)) {
                this.#invalidateToken(token);
                continue;
            }
            this.#log(`${method}: errcode=${result.errcode}, errmsg=${result.errmsg}`);
            return null;
        }
        return null;
    }

    /**
     * Отправляет сообщение через Customer Service API (`message/custom/send`).
     */
    #sendMessage(body: Record<string, unknown>): Promise<IWeChatResult | null> {
        return this.#callApi<IWeChatResult>(
            'message/custom/send',
            (request) => {
                request.header = Request.HEADER_JSON;
                request.post = body;
            },
            (result) => result.errcode === 0,
        );
    }

    /** Отправка текстового сообщения через Customer Service API */
    public async sendTextMessage(openId: string, text: string): Promise<IWeChatResult | null> {
        return this.#sendMessage({ touser: openId, msgtype: 'text', text: { content: text } });
    }

    /** Отправка изображения через Customer Service API */
    public async sendImage(openId: string, mediaId: string): Promise<IWeChatResult | null> {
        return this.#sendMessage({
            touser: openId,
            msgtype: 'image',
            image: { media_id: mediaId },
        });
    }

    /** Отправка голосового сообщения через Customer Service API */
    public async sendVoice(openId: string, mediaId: string): Promise<IWeChatResult | null> {
        return this.#sendMessage({
            touser: openId,
            msgtype: 'voice',
            voice: { media_id: mediaId },
        });
    }

    /** Загрузка изображения во временное хранилище WeChat (PNG/JPEG/GIF, до 10 МБ) */
    public async uploadImage(file: string): Promise<IWeChatMediaResult | null> {
        return this.#uploadMedia('image', file);
    }

    /** Загрузка голосового файла во временное хранилище (AMR/MP3, до 2 МБ и 60 секунд) */
    public async uploadVoice(file: string): Promise<IWeChatMediaResult | null> {
        return this.#uploadMedia('voice', file);
    }

    /**
     * Загружает медиафайл во временное хранилище WeChat (media/upload).
     *
     * WeChat принимает только multipart-загрузку файла: URL здесь не поддерживается,
     * поэтому удалённый файл сначала нужно скачать к себе. Временный `media_id` живёт 3 дня.
     */
    async #uploadMedia(type: 'image' | 'voice', file: string): Promise<IWeChatMediaResult | null> {
        if (Text.isUrl(file)) {
            this.#appContext.logWarn(
                `[WeChatRequest.upload${type === 'image' ? 'Image' : 'Voice'}()]: WeChat media/upload принимает только загрузку файла (multipart). Ссылка "${file}" пропущена — скачайте файл локально и передайте путь.`,
            );
            return null;
        }
        return this.#callApi<IWeChatMediaResult>(
            `media/upload?type=${type}`,
            (request) => {
                request.attach = file;
                request.attachName = 'media';
            },
            (result) => Boolean(result.media_id),
        );
    }

    /**
     * Получение информации о пользователе по OpenID.
     *
     * С 27.12.2021 WeChat не возвращает здесь никнейм и аватар — только подписку,
     * язык, время подписки, `unionid` и метки.
     */
    public async getUserInfo(openId: string): Promise<IWeChatUserInfo | null> {
        return this.#callApi<IWeChatUserInfo>(
            `user/info?openid=${encodeURIComponent(openId)}`,
            (request) => {
                request.customRequest = 'GET';
            },
            (result) => Boolean(result.openid) && !result.errcode,
        );
    }

    #log(error: Error | string = '', url: string | null = this.#request.url): void {
        this.#appContext.logError(getErrorMsg(error, 'WeChatRequest', url), {
            error: this.#error,
        });
    }
}
