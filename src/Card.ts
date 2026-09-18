import { ICardInfo, ImageTokens, BotController } from 'umbot';
import { WeChatRequest } from './API/WeChatRequest';
import { pUtils } from 'umbot/plugins';
import { T_WECHAT } from './constants';

/**
 * Возвращает media_id изображения: из кэша токенов в БД либо после загрузки в WeChat.
 *
 * Отправкой здесь не занимается — за неё отвечает {@link cardProcessing}, иначе
 * свежезагруженная картинка (cache miss) пользователю не уходила вовсе, а
 * закэшированная отправлялась дважды.
 *
 * @param controller Контроллер приложения
 * @param path Путь к файлу изображения
 * @returns media_id либо `null`
 */
export async function getImageInDB(
    controller: BotController,
    path: string,
): Promise<string | null> {
    return pUtils.getImageToken(path, T_WECHAT, controller, async (model: ImageTokens) => {
        const api = new WeChatRequest(controller.appContext);
        const media = await api.uploadImage(path);
        if (media?.media_id) {
            model.imageToken = media.media_id;
            // Кэш — оптимизация: media_id уже получен и должен быть возвращён
            // независимо от того, удалось ли записать его в БД (её может не быть).
            await pUtils.cacheMediaToken(model, controller);
            return model.imageToken;
        }
        return null;
    });
}

/**
 * Отправляет изображения карточки пользователю через Customer Service API.
 *
 * WeChat не умеет галерей: каждое изображение уходит отдельным сообщением.
 *
 * @param cardInfo Данные карточки
 * @param controller Контроллер приложения
 * @returns Список отправленных media_id либо `null`, если отправить нечего
 */
export async function cardProcessing(
    cardInfo: ICardInfo,
    controller: BotController,
): Promise<string[] | null> {
    const api = new WeChatRequest(controller.appContext);
    const mediaIds: string[] = [];

    for (let i = 0; i < cardInfo.images.length; i++) {
        const image = cardInfo.images[i];
        try {
            if (!image.imageToken && image.imageDir) {
                image.imageToken = await getImageInDB(controller, image.imageDir);
            }
            if (image.imageToken) {
                await api.sendImage(controller.userId as string, image.imageToken);
                mediaIds.push(image.imageToken);
                // Подпись отдельным сообщением: у msgtype image в WeChat её нет.
                const caption = image.title || image.desc;
                if (caption) {
                    await api.sendTextMessage(controller.userId as string, caption);
                }
            }
        } catch (e) {
            controller.appContext.logError(
                'WeChat.cardProcessing(): Ошибка при отправке изображения',
                { error: e },
            );
        }
    }
    return mediaIds.length > 0 ? mediaIds : null;
}
