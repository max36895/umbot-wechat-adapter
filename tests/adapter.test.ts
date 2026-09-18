import { createHash } from 'crypto';

const sendTextMessage = jest.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok' });
const sendImage = jest.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok' });
const sendVoice = jest.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok' });
const getUserInfo = jest.fn().mockResolvedValue({ openid: 'u1', nickname: 'Вася' });
const uploadImage = jest.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'media_1' });

jest.mock('../src/API/WeChatRequest', () => ({
    WeChatRequest: jest.fn().mockImplementation(() => ({
        sendTextMessage,
        sendImage,
        sendVoice,
        getUserInfo,
        uploadImage,
        uploadVoice: jest.fn().mockResolvedValue(null),
    })),
    getErrorMsg: jest.fn(),
    getErrorToken: jest.fn(),
}));

import { AppContext, BaseBotController, BotController } from 'umbot';
import { WeChatAdapter } from '../src';
import { WeChatButton } from '../src';
import { IWeChatRequestContent } from '../src';

const TOKEN = 'my_secret_token';

const request = (over: Partial<IWeChatRequestContent> = {}): IWeChatRequestContent => ({
    ToUserName: 'gh_account',
    FromUserName: 'open_id_1',
    CreateTime: 1700000000,
    MsgType: 'text',
    Content: 'Привет',
    MsgId: 1,
    ...over,
});

