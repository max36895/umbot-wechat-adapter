import { AppContext, BotController, IControllerApi, TEventType } from 'umbot';
import { BasePlatformAdapter, EMPTY_CONTEXT_ERROR, EMPTY_QUERY_ERROR, pUtils } from 'umbot/plugins';
import { buttonsToText } from './Button';
import { cardProcessing } from './Card';
import { soundProcessing } from './Sound';
import { T_WECHAT, WECHAT_MAX_TEXT_LENGTH } from './constants';
import { IWeChatRequestContent } from './IWeChatPlatform';
import { WeChatRequest } from './API/WeChatRequest';
import { makeWeChatApi } from './apiFacade';
import { verifyWeChatSignature } from './webhook';
import { truncateUtf8 } from './utils';

/**
 * Имена заголовков, в которых транспортный слой передаёт адаптеру параметры
 * подписи WeChat: сами они приходят в строке запроса, до которой адаптер
 * доступа не имеет (контракт `isCorrectQuery(query, headers)`).
 */
const SIGNATURE_HEADER = 'x-wechat-signature';
const TIMESTAMP_HEADER = 'x-wechat-timestamp';
const NONCE_HEADER = 'x-wechat-nonce';

/** Допустимое расхождение `timestamp` подписи с текущим временем по умолчанию, сек */
const DEFAULT_SIGNATURE_MAX_AGE = 300;

/**
 * Сколько сообщений Customer Service API можно отправить в ответ: 5 за 48 часов после
 * сообщения пользователя, 3 за минуту после подписки, нажатия меню или сканирования QR-кода.
 */
const MESSAGE_REPLY_LIMIT = 5;
const EVENT_REPLY_LIMIT = 3;
const USER_MESSAGE_EVENTS: ReadonlySet<TEventType> = new Set([
    'message',
    'voice',
    'photo',
    'video',
    'location',
]);

/**
 * Адаптер для WeChat Official Account.
 *
 * Поддерживает текст, голос (Recognition), события (subscribe/CLICK/SCAN/LOCATION),
 * изображения, видео, геолокацию и ссылки. Ответы отправляются через Customer
 * Service API, а на сам вебхук WeChat ждёт ответа не дольше 5 секунд — см. README.
 *
 * ⚠️ WeChat присылает вебхук в XML, а ядро umbot принимает только JSON, поэтому
 * встроенный сервер (`bot.start()`) с WeChat не работает. Разберите тело через
 * `parseWeChatXml()` и передайте объект в `bot.webhookEvent()` — пример в README.
 *
 * @example
 * ```ts
 * import { Bot } from 'umbot';
 * import { WeChatAdapter } from 'umbot-wechat-adapter';
 *
 * const bot = new Bot()
 *     .use(new WeChatAdapter(process.env.WECHAT_TOKEN, {
 *         app_id: process.env.WECHAT_APP_ID,
 *         app_secret: process.env.WECHAT_APP_SECRET,
 *     }))
 *     .addCommand('start', ['привет', 'hello'], (_text, ctx) => {
 *         ctx.text = 'Привет! Я бот для WeChat';
 *     });
 * ```
 */
export class WeChatAdapter extends BasePlatformAdapter<IWeChatRequestContent> {
    platformName = T_WECHAT;
    isVoice = false;
    limit = 50;
    signatureName = SIGNATURE_HEADER;

    /**
     * Универсальные события, которые адаптер выставляет в `controller.eventType`.
     * Источник знания для валидации `bot.addEvent(...)`: без этого списка ядро
     * предупреждало бы, что платформа не умеет 'photo', 'voice' и остальные.
     */
    supportedEvents: readonly TEventType[] = [
        'message',
        'voice',
        'photo',
        'video',
        'location',
        'callback',
        'start',
        'subscribed',
        'unsubscribed',
    ];

    /**
     * Оставлен для совместимости: имена пользователей больше не запрашиваются и не кэшируются.
     * @deprecated WeChat не возвращает никнейм в `user/info` с 27.12.2021.
     */
    static clearUserCache(): void {
        // Кэша больше нет — очищать нечего
    }

    init(appContext: AppContext): void {
        super.init(appContext);
        const tokens = appContext.appConfig.tokens[this.platformName];
        if (!tokens) {
            return;
        }
        if (this._token) {
            tokens.token = this._token;
        }
        if (this._platformOptions?.app_id) {
            tokens.app_id = this._platformOptions.app_id as string;
        }
        if (this._platformOptions?.app_secret) {
            tokens.app_secret = this._platformOptions.app_secret as string;
        }
        if (this._platformOptions?.fetch_user_info) {
            appContext.logWarn(
                'WeChatAdapter: опция fetch_user_info больше ничего не делает — с 27.12.2021 WeChat не возвращает никнейм в user/info. Уберите её из настроек.',
            );
        }
    }

