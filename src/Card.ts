import { ICardInfo, ImageTokens, BotController } from 'umbot';
import { WeChatRequest } from './API/WeChatRequest';
import { pUtils } from 'umbot/plugins';
import { T_WECHAT, WECHAT_INVALID_MEDIA_ID } from './constants';
import { IWeChatResult } from './IWeChatPlatform';

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
 * Удаляет сохранённый media_id изображения из кэша токенов.
 * @param controller Контроллер приложения
 * @param path Путь к файлу изображения
 */
async function forgetImageToken(controller: BotController, path: string): Promise<void> {
    if (!controller.appContext.database.adapter) {
        return;
    }
    const model = new ImageTokens(controller.appContext);
    if (await model.whereOne({ platform: T_WECHAT, path })) {
        await model.remove();
    }
}

/**
 * Отправляет изображение по media_id. WeChat хранит загруженный файл 3 дня, а кэш токенов —
 * бессрочно: если WeChat отверг сохранённый media_id, он удаляется из кэша, файл загружается
 * заново и отправка повторяется один раз.
 *
 * @param controller Контроллер приложения
 * @param api Клиент WeChat
 * @param mediaId media_id изображения
 * @param path Путь к файлу; без него загрузить заново нечего
 * @returns Ответ WeChat и media_id, который ушёл пользователю (новый, если файл загружался
 *   заново), либо `null` при ошибке
 *
 * @example
 * ```ts
 * const mediaId = await getImageInDB(controller, './photo.jpg');
 * if (mediaId) {
 *     const api = new WeChatRequest(controller.appContext);
 *     await sendImageWithRefresh(controller, api, mediaId, './photo.jpg');
 * }
 * ```
 */
export async function sendImageWithRefresh(
    controller: BotController,
    api: WeChatRequest,
    mediaId: string,
    path?: string | null,
): Promise<{ result: IWeChatResult; mediaId: string } | null> {
    const userId = controller.userId as string;
    const res = await api.sendImage(userId, mediaId);
    if (res) {
        return { result: res, mediaId };
    }
    if (!path || api.lastErrorCode !== WECHAT_INVALID_MEDIA_ID) {
        return null;
    }
    await forgetImageToken(controller, path);
    const freshId = await getImageInDB(controller, path);
    const fresh = freshId ? await api.sendImage(userId, freshId) : null;
    return fresh && freshId ? { result: fresh, mediaId: freshId } : null;
}

/**
 * Отправляет изображения карточки пользователю через Customer Service API.
 *
 * WeChat не умеет галерей: каждое изображение уходит отдельным сообщением. Подписи сюда
 * не входят — адаптер дописывает их в текст ответа: Customer Service API разрешает лишь
 * несколько сообщений на одно действие пользователя.
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

    for (const image of cardInfo.images) {
        try {
            if (!image.imageToken && image.imageDir) {
                image.imageToken = await getImageInDB(controller, image.imageDir);
            }
            const sent = image.imageToken
                ? await sendImageWithRefresh(controller, api, image.imageToken, image.imageDir)
                : null;
            if (sent) {
                image.imageToken = sent.mediaId;
                mediaIds.push(sent.mediaId);
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
