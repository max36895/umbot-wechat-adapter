import { ISoundInfo, Text, SoundTokens, isFile, BotController } from 'umbot';
import { WeChatRequest } from './API/WeChatRequest';
import { pUtils } from 'umbot/plugins';
import { T_WECHAT, WECHAT_INVALID_MEDIA_ID } from './constants';
import { IWeChatResult } from './IWeChatPlatform';

// О ссылке вместо файла предупреждаем один раз за процесс: звуки берутся из кода, и
// предупреждение на каждом ответе только засоряло бы лог
let urlWarned = false;

/**
 * Возвращает media_id аудиофайла: из кэша токенов в БД либо после загрузки в WeChat.
 *
 * Отправкой не занимается — за неё отвечает {@link soundProcessing}, иначе
 * свежезагруженный файл (cache miss) пользователю не уходил вовсе.
 *
 * @param controller Контроллер приложения
 * @param path Путь к аудиофайлу (AMR или MP3, до 2 МБ и 60 секунд)
 * @returns media_id либо `null`
 */
export async function getSoundInDB(
    controller: BotController,
    path: string,
): Promise<string | null> {
    return pUtils.getSoundToken(path, T_WECHAT, controller, async (model: SoundTokens) => {
        const api = new WeChatRequest(controller.appContext);
        const media = await api.uploadVoice(path);
        if (media?.media_id) {
            model.soundToken = media.media_id;
            // Кэш — оптимизация: media_id возвращается независимо от записи в БД.
            await pUtils.cacheMediaToken(model, controller);
            return model.soundToken;
        }
        return null;
    });
}

/**
 * Удаляет сохранённый media_id аудиофайла из кэша токенов.
 * @param controller Контроллер приложения
 * @param path Путь к аудиофайлу
 */
async function forgetSoundToken(controller: BotController, path: string): Promise<void> {
    if (!controller.appContext.database.adapter) {
        return;
    }
    const model = new SoundTokens(controller.appContext);
    if (await model.whereOne({ platform: T_WECHAT, path })) {
        await model.remove();
    }
}

/**
 * Отправляет голосовое сообщение по media_id. Просроченный media_id (WeChat хранит файл
 * 3 дня) удаляется из кэша, файл загружается заново и отправка повторяется один раз.
 *
 * @param controller Контроллер приложения
 * @param api Клиент WeChat
 * @param mediaId media_id аудиофайла
 * @param path Путь к файлу; без него загрузить заново нечего
 * @returns Ответ WeChat и media_id, который ушёл пользователю (новый, если файл загружался
 *   заново), либо `null` при ошибке
 *
 * @example
 * ```ts
 * const mediaId = await getSoundInDB(controller, './hello.mp3');
 * if (mediaId) {
 *     const api = new WeChatRequest(controller.appContext);
 *     await sendVoiceWithRefresh(controller, api, mediaId, './hello.mp3');
 * }
 * ```
 */
export async function sendVoiceWithRefresh(
    controller: BotController,
    api: WeChatRequest,
    mediaId: string,
    path?: string | null,
): Promise<{ result: IWeChatResult; mediaId: string } | null> {
    const userId = controller.userId as string;
    const res = await api.sendVoice(userId, mediaId);
    if (res) {
        return { result: res, mediaId };
    }
    if (!path || api.lastErrorCode !== WECHAT_INVALID_MEDIA_ID) {
        return null;
    }
    await forgetSoundToken(controller, path);
    const freshId = await getSoundInDB(controller, path);
    const fresh = freshId ? await api.sendVoice(userId, freshId) : null;
    return fresh && freshId ? { result: fresh, mediaId: freshId } : null;
}

/**
 * Обработка звуков для WeChat (голосовые сообщения через Customer Service API).
 *
 * Каждый звук — файл AMR или MP3 — отправляется отдельным сообщением. `tts` голосом не
 * синтезируется: SpeechKit отдаёт OGG/Opus, а WeChat принимает голос только в AMR и MP3.
 * Озвучка доходит до пользователя текстом — её отправляет адаптер.
 *
 * @param soundInfo Описание звуков
 * @param controller Контроллер приложения
 * @returns Список отправленных media_id
 */
export async function soundProcessing(
    soundInfo: ISoundInfo,
    controller: BotController,
): Promise<string[]> {
    const { sounds } = soundInfo;
    const api = new WeChatRequest(controller.appContext);
    const data: string[] = [];

    for (const sound of sounds ?? []) {
        if (sound.sounds === undefined || sound.key === undefined) {
            continue;
        }
        const path: string | null = Text.getText(sound.sounds);
        if (!path) {
            continue;
        }
        if (Text.isUrl(path)) {
            if (!urlWarned) {
                urlWarned = true;
                controller.appContext.logWarn(
                    `WeChat.soundProcessing(): звук по ссылке ("${path}") не отправлен — WeChat принимает только загрузку файла. Скачайте файл и укажите локальный путь.`,
                );
            }
            continue;
        }
        // Произвольная строка (маркер звука голосовой платформы) в WeChat смысла не имеет
        if (!(await isFile(path))) {
            continue;
        }
        const mediaId = await getSoundInDB(controller, path);
        const sent = mediaId ? await sendVoiceWithRefresh(controller, api, mediaId, path) : null;
        if (sent) {
            data.push(sent.mediaId);
        }
    }
    return data;
}
