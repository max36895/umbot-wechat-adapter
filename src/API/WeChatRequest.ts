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

interface IWeChatToken {
    _access_token: { token: string; time: number } | undefined;
    [name: string]: string | number | unknown;
}

/**
 * Класс для взаимодействия с WeChat Official Account API.
 * Автоматически управляет access_token (кэш 6900 сек).
 *
 * Кэш access_token живёт в `appContext.appConfig.tokens.wechat`, поэтому он общий
 * для всех инстансов класса в рамках приложения.
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
    readonly #appContext: AppContext;

    /** Кэш access_token на 6900 сек (меньше 7200 с запасом) */
    static readonly TOKEN_CACHE_DURATION = 6900;

    public constructor(appContext: AppContext) {
        this.#request = new Request(appContext);
        this.#request.maxTimeQuery = 5500;
        this.#error = null;
        this.#appContext = appContext;
    }

    /**
     * Получает или обновляет access_token. Кэшируется в AppContext.
     */
    async #getAccessToken(): Promise<string | null> {
        const tokenStore = (this.#appContext.appConfig.tokens[T_WECHAT] ?? {}) as IWeChatToken;
        const cached = tokenStore._access_token as { token: string; time: number } | undefined;

        if (cached?.token && Date.now() - cached.time < WeChatRequest.TOKEN_CACHE_DURATION * 1000) {
            return cached.token;
        }

        const appId = tokenStore.app_id as string;
        const appSecret = tokenStore.app_secret as string;

        if (!appId || !appSecret) {
            this.#log(getErrorToken(T_WECHAT, 'getAccessToken'));
            return null;
        }

        const url = `${API_BASE}/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;

        const data = await this.#request.send<IWeChatTokenResult>(url);

        if (data.status && data.data) {
            const result = data.data as IWeChatTokenResult;
            if (result.access_token && result.errcode === undefined) {
                tokenStore._access_token = {
                    token: result.access_token,
                    time: Date.now(),
                };
                return result.access_token;
            }
            this.#error = data.data;
            this.#log(`getAccessToken(): ${result.errmsg || 'Ошибка получения токена'}`);
        } else {
            this.#log(data.err || 'getAccessToken(): Ошибка HTTP-запроса');
        }
        return null;
    }

    /** Отправка текстового сообщения через Customer Service API */
    public async sendTextMessage(openId: string, text: string): Promise<IWeChatResult | null> {
        const accessToken = await this.#getAccessToken();
        if (!accessToken) return null;

        this.#request.post = {
            touser: openId,
            msgtype: 'text',
            text: { content: text },
        };
        return this.#call('message/custom/send', accessToken);
    }

    /** Отправка изображения через Customer Service API */
    public async sendImage(openId: string, mediaId: string): Promise<IWeChatResult | null> {
        const accessToken = await this.#getAccessToken();
        if (!accessToken) return null;

        this.#request.post = {
            touser: openId,
            msgtype: 'image',
            image: { media_id: mediaId },
        };
        return this.#call('message/custom/send', accessToken);
    }

    /** Отправка голосового сообщения через Customer Service API */
    public async sendVoice(openId: string, mediaId: string): Promise<IWeChatResult | null> {
        const accessToken = await this.#getAccessToken();
        if (!accessToken) return null;

        this.#request.post = {
            touser: openId,
            msgtype: 'voice',
            voice: { media_id: mediaId },
        };
        return this.#call('message/custom/send', accessToken);
    }

    /** Загрузка изображения во временное хранилище WeChat */
    public async uploadImage(file: string): Promise<IWeChatMediaResult | null> {
        return this.#uploadMedia('image', file);
    }

    /** Загрузка голосового файла (AMR/SILK) во временное хранилище */
    public async uploadVoice(file: string): Promise<IWeChatMediaResult | null> {
        return this.#uploadMedia('voice', file);
    }

    /**
     * Загружает медиафайл во временное хранилище WeChat (media/upload).
     *
     * WeChat принимает только multipart-загрузку файла: URL здесь не поддерживается,
     * поэтому удалённый файл сначала нужно скачать к себе.
     */
    async #uploadMedia(type: 'image' | 'voice', file: string): Promise<IWeChatMediaResult | null> {
        const accessToken = await this.#getAccessToken();
        if (!accessToken) return null;

        if (Text.isUrl(file)) {
            // Раньше сюда уходил post {url}, который WeChat молча игнорировал,
            // и media_id никогда не возвращался.
            this.#appContext.logWarn(
                `[WeChatRequest.upload${type === 'image' ? 'Image' : 'Voice'}()]: WeChat media/upload принимает только загрузку файла (multipart). Ссылка "${file}" пропущена — скачайте файл локально и передайте путь.`,
            );
            return null;
        }

        this.#request.attach = file;
        this.#request.attachName = 'media';
        return this.#callMedia(`media/upload?type=${type}`, accessToken);
    }

    /** Получение информации о пользователе по OpenID */
    public async getUserInfo(openId: string): Promise<IWeChatUserInfo | null> {
        const accessToken = await this.#getAccessToken();
        if (!accessToken) return null;

        const url = `${API_BASE}/user/info?access_token=${encodeURIComponent(accessToken)}&openid=${encodeURIComponent(openId)}&lang=ru_RU`;
        this.#request.customRequest = 'GET';

        const data = await this.#request.send<IWeChatUserInfo>(url);

        if (data.status && data.data) {
            const result = data.data as IWeChatUserInfo;
            if (result.openid && result.errcode === undefined) {
                return result;
            }
            this.#log(
                `getUserInfo(): ${(result as unknown as IWeChatResult).errmsg || 'Ошибка получения user info'}`,
            );
        } else {
            this.#log(data.err || 'getUserInfo(): Ошибка HTTP');
        }
        return null;
    }

    async #call(method: string, accessToken: string): Promise<IWeChatResult | null> {
        const url = `${API_BASE}/${method}?access_token=${encodeURIComponent(accessToken)}`;
        this.#request.header = Request.HEADER_JSON;
        const data = await this.#request.send<IWeChatResult>(url);

        if (data.status && data.data) {
            const result = data.data as IWeChatResult;
            if (result.errcode === 0) {
                return result;
            }
            this.#error = data.data;
            this.#log(`call("${method}"): errcode=${result.errcode}, errmsg=${result.errmsg}`);
            return null;
        }
        this.#log(data.err);
        return null;
    }

    async #callMedia(method: string, accessToken: string): Promise<IWeChatMediaResult | null> {
        const url = `${API_BASE}/${method}&access_token=${encodeURIComponent(accessToken)}`;
        const data = await this.#request.send<IWeChatMediaResult>(url);

        if (data.status && data.data) {
            const result = data.data as IWeChatMediaResult;
            if (result.media_id) {
                return result;
            }
            this.#error = data.data;
            this.#log(`callMedia("${method}"): errcode=${result.errcode}, errmsg=${result.errmsg}`);
            return null;
        }
        this.#log(data.err);
        return null;
    }

    #log(error: Error | string = ''): void {
        this.#appContext.logError(getErrorMsg(error, 'WeChatRequest', this.#request.url), {
            error: this.#error,
        });
    }
}
