import { createHash } from 'crypto';

const sendTextMessage = jest.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok' });

jest.mock('../src/API/WeChatRequest', () => ({
    WeChatRequest: jest.fn().mockImplementation(() => ({
        sendTextMessage,
        sendImage: jest.fn(),
        sendVoice: jest.fn(),
        getUserInfo: jest.fn(),
        uploadImage: jest.fn(),
        uploadVoice: jest.fn(),
    })),
    getErrorMsg: jest.fn(),
    getErrorToken: jest.fn(),
}));

import { Bot } from 'umbot';
import { WeChatAdapter, parseWeChatXml } from '../src';

const TOKEN = 'integration_token';

const xml = (content: string): string =>
    `<xml><ToUserName><![CDATA[gh_acc]]></ToUserName><FromUserName><![CDATA[open_1]]></FromUserName>` +
    `<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${content}]]></Content><MsgId>7</MsgId></xml>`;

const headers = (
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = 'n',
): Record<string, string> => ({
    'x-wechat-signature': createHash('sha1')
        .update([TOKEN, timestamp, nonce].sort().join(''))
        .digest('hex'),
    'x-wechat-timestamp': timestamp,
    'x-wechat-nonce': nonce,
});

describe('сквозной прогон через bot.webhookEvent', () => {
    let bot: Bot;

    beforeEach(() => {
        jest.clearAllMocks();
        bot = new Bot();
        bot.setLogger({ log: () => {}, error: () => {}, warn: () => {} });
        bot.use(new WeChatAdapter(TOKEN, { app_id: 'id', app_secret: 'secret' })).addCommand(
            'hello',
            ['привет'],
            (_text, ctx) => {
                ctx.text = 'Здравствуйте!';
            },
        );
    });

    it('разбирает XML, проверяет подпись и вызывает команду', async () => {
        const query = parseWeChatXml(xml('Привет'));
        expect(query).not.toBeNull();

        const res = await bot.webhookEvent(query, headers());
        expect(res.statusCode).toBe(200);
        // Пустое тело: WeChat ничего не делает и не повторяет доставку
        expect(res.body).toBe('');
        expect(sendTextMessage).toHaveBeenCalledWith('open_1', 'Здравствуйте!');
    });

    it('повторную доставку того же сообщения (WeChat ждёт ответа 5 с) обрабатывает один раз', async () => {
        await bot.webhookEvent(parseWeChatXml(xml('Привет')), headers());
        await bot.webhookEvent(parseWeChatXml(xml('Привет')), headers());
        expect(sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('отклоняет запрос с неверной подписью до бизнес-логики', async () => {
        const query = parseWeChatXml(xml('Привет'));
        const res = await bot.webhookEvent(query, {
            'x-wechat-signature': 'deadbeef',
            'x-wechat-timestamp': '1',
            'x-wechat-nonce': 'n',
        });
        expect(res.statusCode).toBe(401);
        expect(sendTextMessage).not.toHaveBeenCalled();
    });
});
