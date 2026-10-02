const sendImage = jest.fn();
const sendVoice = jest.fn();
const uploadImage = jest.fn();
const uploadVoice = jest.fn();
const mockApi = { lastErrorCode: undefined as number | undefined };

jest.mock('../src/API/WeChatRequest', () => ({
    WeChatRequest: jest.fn().mockImplementation(() => ({
        sendImage: (...args: unknown[]): unknown => sendImage(...args),
        sendVoice: (...args: unknown[]): unknown => sendVoice(...args),
        uploadImage: (...args: unknown[]): unknown => uploadImage(...args),
        uploadVoice: (...args: unknown[]): unknown => uploadVoice(...args),
        sendTextMessage: jest.fn(),
        get lastErrorCode(): number | undefined {
            return mockApi.lastErrorCode;
        },
    })),
}));

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppContext, BaseBotController, Buttons, IModelRes, IQuery, IQueryData } from 'umbot';
import { BaseDbAdapter } from 'umbot/plugins';
import { makeWeChatApi, WeChatButton, WeChatCard, WeChatSound } from '../src';
import { truncateUtf8 } from '../src/utils';

/** Простейшая БД в памяти: точное совпадение полей условия. */
class MemoryDb extends BaseDbAdapter {
    tables = new Map<string, Record<string, unknown>[]>();

    #rows(name: string): Record<string, unknown>[] {
        let rows = this.tables.get(name);
        if (!rows) {
            rows = [];
            this.tables.set(name, rows);
        }
        return rows;
    }

    #match(row: Record<string, unknown>, where: IQueryData | null): boolean {
        return Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
    }

    _select(query: IQuery, where: IQueryData | null, isOne: boolean): IModelRes {
        const rows = this.#rows(query.tableName).filter((row) => this.#match(row, where));
        if (!rows.length) {
            return { status: false };
        }
        return { status: true, data: isOne ? rows[0] : rows };
    }

    _insert(query: IQuery): boolean {
        this.#rows(query.tableName).push({ ...query.data });
        return true;
    }

    _update(query: IQuery): boolean {
        for (const row of this.#rows(query.tableName)) {
            if (this.#match(row, query.query)) {
                Object.assign(row, query.data);
            }
        }
        return true;
    }

    _remove(query: IQuery): boolean {
        const rows = this.#rows(query.tableName);
        this.tables.set(
            query.tableName,
            rows.filter((row) => !this.#match(row, query.query)),
        );
        return true;
    }

    isConnected(): boolean {
        return true;
    }
}