    /**
     * API-фасад WeChat для `controller.api` (отправка фото/аудио).
     * @param controller Контроллер текущего запроса
     */
    createApi(controller: BotController): IControllerApi | null {
        return makeWeChatApi(controller);
    }

    isPlatformOnQuery(query: IWeChatRequestContent, headers?: Record<string, unknown>): boolean {
        if (headers?.[SIGNATURE_HEADER]) {
            return true;
        }
        if (!query) {
            this.appContext?.logWarn(`WeChatAdapter.isPlatformOnQuery(): ${EMPTY_QUERY_ERROR}`);
            return false;
        }
        return !!(
            query.ToUserName !== undefined &&
            query.FromUserName !== undefined &&
            query.MsgType !== undefined &&
            query.CreateTime !== undefined
        );
    }

    /**
     * Проверка подписи WeChat.
     *
     * WeChat подписывает запрос как `sha1(sort([token, timestamp, nonce]).join(''))`
     * и передаёт параметры в строке запроса. Базовая HMAC-SHA256-проверка от тела
     * (`BasePlatformAdapter.isCorrectQuery`) здесь не сойдётся никогда — с ней
     * адаптер отклонял бы все запросы платформы.
     *
     * Адаптеру доступны только заголовки, поэтому транспортный слой должен
     * продублировать параметры подписи в `x-wechat-signature`, `x-wechat-timestamp`,
     * `x-wechat-nonce` (см. README). Если `token` не настроен — проверка
     * пропускается, как и в ядре (opt-in).
     *
     * Подпись не покрывает тело запроса, поэтому `timestamp` старше `signature_max_age` секунд
     * (по умолчанию 300, 0 — без проверки) отклоняется: перехваченные параметры подписи
     * нельзя приложить к своему телу позже.
     *
     * @param _query Тело запроса (в схеме подписи WeChat не участвует)
     * @param headers Заголовки HTTP-запроса
     */
    isCorrectQuery(_query: unknown, headers?: Record<string, unknown>): boolean {
        if (!this.isSignatureCheckEnabled()) {
            return true;
        }
        const token = this.appContext?.appConfig.tokens[this.platformName]?.token as string;
        const maxAge = this._platformOptions?.signature_max_age;
        return verifyWeChatSignature(
            token,
            headers?.[SIGNATURE_HEADER] as string,
            headers?.[TIMESTAMP_HEADER] as string,
            headers?.[NONCE_HEADER] as string,
            typeof maxAge === 'number' ? maxAge : DEFAULT_SIGNATURE_MAX_AGE,
        );
    }

    isSignatureCheckEnabled(): boolean {
        return Boolean(this.appContext?.appConfig.tokens[this.platformName]?.token);
    }

    async setQueryData(query: IWeChatRequestContent, controller: BotController): Promise<boolean> {
        if (!this.appContext) {
            controller.platformOptions.error = `WeChatAdapter.setQueryData(): ${EMPTY_CONTEXT_ERROR}`;
            return false;
        }
        if (!query) {
            controller.platformOptions.error = `WeChatAdapter.setQueryData(): ${EMPTY_QUERY_ERROR}`;
            return false;
        }

        controller.requestObject = query;
        controller.userId = query.FromUserName;
        controller.appType = this.platformName;
        // messageId === 0 ядро трактует как начало диалога (welcome-интент).
        // У событий MsgId нет, поэтому нулём помечается только подписка,
        // остальным событиям отдаём CreateTime — иначе welcome срабатывал
        // на каждом нажатии пункта меню.
        controller.messageId = query.MsgId ?? (query.Event === 'subscribe' ? 0 : query.CreateTime);

        switch (query.MsgType) {
            case 'text':
                controller.userCommand = (query.Content || '').toLowerCase().trim();
                controller.originalUserCommand = (query.Content || '').trim();
                controller.eventType = 'message';
                break;

            case 'voice':
                // Recognition приходит только при включённом распознавании речи.
                controller.userCommand = (query.Recognition || '').toLowerCase().trim();
                controller.originalUserCommand = (query.Recognition || '').trim();
                controller.userMeta = { MediaId: query.MediaId, Format: query.Format };
                controller.eventType = 'voice';
                break;

            case 'event':
                this.#handleEvent(query, controller);
                break;

            case 'image':
                controller.userCommand = '[image]';
                controller.originalUserCommand = '[image]';
                controller.userMeta = { PicUrl: query.PicUrl, MediaId: query.MediaId };
                controller.eventType = 'photo';
                break;

            case 'video':
            case 'shortvideo':
                controller.userCommand = '[video]';
                controller.originalUserCommand = '[video]';
                controller.userMeta = { MediaId: query.MediaId, ThumbMediaId: query.ThumbMediaId };
                controller.eventType = 'video';
                break;

            case 'location':
                controller.userCommand = '[location]';
                controller.originalUserCommand = query.Label || '[location]';
                controller.userMeta = {
                    Location_X: query.Location_X,
                    Location_Y: query.Location_Y,
                    Scale: query.Scale,
                    Label: query.Label,
                };
                controller.eventType = 'location';
                break;

            case 'link':
                controller.userCommand = '[link]';
                controller.originalUserCommand = query.Title || '[link]';
                controller.userMeta = {
                    Url: query.Url,
                    Title: query.Title,
                    Description: query.Description,
                };
                controller.eventType = 'message';
                break;

            default:
                // Неизвестный тип сообщения: отвечать нечем, но и 400 отдавать нельзя —
                // WeChat повторит доставку. Помечаем запрос как не требующий ответа.
                this.appContext.logWarn(
                    `WeChatAdapter.setQueryData(): неизвестный MsgType "${query.MsgType}". Ответ не отправляется.`,
                );
                controller.skipAutoReply = true;
                controller.userCommand = `[${query.MsgType}]`;
                controller.originalUserCommand = `[${query.MsgType}]`;
                break;
        }

        return true;
    }

