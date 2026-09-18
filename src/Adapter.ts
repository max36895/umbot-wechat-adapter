import { AppContext, BotController, IControllerApi, TEventType, Text } from 'umbot';
import { BasePlatformAdapter, EMPTY_CONTEXT_ERROR, EMPTY_QUERY_ERROR, pUtils } from 'umbot/plugins';
import { buttonsToText } from './Button';
import { cardProcessing } from './Card';
import { soundProcessing } from './Sound';
import { T_WECHAT, WECHAT_MAX_TEXT_LENGTH } from './constants';
import { IWeChatRequestContent } from './IWeChatPlatform';
import { WeChatRequest } from './API/WeChatRequest';
import { makeWeChatApi } from './apiFacade';
import { verifyWeChatSignature } from './webhook';

/**
 * Имена заголовков, в которых транспортный слой передаёт адаптеру параметры
 * подписи WeChat: сами они приходят в строке запроса, до которой адаптер
 * доступа не имеет (контракт `isCorrectQuery(query, headers)`).
 */
const SIGNATURE_HEADER = 'x-wechat-signature';
const TIMESTAMP_HEADER = 'x-wechat-timestamp';
const NONCE_HEADER = 'x-wechat-nonce';

/**
 * Адаптер для WeChat Official Account.
 *
 * Поддерживает текст, голос (Recognition), события (subscribe/CLICK/SCAN/LOCATION),
 * изображения, видео, геолокацию и ссылки. Ответы отправляются через Customer
 * Service API (без ограничения 5 сек пассивного ответа).
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
     * Кэш имён пользователей: у `user/info` жёсткий суточный лимит на стороне
     * WeChat, а запрос делается на каждое входящее сообщение.
     */
    static #userInfoCache = new Map<string, string | null>();

    /**
     * Сбрасывает кэш данных пользователей WeChat.
     * Нужен в тестах и при смене Official Account в рамках одного процесса.
     */
    static clearUserCache(): void {
        WeChatAdapter.#userInfoCache.clear();
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
     * @param _query Тело запроса (в схеме подписи WeChat не участвует)
     * @param headers Заголовки HTTP-запроса
     */
    isCorrectQuery(_query: unknown, headers?: Record<string, unknown>): boolean {
        if (!this.isSignatureCheckEnabled()) {
            return true;
        }
        const token = this.appContext?.appConfig.tokens[this.platformName]?.token as string;
        return verifyWeChatSignature(
            token,
            headers?.[SIGNATURE_HEADER] as string,
            headers?.[TIMESTAMP_HEADER] as string,
            headers?.[NONCE_HEADER] as string,
        );
    }

    isSignatureCheckEnabled(): boolean {
        return Boolean(this.appContext?.appConfig.tokens[this.platformName]?.token);
    }

    async setQueryData(query: IWeChatRequestContent, controller: BotController): Promise<boolean> {
        if (!this.appContext) {
            console.log(`WeChatAdapter.setQueryData(): ${EMPTY_CONTEXT_ERROR}`);
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

        await this.#setUserInfo(query.FromUserName, controller);

        return true;
    }

    /**
     * Заполняет данные отправителя в NLU.
     *
     * Запрос к `user/info` — лишний сетевой round-trip на каждое сообщение, поэтому
     * он выполняется только при `options.fetch_user_info: true` и кэшируется на
     * время жизни процесса.
     */
    async #setUserInfo(openId: string, controller: BotController): Promise<void> {
        if (!this._platformOptions?.fetch_user_info) {
            return;
        }
        try {
            let nickname = WeChatAdapter.#userInfoCache.get(openId);
            if (nickname === undefined) {
                const userInfo = await new WeChatRequest(this.appContext as AppContext).getUserInfo(
                    openId,
                );
                nickname = userInfo?.nickname || null;
                WeChatAdapter.#userInfoCache.set(openId, nickname);
            }
            pUtils.setThisUserToNlu(controller, {
                username: null,
                first_name: nickname,
                last_name: null,
            });
        } catch (e) {
            // Не прерываем обработку запроса, если getUserInfo упал.
            this.appContext?.logWarn(
                `WeChatAdapter.setQueryData(): не удалось получить данные пользователя: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
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

    async getContent(controller: BotController): Promise<string> {
        if (controller.skipAutoReply) {
            return 'ok';
        }
        const api = new WeChatRequest(this.appContext as AppContext);

        // Если бизнес-логика заполнила только tts (типично для логики, писавшейся
        // под голосовые платформы), отправляем его как текст.
        let text = pUtils.getChatText(controller.text, controller.tts);

        // У Customer Service API нет клавиатуры — варианты ответа дописываем
        // списком в текст, иначе кнопки, заданные бизнес-логикой, просто теряются.
        const hasButtons = controller.isButtonsInit() && controller.buttons.buttons.length > 0;
        if (hasButtons) {
            const buttonsText = controller.buttons.getButtons<string>(buttonsToText);
            if (buttonsText) {
                text = text ? `${text}\n\n${buttonsText}` : buttonsText;
            }
        }

        if (text) {
            await api.sendTextMessage(
                controller.userId as string,
                Text.resize(text, WECHAT_MAX_TEXT_LENGTH),
            );
        }

        const hasCards = controller.isCardInit() && controller.card.images.length > 0;
        if (hasCards) {
            try {
                await controller.card.getCards(cardProcessing, controller);
            } catch (e) {
                this.appContext?.logError(
                    `WeChatAdapter.getContent(): ошибка отправки изображений: ${e instanceof Error ? e.message : String(e)}`,
                    { error: e },
                );
            }
        }

        // shouldProcessChatSound учитывает и заданные звуки, и tts при настроенном
        // speech_kit_token — иначе озвучка tts на WeChat не отправлялась вовсе.
        const hasSounds = pUtils.shouldProcessChatSound(controller, this.platformName);
        if (hasSounds) {
            try {
                await controller.sound.getSounds(controller.tts, soundProcessing, controller);
            } catch (e) {
                this.appContext?.logError(
                    `WeChatAdapter.getContent(): ошибка обработки звука: ${e instanceof Error ? e.message : String(e)}`,
                    { error: e },
                );
            }
        }

        if (!text && !hasCards && !hasSounds) {
            this.appContext?.logWarn(
                'WeChatAdapter.getContent(): ответ не содержит ни текста, ни tts, ни вложений — пользователю ничего не отправлено.',
            );
        }

        return 'ok';
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
