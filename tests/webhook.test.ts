import { createHash } from 'crypto';
import { handleWeChatVerification, parseWeChatXml, verifyWeChatSignature } from '../src';

const TOKEN = 'my_secret_token';

const sign = (timestamp: string, nonce: string, token = TOKEN): string =>
    createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');

describe('parseWeChatXml', () => {
    it('разбирает текстовое сообщение', () => {
        const xml = `<xml>
            <ToUserName><![CDATA[gh_account]]></ToUserName>
            <FromUserName><![CDATA[open_id_1]]></FromUserName>
            <CreateTime>1700000000</CreateTime>
            <MsgType><![CDATA[text]]></MsgType>
            <Content><![CDATA[Привет]]></Content>
            <MsgId>1234567890123456</MsgId>
        </xml>`;
        expect(parseWeChatXml(xml)).toEqual({
            ToUserName: 'gh_account',
            FromUserName: 'open_id_1',
            CreateTime: 1700000000,
            MsgType: 'text',
            Content: 'Привет',
            MsgId: 1234567890123456,
        });
    });

    it('разбирает событие без MsgId', () => {
        const xml =
            `<xml><ToUserName><![CDATA[gh]]></ToUserName><FromUserName><![CDATA[u]]></FromUserName>` +
            `<CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
            `<Event><![CDATA[subscribe]]></Event><EventKey><![CDATA[]]></EventKey></xml>`;
        const res = parseWeChatXml(xml);
        expect(res?.Event).toBe('subscribe');
        expect(res?.MsgId).toBeUndefined();
        expect(res?.EventKey).toBe('');
    });

    it('возвращает null на постороннем теле', () => {
        expect(parseWeChatXml('')).toBeNull();
        expect(parseWeChatXml('{"update_id":1}')).toBeNull();
        expect(parseWeChatXml('<xml><Foo>bar</Foo></xml>')).toBeNull();
    });

    it('не даёт записать ключи прототипа', () => {
        const xml =
            '<xml><ToUserName>a</ToUserName><FromUserName>b</FromUserName>' +
            '<CreateTime>1</CreateTime><MsgType>text</MsgType><__proto__>polluted</__proto__></xml>';
        const res = parseWeChatXml(xml) as Record<string, unknown>;
        expect(res).not.toBeNull();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(res, '__proto__')).toBe(false);
    });
});

describe('verifyWeChatSignature', () => {
    it('принимает корректную подпись', () => {
        expect(verifyWeChatSignature(TOKEN, sign('123', 'abc'), '123', 'abc')).toBe(true);
    });

    it('отклоняет подпись от чужого токена', () => {
        expect(verifyWeChatSignature(TOKEN, sign('123', 'abc', 'other'), '123', 'abc')).toBe(false);
    });

    it('отклоняет неполные параметры', () => {
        expect(verifyWeChatSignature(TOKEN, undefined, '123', 'abc')).toBe(false);
        expect(verifyWeChatSignature(TOKEN, sign('123', 'abc'), null, 'abc')).toBe(false);
        expect(verifyWeChatSignature('', sign('123', 'abc'), '123', 'abc')).toBe(false);
    });
});

describe('handleWeChatVerification', () => {
    it('возвращает echostr при корректной подписи', () => {
        expect(
            handleWeChatVerification(TOKEN, {
                signature: sign('1', 'n'),
                timestamp: '1',
                nonce: 'n',
                echostr: 'hello',
            }),
        ).toBe('hello');
    });

    it('возвращает null при неверной подписи или без echostr', () => {
        expect(
            handleWeChatVerification(TOKEN, {
                signature: 'deadbeef',
                timestamp: '1',
                nonce: 'n',
                echostr: 'hello',
            }),
        ).toBeNull();
        expect(
            handleWeChatVerification(TOKEN, {
                signature: sign('1', 'n'),
                timestamp: '1',
                nonce: 'n',
            }),
        ).toBeNull();
    });
});
