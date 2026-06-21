import { ICardInfo, ImageTokens, BotController } from 'umbot';
import { WeChatRequest } from './API/WeCharRequest';
import { pUtils } from 'umbot/plugins';
import { T_WECHAT } from './constants';

/**
 * Получение media_id для изображения в WeChat.
 */
export async function getImageInDB(
    controller: BotController,
    path: string,
): Promise<string | null> {
    let isCbCalled = false;
    const result = await pUtils.getImageToken(
        path,
        T_WECHAT,
        controller,
        async (model: ImageTokens) => {
            const api = new WeChatRequest(controller.appContext);
            const media = await api.uploadImage(path);
            isCbCalled = true;
            if (media?.media_id) {
                model.imageToken = media.media_id;
                if (await model.save(true)) {
                    return model.imageToken;
                }
            }
            return null;
        },
    );

    if (!isCbCalled && result) {
        await new WeChatRequest(controller.appContext).sendImage(
            controller.userId as string,
            result,
        );
    }
    return result;
}

/**
 * Получает карточку для отображения в WeChat.
 */
export async function cardProcessing(
    cardInfo: ICardInfo,
    controller: BotController,
): Promise<string[] | null> {
    const mediaIds: string[] = [];
    for (let i = 0; i < cardInfo.images.length; i++) {
        const image = cardInfo.images[i];
        try {
            if (!image.imageToken) {
                if (image.imageDir) {
                    image.imageToken = await getImageInDB(controller, image.imageDir);
                }
            } else {
                await new WeChatRequest(controller.appContext).sendImage(
                    controller.userId as string,
                    image.imageToken,
                );
            }
            if (image.imageToken) {
                mediaIds.push(image.imageToken);
            }
        } catch (e) {
            controller.appContext.logError(
                'WeChat.cardProcessing(): Ошибка при загрузке изображения',
                { error: e },
            );
        }
    }
    return mediaIds.length > 0 ? mediaIds : null;
}
