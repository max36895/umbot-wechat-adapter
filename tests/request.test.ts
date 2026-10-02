import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppContext } from 'umbot';
import { WeChatRequest } from '../src';

interface ICall {
    url: string;
    method: string;
    body: unknown;
}

const json = (data: unknown): Response =>
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

describe('WeChatRequest', () => {
    let appContext: AppContext;
    let calls: ICall[];
    let handler: (url: string) => unknown;

    const tokenCalls = (): ICall[] => calls.filter((call) => call.url.includes('/stable_token'));
    const apiCalls = (): ICall[] => calls.filter((call) => !call.url.includes('/stable_token'));

    beforeEach(() => {
        calls = [];
        appContext = new AppContext();
        appContext.setLogger({ log: () => {}, error: () => {}, warn: () => {} });
        appContext.appConfig.tokens.wechat = { app_id: 'wx_app', app_secret: 'app_secret' };
        let issued = 0;
        handler = (url): unknown =>
            url.includes('/stable_token')
                ? { access_token: `token_${++issued}`, expires_in: 7200 }
                : { errcode: 0, errmsg: 'ok', media_id: 'media_1', openid: 'open_1' };
        appContext.httpClient = async (input, init): Promise<Response> => {
            const url = String(input);
            const body =
                typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
            calls.push({ url, method: init?.method ?? 'GET', body });
            return json(handler(url));
        };
    });

    it('берёт токен через stable_token в обычном режиме и кэширует его для всех экземпляров', async () => {
        await new WeChatRequest(appContext).sendTextMessage('open_1', 'Привет');
        await new WeChatRequest(appContext).sendTextMessage('open_1', 'Ещё');

        expect(tokenCalls()).toHaveLength(1);
        expect(tokenCalls()[0]?.body).toEqual({
            grant_type: 'client_credential',
            appid: 'wx_app',
            secret: 'app_secret',
            force_refresh: false,
        });
        // Секрет уходит в теле POST, а не в строке запроса
        expect(tokenCalls()[0]?.url).not.toContain('app_secret');
        expect(apiCalls()[1]?.url).toContain('message/custom/send?access_token=token_1');
        expect(apiCalls()[0]?.body).toEqual({
            touser: 'open_1',
            msgtype: 'text',
            text: { content: 'Привет' },
        });
    });

    it('параллельные отправки с пустым кэшем делают один запрос токена', async () => {
        await Promise.all([
            new WeChatRequest(appContext).sendTextMessage('open_1', 'a'),
            new WeChatRequest(appContext).sendTextMessage('open_1', 'b'),
            new WeChatRequest(appContext).sendImage('open_1', 'media_1'),
        ]);
        expect(tokenCalls()).toHaveLength(1);
        expect(apiCalls()).toHaveLength(3);
    });

    it('учитывает expires_in: токен обновляется заранее, до истечения', async () => {
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        try {
            await new WeChatRequest(appContext).sendTextMessage('open_1', 'a');
            clock.mockReturnValue(now + (7200 - 301) * 1000);
            await new WeChatRequest(appContext).sendTextMessage('open_1', 'b');
            expect(tokenCalls()).toHaveLength(1);
            clock.mockReturnValue(now + (7200 - 299) * 1000);
            await new WeChatRequest(appContext).sendTextMessage('open_1', 'c');
            expect(tokenCalls()).toHaveLength(2);
        } finally {
            clock.mockRestore();
        }
    });

    it.each([40001, 40014, 42001])(
        'на errcode %i сбрасывает токен и повторяет запрос один раз',
        async (errcode) => {
            let failed = false;
            const base = handler;
            handler = (url): unknown => {
                if (url.includes('custom/send') && !failed) {
                    failed = true;
                    return { errcode, errmsg: 'invalid credential' };
                }
                return base(url);
            };
            const res = await new WeChatRequest(appContext).sendTextMessage('open_1', 'a');
            expect(res).toEqual(expect.objectContaining({ errcode: 0 }));
            expect(tokenCalls()).toHaveLength(2);
            expect(apiCalls().map((call) => call.url.split('access_token=')[1])).toEqual([
                'token_1',
                'token_2',
            ]);
            // Повтор отправляет то же тело
            expect(apiCalls()[1]?.body).toEqual(apiCalls()[0]?.body);
        },
    );

    it('не зацикливается, если и после нового токена ошибка токена', async () => {
        const base = handler;
        handler = (url): unknown =>
            url.includes('custom/send') ? { errcode: 40001, errmsg: 'invalid' } : base(url);
        const request = new WeChatRequest(appContext);
        expect(await request.sendTextMessage('open_1', 'a')).toBeNull();
        expect(apiCalls()).toHaveLength(2);
        expect(request.lastErrorCode).toBe(40001);
    });

    it('другие ошибки не повторяет и отдаёт код в lastErrorCode', async () => {
        const base = handler;
        handler = (url): unknown =>
            url.includes('custom/send')
                ? { errcode: 40007, errmsg: 'invalid media_id' }
                : base(url);
        const request = new WeChatRequest(appContext);
        expect(await request.sendImage('open_1', 'old_media')).toBeNull();
        expect(apiCalls()).toHaveLength(1);
        expect(request.lastErrorCode).toBe(40007);

        handler = base;
        await request.sendImage('open_1', 'media_1');
        expect(request.lastErrorCode).toBeUndefined();
    });

    it('без app_id/app_secret и при ошибке выдачи токена ничего не отправляет', async () => {
        appContext.appConfig.tokens.wechat = {};
        expect(await new WeChatRequest(appContext).sendTextMessage('open_1', 'a')).toBeNull();
        expect(calls).toHaveLength(0);

        appContext.appConfig.tokens.wechat = { app_id: 'wx_app', app_secret: 'bad' };
        handler = (): unknown => ({ errcode: 40125, errmsg: 'invalid appsecret' });
        expect(await new WeChatRequest(appContext).sendTextMessage('open_1', 'a')).toBeNull();
        expect(apiCalls()).toHaveLength(0);
    });

    it('загружает файл multipart-полем media и повторяет загрузку после ошибки токена', async () => {
        const file = join(tmpdir(), `wechat-test-${Date.now()}.jpg`);
        await fs.writeFile(file, 'image-bytes');
        try {
            let failed = false;
            const base = handler;
            handler = (url): unknown => {
                if (url.includes('media/upload') && !failed) {
                    failed = true;
                    return { errcode: 42001, errmsg: 'access_token expired' };
                }
                return base(url);
            };
            const res = await new WeChatRequest(appContext).uploadImage(file);
            expect(res?.media_id).toBe('media_1');
            const uploads = apiCalls();
            expect(uploads).toHaveLength(2);
            expect(uploads[1]?.url).toContain('media/upload?type=image&access_token=token_2');
            const form = uploads[1]?.body as FormData;
            expect(form).toBeInstanceOf(FormData);
            expect(form.has('media')).toBe(true);
        } finally {
            await fs.unlink(file);
        }
    });

    it('ссылку вместо файла не загружает', async () => {
        expect(
            await new WeChatRequest(appContext).uploadVoice('https://example.com/a.mp3'),
        ).toBeNull();
        expect(apiCalls()).toHaveLength(0);
    });

    it('getUserInfo делает GET без параметра lang', async () => {
        const info = await new WeChatRequest(appContext).getUserInfo('open 1');
        expect(info?.openid).toBe('open_1');
        expect(apiCalls()[0]?.method).toBe('GET');
        expect(apiCalls()[0]?.url).toContain('user/info?openid=open%201&access_token=token_1');
        expect(apiCalls()[0]?.url).not.toContain('lang=');
    });
});
