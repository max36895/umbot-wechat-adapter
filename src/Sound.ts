import { ISoundInfo, Text, SoundTokens, isFile, unlink, BotController } from 'umbot';
import { WeChatRequest } from './API/WeCharRequest';
import { pUtils, YandexSpeechKit } from 'umbot/plugins';
import { T_WECHAT } from './constants';

/**
 * Получение media_id для аудиофайла в WeChat.
 */
export async function getSoundInDB(
    controller: BotController,
    path: string,
): Promise<string | null> {
    let isCbCalled = false;
    const result = await pUtils.getSoundToken(
        path,
        T_WECHAT,
        controller,
        async (model: SoundTokens) => {
            const api = new WeChatRequest(controller.appContext);
            const media = await api.uploadVoice(path);
            isCbCalled = true;
            if (media?.media_id) {
                model.soundToken = media.media_id;
                if (await model.save(true)) {
                    return model.soundToken;
                }
            }
            return null;
        },
    );

    if (!isCbCalled && result) {
        await new WeChatRequest(controller.appContext).sendVoice(
            controller.userId as string,
            result,
        );
    }
    return result;
}

/**
 * Обработка звуков для WeChat (AMR/SILK через Customer Service API).
 */
export async function soundProcessing(
    soundInfo: ISoundInfo,
    controller: BotController,
): Promise<string[]> {
    const { sounds, text } = soundInfo;
    const data: string[] = [];

    if (sounds) {
        for (let i = 0; i < sounds.length; i++) {
            const sound = sounds[i];
            if (sound.sounds !== undefined && sound.key !== undefined) {
                let sText: string | null = Text.getText(sound.sounds);
                if (Text.isUrl(sText) || (await isFile(sText))) {
                    sText = await getSoundInDB(controller, sText);
                } else {
                    await new WeChatRequest(controller.appContext).sendVoice(
                        controller.userId as string,
                        sText,
                    );
                }
                if (sText) {
                    data.push(sText);
                }
            }
        }
    }

    if (text) {
        const speechKit = new YandexSpeechKit(
            controller.appContext.appConfig.tokens[T_WECHAT].speech_kit_token + '',
            controller.appContext,
        );
        const content = await speechKit.getTts(text);
        if (content) {
            const voiceMediaId = await new WeChatRequest(controller.appContext).uploadVoice(
                content.fileName,
            );
            if (voiceMediaId?.media_id) {
                await new WeChatRequest(controller.appContext).sendVoice(
                    controller.userId as string,
                    voiceMediaId.media_id,
                );
                data.push(voiceMediaId.media_id);
            }
            await unlink(content.fileName);
        }
    }
    return data;
}
