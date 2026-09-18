import { ISoundInfo, Text, SoundTokens, isFile, unlink, BotController } from 'umbot';
import { WeChatRequest } from './API/WeChatRequest';
import { pUtils, YandexSpeechKit } from 'umbot/plugins';
import { T_WECHAT } from './constants';

/**
 * Возвращает media_id аудиофайла: из кэша токенов в БД либо после загрузки в WeChat.
 *
 * Отправкой не занимается — за неё отвечает {@link soundProcessing}, иначе
 * свежезагруженный файл (cache miss) пользователю не уходил вовсе.
 *
 * @param controller Контроллер приложения
 * @param path Путь к аудиофайлу (AMR/SILK/MP3)
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
 * Обработка звуков для WeChat (голосовые сообщения через Customer Service API).
 *
 * Каждый звук отправляется отдельным сообщением. Если задан `tts` и настроен
 * `speech_kit_token`, текст дополнительно синтезируется через Yandex SpeechKit.
 *
 * @param soundInfo Описание звуков и текста для озвучки
 * @param controller Контроллер приложения
 * @returns Список отправленных media_id
 */
export async function soundProcessing(
    soundInfo: ISoundInfo,
    controller: BotController,
): Promise<string[]> {
    const { sounds, text } = soundInfo;
    const api = new WeChatRequest(controller.appContext);
    const data: string[] = [];

    if (sounds) {
        for (let i = 0; i < sounds.length; i++) {
            const sound = sounds[i];
            if (sound.sounds !== undefined && sound.key !== undefined) {
                const sText: string | null = Text.getText(sound.sounds);
                if (!sText) {
                    continue;
                }
                // media_id можно получить только из файла: URL и локальный путь
                // сначала превращаются в токен, а произвольная строка (маркер
                // звука голосовой платформы) в WeChat смысла не имеет.
                if (!Text.isUrl(sText) && !(await isFile(sText))) {
                    continue;
                }
                const mediaId = await getSoundInDB(controller, sText);
                if (mediaId) {
                    await api.sendVoice(controller.userId as string, mediaId);
                    data.push(mediaId);
                }
            }
        }
    }

    // getSpeechText убирает разметку голосовых платформ (<speaker>, паузы,
    // маркеры #sound#) — иначе SpeechKit зачитал бы её вслух.
    const speechText = pUtils.getSpeechText(text);
    const speechKitToken = controller.appContext.appConfig.tokens[T_WECHAT]?.speech_kit_token;
    if (speechText && speechKitToken) {
        const speechKit = new YandexSpeechKit(String(speechKitToken), controller.appContext);
        const content = await speechKit.getTts(speechText);
        if (content) {
            try {
                const voiceMedia = await api.uploadVoice(content.fileName);
                if (voiceMedia?.media_id) {
                    await api.sendVoice(controller.userId as string, voiceMedia.media_id);
                    data.push(voiceMedia.media_id);
                }
            } finally {
                await unlink(content.fileName);
            }
        }
    }
    return data;
}
