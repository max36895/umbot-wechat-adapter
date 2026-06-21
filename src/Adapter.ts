import { AppContext, BotController, INluThisUser, Text } from 'umbot';
import { BasePlatformAdapter, EMPTY_CONTEXT_ERROR, EMPTY_QUERY_ERROR } from 'umbot/plugins';
import { cardProcessing } from './Card';
import { soundProcessing } from './Sound';
import { T_WECHAT } from './constants';
import { IWeChatRequestContent } from './IWeChatPlatform';
import { WeChatRequest } from './API/WeCharRequest';

/**
 * Адаптер для WeChat Official Account.
 *
 * Поддерживает текст, голос (Recognition), события (subscribe/CLICK/SCAN),
 * изображения и ссылки. Ответы отправляются через Customer Service API
 * (без ограничения 5 сек пассивного ответа).
 *
 * @example
 * ```ts
 * import { Bot } from 'umbot';
 * import { WeChatAdapter } from 'umbot/plugins';
 *
 * const bot = new Bot()
 *     .use(new WeChatAdapter('TOKEN', {
 *         app_id: 'APP_ID',
 *         app_secret: 'APP_SECRET',
 *     }))
 *     .addCommand('start', ['привет', 'hello'], (_text, ctx) => {
 *         ctx.text = 'Привет! Я бот для WeChat';
 *     });
 *
 * bot.start('0.0.0.0', 3000);
 * ```
 */
export class WeChatAdapter extends BasePlatformAdapter<string | IWeChatRequestContent> {
    platformName = T_WECHAT;
    isVoice = false;
    limit = 50;
    signatureName = 'x-wechat-signature';

    init(appContext: AppContext): void {
        super.init(appContext);
        if (this._token) {
            appContext.appConfig.tokens[this.platformName].token = this._token;
        }
        if (this._platformOptions?.app_id) {
            appContext.appConfig.tokens[this.platformName].app_id = this._platformOptions
                .app_id as string;
        }
        if (this._platformOptions?.app_secret) {
            appContext.appConfig.tokens[this.platformName].app_secret = this._platformOptions
                .app_secret as string;
        }
    }

    isPlatformOnQuery(query: IWeChatRequestContent, headers?: Record<string, unknown>): boolean {
        if (headers?.['x-wechat-signature']) {
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
        controller.messageId = query.MsgId || 0;

        switch (query.MsgType) {
            case 'text':
                controller.userCommand = (query.Content || '').toLowerCase().trim();
                controller.originalUserCommand = (query.Content || '').trim();
                break;

            case 'voice':
                controller.userCommand = (query.Recognition || '').toLowerCase().trim();
                controller.originalUserCommand = (query.Recognition || '').trim();
                break;

            case 'event':
                await this.#handleEvent(query, controller);
                break;

            case 'image':
                controller.userCommand = '[image]';
                controller.originalUserCommand = '[image]';
                controller.userMeta = { PicUrl: query.PicUrl, MediaId: query.MediaId };
                break;

            case 'link':
                controller.userCommand = '[link]';
                controller.originalUserCommand = query.Title || '[link]';
                controller.userMeta = {
                    Url: query.Url,
                    Title: query.Title,
                    Description: query.Description,
                };
                break;

            default:
                controller.userCommand = `[${query.MsgType}]`;
                controller.originalUserCommand = `[${query.MsgType}]`;
                break;
        }

        // Получаем информацию о пользователе через API
        try {
            const userInfo = await new WeChatRequest(this.appContext as AppContext).getUserInfo(
                query.FromUserName,
            );
            if (userInfo) {
                const thisUser: INluThisUser = {
                    username: null,
                    first_name: userInfo.nickname || null,
                    last_name: null,
                };
                controller.nlu.setNlu({ thisUser });
            }
        } catch {
            // Не прерываем запрос, если getUserInfo упал
        }

        return true;
    }

    async #handleEvent(query: IWeChatRequestContent, controller: BotController): Promise<void> {
        switch (query.Event) {
            case 'subscribe':
                controller.userCommand = 'start';
                controller.originalUserCommand = 'subscribe';
                controller.payload = { event: 'subscribe' };
                break;
            case 'unsubscribe':
                controller.skipAutoReply = true;
                controller.userCommand = 'unsubscribe';
                controller.originalUserCommand = 'unsubscribe';
                break;
            case 'SCAN':
                controller.userCommand = (query.EventKey || '').toLowerCase().trim();
                controller.originalUserCommand = query.EventKey || '';
                controller.payload = { event: 'SCAN', ticket: query.Ticket };
                break;
            case 'CLICK':
                controller.userCommand = (query.EventKey || '').toLowerCase().trim();
                controller.originalUserCommand = query.EventKey || '';
                controller.payload = { event: 'CLICK' };
                break;
            case 'VIEW':
                controller.skipAutoReply = true;
                break;
            default:
                controller.userCommand = (query.Event || '').toLowerCase().trim();
                controller.originalUserCommand = query.Event || '';
                break;
        }
    }

    async getContent(controller: BotController): Promise<string> {
        if (!controller.skipAutoReply) {
            const api = new WeChatRequest(this.appContext as AppContext);

            if (controller.text) {
                await api.sendTextMessage(
                    controller.userId as string,
                    Text.resize(controller.text, 2048),
                );
            }

            if (controller.isCardInit() && controller.card.images.length) {
                await controller.card.getCards(cardProcessing, controller);
            }

            if (controller.isSoundInit() && controller.sound.sounds.length) {
                await controller.sound.getSounds(controller.tts, soundProcessing, controller);
            }
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