describe('медиа WeChat', () => {
    let appContext: AppContext;
    let controller: BaseBotController;
    let db: MemoryDb;

    beforeEach(() => {
        jest.clearAllMocks();
        mockApi.lastErrorCode = undefined;
        appContext = new AppContext();
        appContext.setLogger({ log: () => {}, error: () => {}, warn: () => {} });
        db = new MemoryDb();
        db.init(appContext);
        controller = new BaseBotController(appContext);
        controller.userId = 'open_1';
    });

    describe('просроченный media_id (WeChat хранит файл 3 дня)', () => {
        it('картинка: удаляет id из кэша, загружает заново и отправляет', async () => {
            db.tables.set('ImageTokens', [
                { imageToken: 'old_media', path: './photo.jpg', platform: 'wechat' },
            ]);
            sendImage.mockImplementation(async (_user: string, mediaId: string) => {
                if (mediaId === 'old_media') {
                    mockApi.lastErrorCode = 40007;
                    return null;
                }
                mockApi.lastErrorCode = undefined;
                return { errcode: 0, errmsg: 'ok' };
            });
            uploadImage.mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'new_media' });

            controller.card.addImage('', 'Фото');
            controller.card.images[0]!.imageDir = './photo.jpg';
            const sent = await WeChatCard.cardProcessing(
                { images: controller.card.images } as never,
                controller,
            );

            expect(sendImage.mock.calls.map((call) => call[1])).toEqual(['old_media', 'new_media']);
            expect(uploadImage).toHaveBeenCalledTimes(1);
            expect(db.tables.get('ImageTokens')).toEqual([
                expect.objectContaining({ imageToken: 'new_media', path: './photo.jpg' }),
            ]);
            expect(sent).toEqual(['new_media']);
        });

        it('другие ошибки не вызывают повторной загрузки', async () => {
            db.tables.set('ImageTokens', [
                { imageToken: 'media_1', path: './photo.jpg', platform: 'wechat' },
            ]);
            sendImage.mockImplementation(async () => {
                mockApi.lastErrorCode = 45047;
                return null;
            });
            controller.card.addImage('', 'Фото');
            controller.card.images[0]!.imageDir = './photo.jpg';
            const sent = await WeChatCard.cardProcessing(
                { images: controller.card.images } as never,
                controller,
            );
            expect(sent).toBeNull();
            expect(uploadImage).not.toHaveBeenCalled();
            expect(db.tables.get('ImageTokens')).toHaveLength(1);
        });

        it('голос: удаляет id из кэша, загружает файл заново и отправляет', async () => {
            const file = join(tmpdir(), `wechat-voice-${Date.now()}.mp3`);
            await fs.writeFile(file, 'mp3');
            try {
                db.tables.set('SoundTokens', [
                    { soundToken: 'old_voice', path: file, platform: 'wechat' },
                ]);
                sendVoice.mockImplementation(async (_user: string, mediaId: string) => {
                    mockApi.lastErrorCode = mediaId === 'old_voice' ? 40007 : undefined;
                    return mediaId === 'old_voice' ? null : { errcode: 0, errmsg: 'ok' };
                });
                uploadVoice.mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'new_voice' });

                const sent = await WeChatSound.soundProcessing(
                    { sounds: [{ key: '#v#', sounds: [file] }], text: '' },
                    controller,
                );
                expect(sendVoice.mock.calls.map((call) => call[1])).toEqual([
                    'old_voice',
                    'new_voice',
                ]);
                expect(sent).toEqual(['new_voice']);
                expect(db.tables.get('SoundTokens')).toEqual([
                    expect.objectContaining({ soundToken: 'new_voice' }),
                ]);
            } finally {
                await fs.unlink(file);
            }
        });
    });

    describe('soundProcessing', () => {
        it('не синтезирует tts: WeChat не принимает OGG/Opus от SpeechKit', async () => {
            appContext.appConfig.tokens.wechat = { speech_kit_token: 'key' };
            const sent = await WeChatSound.soundProcessing(
                { sounds: [], text: 'Привет' },
                controller,
            );
            expect(sent).toEqual([]);
            expect(uploadVoice).not.toHaveBeenCalled();
        });

        it('звук по ссылке пропускает и предупреждает один раз за процесс', async () => {
            const warn = jest.fn();
            appContext.setLogger({ log: () => {}, error: () => {}, warn });
            const sounds = {
                sounds: [{ key: '#a#', sounds: ['https://example.com/a.mp3'] }],
                text: '',
            };
            await WeChatSound.soundProcessing(sounds, controller);
            await WeChatSound.soundProcessing(sounds, controller);
            expect(uploadVoice).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledTimes(1);
        });
    });

    describe('menuButtonsProcessing', () => {
        it('собирает тело menu/create: view для ссылок, click с key для остальных', () => {
            const buttons = new Buttons(appContext);
            buttons.addBtn('Каталог', null, 'catalog');
            buttons.addBtn('Сайт', 'https://example.com');
            buttons.addBtn('Помощь');
            buttons.addBtn('Четвёртая');
            const menu = buttons.getButtons(WeChatButton.menuButtonsProcessing) as {
                button: Record<string, unknown>[];
            };
            expect(menu.button).toHaveLength(3);
            expect(menu.button[0]).toEqual({ type: 'click', name: 'Каталог', key: 'catalog' });
            expect(menu.button[1]).toMatchObject({ type: 'view', name: 'Сайт' });
            expect(String(menu.button[1]?.url)).toContain('https://example.com');
            expect(menu.button[2]).toEqual({ type: 'click', name: 'Помощь', key: 'Помощь' });
        });

        it('обрезает название до 16 байт и пропускает слишком длинный ключ', () => {
            const buttons = new Buttons(appContext);
            buttons.addBtn('Очень длинное название', null, 'k');
            buttons.addBtn('Ключ', null, 'x'.repeat(129));
            const menu = buttons.getButtons(WeChatButton.menuButtonsProcessing) as {
                button: { name: string }[];
            };
            expect(menu.button).toHaveLength(1);
            expect(Buffer.byteLength(menu.button[0]!.name, 'utf8')).toBeLessThanOrEqual(16);
            expect(menu.button[0]!.name).toBe('Очень дл');
        });

        it('без кнопок — null', () => {
            expect(WeChatButton.menuButtonsProcessing([])).toBeNull();
        });
    });

    describe('просроченный media_id без БД', () => {
        it('без DB-адаптера кэша нет: файл просто загружается заново', async () => {
            appContext.database.adapter = null as never;
            sendImage.mockImplementation(async (_user: string, mediaId: string) => {
                mockApi.lastErrorCode = mediaId === 'old_media' ? 40007 : undefined;
                return mediaId === 'old_media' ? null : { errcode: 0, errmsg: 'ok' };
            });
            uploadImage.mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'new_media' });
            const { WeChatRequest } = jest.requireMock('../src/API/WeChatRequest') as {
                WeChatRequest: new (ctx: AppContext) => never;
            };
            const res = await WeChatCard.sendImageWithRefresh(
                controller,
                new WeChatRequest(appContext),
                'old_media',
                './photo.jpg',
            );
            expect(res?.mediaId).toBe('new_media');
        });

        it('без пути к файлу загрузить заново нечего', async () => {
            sendVoice.mockImplementation(async () => {
                mockApi.lastErrorCode = 40007;
                return null;
            });
            const { WeChatRequest } = jest.requireMock('../src/API/WeChatRequest') as {
                WeChatRequest: new (ctx: AppContext) => never;
            };
            expect(
                await WeChatSound.sendVoiceWithRefresh(
                    controller,
                    new WeChatRequest(appContext),
                    'old_voice',
                ),
            ).toBeNull();
            expect(uploadVoice).not.toHaveBeenCalled();
        });
    });

    describe('controller.api', () => {
        it('sendPhoto загружает файл, отправляет его и подпись отдельным сообщением', async () => {
            uploadImage.mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'm1' });
            sendImage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
            const api = makeWeChatApi(controller);
            expect(await api.sendPhoto?.('./photo.jpg', { caption: 'Фото' })).toEqual({
                errcode: 0,
                errmsg: 'ok',
            });
            expect(sendImage).toHaveBeenCalledWith('open_1', 'm1');
        });

        it('sendPhoto и sendAudio без загруженного файла возвращают null', async () => {
            uploadImage.mockResolvedValue(null);
            uploadVoice.mockResolvedValue(null);
            const api = makeWeChatApi(controller);
            expect(await api.sendPhoto?.('./missing.jpg')).toBeNull();
            expect(await api.sendAudio?.('./missing.mp3')).toBeNull();
        });

        it('sendAudio отправляет голосовое сообщение', async () => {
            uploadVoice.mockResolvedValue({ errcode: 0, errmsg: 'ok', media_id: 'v1' });
            sendVoice.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
            const api = makeWeChatApi(controller);
            expect(await api.sendAudio?.('./a.mp3', { caption: 'Аудио' })).toEqual({
                errcode: 0,
                errmsg: 'ok',
            });
            expect(sendVoice).toHaveBeenCalledWith('open_1', 'v1');
        });

        it('неподдерживаемые методы возвращают null', async () => {
            const api = makeWeChatApi(controller);
            expect(await api.sendDocument?.('./a.pdf')).toBeNull();
            expect(await api.sendVideo?.('./a.mp4')).toBeNull();
            expect(await api.answerCallback?.('id')).toBeNull();
            expect(api.can?.('sendPhoto')).toBe(true);
            expect(api.can?.('sendDocument')).toBe(false);
        });
    });

    describe('buttonProcessing (устаревший)', () => {
        it('по-прежнему возвращает список кнопок для совместимости', () => {
            const buttons = new Buttons(appContext);
            buttons.addBtn('Каталог', null, 'catalog');
            buttons.addBtn('Сайт', 'https://example.com');
            const res = buttons.getButtons(WeChatButton.buttonProcessing) as {
                buttons: { title: string }[];
            };
            expect(res.buttons.map((button) => button.title)).toEqual(['Каталог', 'Сайт']);
            expect(WeChatButton.buttonProcessing([])).toBeNull();
        });
    });

    describe('truncateUtf8', () => {
        it('не разрывает эмодзи и учитывает многоточие в лимите', () => {
            expect(truncateUtf8('ab😀cd', 6)).toBe('ab😀');
            expect(truncateUtf8('ab😀cd', 5)).toBe('ab');
            expect(truncateUtf8('abcdef', 5, '...')).toBe('ab...');
            expect(truncateUtf8('abc', 5, '...')).toBe('abc');
        });
    });
});
