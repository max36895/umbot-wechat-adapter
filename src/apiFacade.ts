import type { BotController, IApiMediaParams, IControllerApi, TApiMethod } from 'umbot';
import { WeChatRequest } from './API/WeChatRequest';
import { getImageInDB } from './Card';
import { getSoundInDB } from './Sound';

/**
 * API-фасад WeChat для `controller.api`.
 *
 * Даёт бизнес-логике единый контракт `IControllerApi`: отправить фото или аудио
 * прямо из обработчика, не собирая карточку. Ограничения платформы:
 * - документы и видео Customer Service API из коробки не принимает
 *   (`media/upload` поддерживает только image/voice/video с thumb, а video
 *   требует отдельного description-конверта);
 * - callback-уведомлений (answerCallback) в WeChat нет;
 * - файлы загружаются только локальным путём — ссылку WeChat не примет.
 *
 * @param controller Контроллер текущего запроса
 * @returns Фасад `IControllerApi`
 */
export function makeWeChatApi(controller: BotController): IControllerApi {
    const warn = (method: string, reason: string): null => {
        controller.appContext?.logWarn(`controller.api.${method}(): ${reason}`);
        return null;
    };

    return {
        async sendPhoto(
            image: string,
            params?: IApiMediaParams,
        ): Promise<Record<string, unknown> | null> {
            const mediaId = await getImageInDB(controller, image);
            if (!mediaId) {
                return warn('sendPhoto', `не удалось загрузить изображение "${image}" в WeChat.`);
            }
            const api = new WeChatRequest(controller.appContext);
            const res = await api.sendImage(controller.userId as string, mediaId);
            // У msgtype image в WeChat нет подписи — отправляем её отдельным сообщением.
            if (params?.caption) {
                await api.sendTextMessage(controller.userId as string, params.caption);
            }
            return res as unknown as Record<string, unknown> | null;
        },

        async sendAudio(
            file: string,
            params?: IApiMediaParams,
        ): Promise<Record<string, unknown> | null> {
            const mediaId = await getSoundInDB(controller, file);
            if (!mediaId) {
                return warn('sendAudio', `не удалось загрузить аудио "${file}" в WeChat.`);
            }
            const api = new WeChatRequest(controller.appContext);
            const res = await api.sendVoice(controller.userId as string, mediaId);
            if (params?.caption) {
                await api.sendTextMessage(controller.userId as string, params.caption);
            }
            return res as unknown as Record<string, unknown> | null;
        },

        async sendDocument(): Promise<Record<string, unknown> | null> {
            return warn(
                'sendDocument',
                'Customer Service API WeChat не поддерживает отправку произвольных файлов.',
            );
        },

        async sendVideo(): Promise<Record<string, unknown> | null> {
            return warn(
                'sendVideo',
                'отправка видео в WeChat требует отдельной загрузки с thumb_media_id — используйте WeChatRequest напрямую.',
            );
        },

        async answerCallback(): Promise<Record<string, unknown> | null> {
            return warn('answerCallback', 'в WeChat нет callback-уведомлений.');
        },

        can(method: TApiMethod): boolean {
            return method === 'sendPhoto' || method === 'sendAudio';
        },
    };
}