    #handleEvent(query: IWeChatRequestContent, controller: BotController): void {
        switch (query.Event) {
            case 'subscribe':
                controller.userCommand = 'start';
                controller.originalUserCommand = 'subscribe';
                // Подписка по QR-коду приносит сценарий в EventKey ("qrscene_<scene>").
                controller.payload = query.EventKey
                    ? { event: 'subscribe', scene: query.EventKey, ticket: query.Ticket }
                    : { event: 'subscribe' };
                controller.eventType = query.EventKey ? 'start' : 'subscribed';
                break;
            case 'unsubscribe':
                // Отписавшемуся отправить уже ничего нельзя.
                controller.skipAutoReply = true;
                controller.userCommand = 'unsubscribe';
                controller.originalUserCommand = 'unsubscribe';
                controller.eventType = 'unsubscribed';
                break;
            case 'SCAN':
                controller.userCommand = pUtils.normalizeActionPayload(query.EventKey);
                controller.originalUserCommand = query.EventKey || '';
                controller.payload = { event: 'SCAN', scene: query.EventKey, ticket: query.Ticket };
                controller.eventType = 'callback';
                break;
            case 'CLICK':
                // Нажатие пункта меню — ближайший аналог callback-кнопки.
                // normalizeActionPayload приводит 'buy' и '{"command":"buy"}' к 'buy',
                // чтобы сработали addAction/addCommand без ручного разбора.
                controller.userCommand = pUtils.normalizeActionPayload(query.EventKey);
                controller.originalUserCommand = query.EventKey || '';
                controller.payload = { event: 'CLICK', key: query.EventKey };
                controller.eventType = 'callback';
                break;
            case 'VIEW':
                // Переход по ссылке из меню: ответа не требует.
                controller.skipAutoReply = true;
                controller.eventType = 'callback';
                break;
            case 'LOCATION':
                controller.userCommand = '[location]';
                controller.originalUserCommand = '[location]';
                controller.userMeta = {
                    Latitude: query.Latitude,
                    Longitude: query.Longitude,
                    Precision: query.Precision,
                };
                controller.eventType = 'location';
                break;
            default:
                // Служебные события (TEMPLATESENDJOBFINISH, MASSSENDJOBFINISH и т.п.)
                // ответа не требуют. Раньше все они помечались как 'unsubscribed',
                // из-за чего срабатывали обработчики отписки.
                this.appContext?.logWarn(
                    `WeChatAdapter.setQueryData(): необработанное событие "${query.Event}". Ответ не отправляется.`,
                );
                controller.skipAutoReply = true;
                controller.userCommand = (query.Event || '').toLowerCase().trim();
                controller.originalUserCommand = query.Event || '';
                break;
        }
    }

    /**
     * ID доставки для дедупликации повторов. WeChat повторяет вебхук до трёх раз, если не
     * получил ответ за 5 секунд, а ответ ждёт отправки через Customer Service API.
     * Сообщения различаются по `MsgId` (так рекомендует WeChat), события — по отправителю,
     * времени и типу события: `MsgId` у них нет.
     * @param query Тело запроса
     * @returns ID доставки или null, если различить повтор не по чему
     */
    getDeliveryId(query: IWeChatRequestContent): string | null {
        if (query?.MsgId !== undefined && query.MsgId !== null) {
            return String(query.MsgId);
        }
        if (!query?.FromUserName || query.CreateTime === undefined) {
            return null;
        }
        return `${query.FromUserName}:${query.CreateTime}:${query.Event ?? query.MsgType}`;
    }

    /**
     * Собирает текст ответа: текст (или tts), подписи изображений и кнопки списком.
     *
     * Подписи идут в текст, потому что Customer Service API разрешает лишь несколько
     * сообщений на одно действие пользователя. Кнопки — тоже текстом: клавиатуры у API нет.
     * @param controller Контроллер запроса
     * @returns Текст ответа (пустая строка, если отправлять нечего)
     */
    #composeText(controller: BotController): string {
        // Только tts (логика, написанная под голосовые платформы) уходит текстом
        let text = pUtils.getChatText(controller.text, controller.tts);
        const images = controller.isCardInit() ? controller.card.images : [];
        const captions = images
            .map((image) => (image.title || image.desc || '').trim())
            .filter((caption) => caption && caption !== text);
        if (captions.length) {
            text = [text, ...captions].filter(Boolean).join('\n\n');
        }
        if (controller.isButtonsInit() && controller.buttons.buttons.length > 0) {
            const buttonsText = controller.buttons.getButtons<string>(buttonsToText);
            if (buttonsText) {
                text = text ? `${text}\n\n${buttonsText}` : buttonsText;
            }
        }
        return text;
    }

    /**
     * Отправляет ответ через Customer Service API.
     * @returns Пустую строку — тело HTTP-ответа WeChat. Пустой ответ WeChat принимает и не
     *   повторяет доставку; ответ в другом формате WeChat считает ошибкой сервера.
     */
    async getContent(controller: BotController): Promise<string> {
        if (controller.skipAutoReply) {
            return '';
        }
        const api = new WeChatRequest(this.appContext as AppContext);
        const text = this.#composeText(controller);
        const images = controller.isCardInit() ? controller.card.images : [];
        const soundCount =
            controller.isSoundInit() && controller.sound.sounds.length > 0
                ? controller.sound.sounds.length
                : 0;
        this.#warnReplyLimit(controller, (text ? 1 : 0) + images.length + soundCount);

        if (text) {
            await api.sendTextMessage(
                controller.userId as string,
                truncateUtf8(text, WECHAT_MAX_TEXT_LENGTH, '...'),
            );
        }

        if (images.length) {
            try {
                await controller.card.getCards(cardProcessing, controller);
            } catch (e) {
                this.appContext?.logError(
                    `WeChatAdapter.getContent(): ошибка отправки изображений: ${e instanceof Error ? e.message : String(e)}`,
                    { error: e },
                );
            }
        }

        // tts голосом не отправляется: SpeechKit отдаёт OGG/Opus, а WeChat принимает AMR и MP3
        if (soundCount) {
            try {
                await controller.sound.getSounds(controller.tts, soundProcessing, controller);
            } catch (e) {
                this.appContext?.logError(
                    `WeChatAdapter.getContent(): ошибка обработки звука: ${e instanceof Error ? e.message : String(e)}`,
                    { error: e },
                );
            }
        }

        if (!text && !images.length && !soundCount) {
            this.appContext?.logWarn(
                'WeChatAdapter.getContent(): ответ не содержит ни текста, ни tts, ни вложений — пользователю ничего не отправлено.',
            );
        }

        return '';
    }

    /**
     * Предупреждает, если ответ состоит из большего числа сообщений, чем WeChat разрешает
     * отправить на одно действие пользователя: лишние сообщения WeChat отклонит.
     * @param controller Контроллер запроса
     * @param count Сколько сообщений будет отправлено
     */
    #warnReplyLimit(controller: BotController, count: number): void {
        const limit =
            controller.eventType && USER_MESSAGE_EVENTS.has(controller.eventType)
                ? MESSAGE_REPLY_LIMIT
                : EVENT_REPLY_LIMIT;
        if (count > limit) {
            this.appContext?.logWarn(
                `WeChatAdapter.getContent(): ответ состоит из ${count} сообщений, а WeChat разрешает ${limit} на это действие пользователя — последние не дойдут. Сократите число картинок и звуков.`,
            );
        }
    }

    static isVoice(): boolean {
        return false;
    }

    getQueryExample(query: string, userId: string, count: number): Record<string, unknown> {
        return {
            ToUserName: 'gh_example_account',
            FromUserName: userId,
            CreateTime: Math.floor(Date.now() / 1000),
            MsgType: 'text',
            Content: query,
            MsgId: count,
        };
    }
}