describe('WeChatAdapter', () => {
    let adapter: WeChatAdapter;
    let appContext: AppContext;
    let controller: BotController;

    beforeEach(() => {
        jest.clearAllMocks();
        WeChatAdapter.clearUserCache();
        appContext = new AppContext();
        adapter = new WeChatAdapter(TOKEN, { app_id: 'id', app_secret: 'secret' });
        adapter.init(appContext);
        controller = new BaseBotController(appContext);
    });

    describe('init', () => {
        it('регистрирует платформу и прокидывает токены', () => {
            expect(appContext.platforms.wechat).toBe(adapter);
            expect(appContext.appConfig.tokens.wechat).toEqual({
                token: TOKEN,
                app_id: 'id',
                app_secret: 'secret',
            });
        });
    });

    describe('supportedEvents', () => {
        it('перечисляет все события, которые выставляет setQueryData', () => {
            expect(adapter.supportedEvents).toEqual(
                expect.arrayContaining([
                    'message',
                    'voice',
                    'photo',
                    'video',
                    'location',
                    'callback',
                    'start',
                    'subscribed',
                    'unsubscribed',
                ]),
            );
        });
    });

    describe('isPlatformOnQuery', () => {
        it('опознаёт запрос по телу', () => {
            expect(adapter.isPlatformOnQuery(request())).toBe(true);
        });

        it('опознаёт запрос по заголовку подписи', () => {
            expect(
                adapter.isPlatformOnQuery({} as IWeChatRequestContent, {
                    'x-wechat-signature': 'abc',
                }),
            ).toBe(true);
        });

        it('отклоняет чужой запрос', () => {
            expect(adapter.isPlatformOnQuery({ update_id: 1 } as never)).toBe(false);
        });
    });

    describe('isCorrectQuery', () => {
        const sign = (timestamp: string, nonce: string): string =>
            createHash('sha1').update([TOKEN, timestamp, nonce].sort().join('')).digest('hex');

        it('принимает запрос с корректной подписью WeChat (sha1, не HMAC тела)', () => {
            expect(
                adapter.isCorrectQuery(request(), {
                    'x-wechat-signature': sign('1', 'n'),
                    'x-wechat-timestamp': '1',
                    'x-wechat-nonce': 'n',
                }),
            ).toBe(true);
        });

        it('отклоняет запрос без подписи, когда токен настроен', () => {
            expect(adapter.isCorrectQuery(request(), {})).toBe(false);
            expect(adapter.isSignatureCheckEnabled()).toBe(true);
        });

        it('пропускает проверку, если токен не настроен', () => {
            const ctx = new AppContext();
            const noTokenAdapter = new WeChatAdapter();
            noTokenAdapter.init(ctx);
            expect(noTokenAdapter.isSignatureCheckEnabled()).toBe(false);
            expect(noTokenAdapter.isCorrectQuery(request(), {})).toBe(true);
        });
    });

    describe('setQueryData', () => {
        it('заполняет обязательные поля контроллера', async () => {
            expect(await adapter.setQueryData(request(), controller)).toBe(true);
            expect(controller.userId).toBe('open_id_1');
            expect(controller.appType).toBe('wechat');
            expect(controller.userCommand).toBe('привет');
            expect(controller.originalUserCommand).toBe('Привет');
            expect(controller.eventType).toBe('message');
            expect(controller.messageId).toBe(1);
        });

        it('не ходит в user/info без опции fetch_user_info', async () => {
            await adapter.setQueryData(request(), controller);
            expect(getUserInfo).not.toHaveBeenCalled();
        });

        it('запрашивает и кэширует имя пользователя при fetch_user_info', async () => {
            const ctx = new AppContext();
            const withInfo = new WeChatAdapter(TOKEN, {
                app_id: 'id',
                app_secret: 'secret',
                fetch_user_info: true,
            });
            withInfo.init(ctx);
            await withInfo.setQueryData(request(), new BaseBotController(ctx));
            await withInfo.setQueryData(request(), new BaseBotController(ctx));
            expect(getUserInfo).toHaveBeenCalledTimes(1);
        });

        it('размечает голосовое сообщение', async () => {
            await adapter.setQueryData(
                request({ MsgType: 'voice', Recognition: 'Открой Меню', Content: undefined }),
                controller,
            );
            expect(controller.eventType).toBe('voice');
            expect(controller.userCommand).toBe('открой меню');
        });

        it('размечает изображение и геолокацию', async () => {
            await adapter.setQueryData(
                request({ MsgType: 'image', PicUrl: 'http://pic', MediaId: 'm1' }),
                controller,
            );
            expect(controller.eventType).toBe('photo');
            expect(controller.userMeta).toEqual({ PicUrl: 'http://pic', MediaId: 'm1' });

            const other = new BaseBotController(appContext);
            await adapter.setQueryData(
                request({ MsgType: 'location', Location_X: 55.7, Location_Y: 37.6, Label: 'МСК' }),
                other,
            );
            expect(other.eventType).toBe('location');
            expect(other.originalUserCommand).toBe('МСК');
        });

        it('неизвестный MsgType не роняет запрос и не требует ответа', async () => {
            expect(await adapter.setQueryData(request({ MsgType: 'music' }), controller)).toBe(
                true,
            );
            expect(controller.skipAutoReply).toBe(true);
        });

        it('пустой запрос отклоняется', async () => {
            expect(await adapter.setQueryData(null as never, controller)).toBe(false);
            expect(controller.platformOptions.error).toContain('setQueryData');
        });

        describe('события', () => {
            const event = (
                Event: string,
                over: Partial<IWeChatRequestContent> = {},
            ): IWeChatRequestContent =>
                request({ MsgType: 'event', Event, MsgId: undefined, Content: undefined, ...over });

            it('subscribe помечает начало диалога', async () => {
                await adapter.setQueryData(event('subscribe'), controller);
                expect(controller.eventType).toBe('subscribed');
                expect(controller.userCommand).toBe('start');
                expect(controller.messageId).toBe(0);
            });

            it('subscribe по QR-коду отдаёт start со сценарием', async () => {
                await adapter.setQueryData(
                    event('subscribe', { EventKey: 'qrscene_promo', Ticket: 't' }),
                    controller,
                );
                expect(controller.eventType).toBe('start');
                expect(controller.payload).toEqual({
                    event: 'subscribe',
                    scene: 'qrscene_promo',
                    ticket: 't',
                });
            });

            it('CLICK приходит как callback с нормализованным payload', async () => {
                await adapter.setQueryData(
                    event('CLICK', { EventKey: '{"command":"BUY"}' }),
                    controller,
                );
                expect(controller.eventType).toBe('callback');
                expect(controller.userCommand).toBe('buy');
                // messageId != 0 — иначе welcome-интент срабатывал бы на каждом клике
                expect(controller.messageId).toBe(1700000000);
            });

            it('unsubscribe не требует ответа', async () => {
                await adapter.setQueryData(event('unsubscribe'), controller);
                expect(controller.eventType).toBe('unsubscribed');
                expect(controller.skipAutoReply).toBe(true);
            });

            it('неизвестное событие не считается отпиской', async () => {
                await adapter.setQueryData(event('TEMPLATESENDJOBFINISH'), controller);
                expect(controller.eventType).not.toBe('unsubscribed');
                expect(controller.eventType).toBe('message');
                expect(controller.skipAutoReply).toBe(true);
            });
        });
    });

    describe('getContent', () => {
        beforeEach(async () => {
            await adapter.setQueryData(request(), controller);
        });

        it('отправляет текст', async () => {
            controller.text = 'Ответ';
            expect(await adapter.getContent(controller)).toBe('ok');
            expect(sendTextMessage).toHaveBeenCalledWith('open_id_1', 'Ответ');
        });

        it('отправляет tts, если текст пуст', async () => {
            controller.text = '';
            controller.tts = 'Озвучка <speaker audio="a.opus">';
            await adapter.getContent(controller);
            expect(sendTextMessage).toHaveBeenCalledWith('open_id_1', 'Озвучка');
        });

        it('дописывает кнопки списком — у WeChat нет клавиатуры', async () => {
            controller.text = 'Выберите';
            controller.buttons.addBtn('Каталог');
            controller.buttons.addBtn('Помощь', 'https://example.com');
            await adapter.getContent(controller);
            const sent = sendTextMessage.mock.calls[0][1] as string;
            // umbot дописывает к кнопкам-ссылкам utm-метки — сверяем начало строки.
            expect(sent).toContain('Выберите\n\n• Каталог\n• Помощь: https://example.com');
        });

        it('обрезает текст по лимиту платформы', async () => {
            controller.text = 'a'.repeat(3000);
            await adapter.getContent(controller);
            expect((sendTextMessage.mock.calls[0][1] as string).length).toBeLessThanOrEqual(2048);
        });

        it('отправляет изображение карточки', async () => {
            controller.text = '';
            controller.card.addImage('image_token_1', 'Заголовок');
            await adapter.getContent(controller);
            expect(sendImage).toHaveBeenCalledWith('open_id_1', 'image_token_1');
            expect(sendTextMessage).toHaveBeenCalledWith('open_id_1', 'Заголовок');
        });

        it('ничего не отправляет при skipAutoReply', async () => {
            controller.text = 'Ответ';
            controller.skipAutoReply = true;
            expect(await adapter.getContent(controller)).toBe('ok');
            expect(sendTextMessage).not.toHaveBeenCalled();
        });
    });

    describe('createApi', () => {
        it('поддерживает только фото и аудио', () => {
            const api = adapter.createApi(controller);
            expect(api).not.toBeNull();
            expect(api!.can('sendPhoto')).toBe(true);
            expect(api!.can('sendAudio')).toBe(true);
            expect(api!.can('sendDocument')).toBe(false);
            expect(api!.can('answerCallback')).toBe(false);
        });
    });

    describe('getQueryExample', () => {
        it('возвращает объект, который принимает isPlatformOnQuery', () => {
            const example = adapter.getQueryExample('привет', 'u1', 0) as IWeChatRequestContent;
            expect(adapter.isPlatformOnQuery(example)).toBe(true);
        });
    });
});

describe('WeChatButton.buttonsToText', () => {
    it('пропускает кнопки без названия и возвращает null, если выводить нечего', () => {
        expect(WeChatButton.buttonsToText([{ title: '' }, { title: '   ' }])).toBeNull();
        expect(WeChatButton.buttonsToText([])).toBeNull();
    });

    it('обрезает список по лимиту платформы', () => {
        const buttons = Array.from({ length: 12 }, (_, i) => ({ title: `btn${i}` }));
        expect(WeChatButton.buttonsToText(buttons)!.split('\n')).toHaveLength(8);
    });
});
