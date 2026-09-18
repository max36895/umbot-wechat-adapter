import { IButtonType } from 'umbot';
import { IWeChatButton, IWeChatKeyboard } from './IWeChatPlatform';
import { pUtils } from 'umbot/plugins';
import { WECHAT_MAX_BUTTONS } from './constants';

/**
 * Преобразует кнопки umbot в структуру клавиатуры WeChat.
 *
 * ⚠️ У Customer Service API WeChat нет inline-клавиатуры: единственное «меню» —
 * статичное меню Official Account, которое настраивается отдельным вызовом
 * `menu/create` и не привязано к конкретному ответу. Функция оставлена для тех,
 * кто строит такое меню сам; в ответ пользователю адаптер отправляет кнопки
 * текстом — см. {@link buttonsToText}.
 *
 * @param buttons Кнопки в формате umbot
 * @returns Структура клавиатуры либо `null`, если кнопок нет
 */
export function buttonProcessing(buttons: IButtonType[]): IWeChatKeyboard | null {
    const wechatButtons: IWeChatButton[] = [];

    pUtils.getCorrectButtons(buttons, WECHAT_MAX_BUTTONS).forEach((button) => {
        const wechatButton: IWeChatButton = {
            title: button.title || '',
        };
        if (button.url) {
            wechatButton.url = button.url;
        }
        if (button.payload) {
            wechatButton.callback_data = button.payload;
        }
        wechatButtons.push(wechatButton);
    });

    if (wechatButtons.length > 0) {
        return { buttons: wechatButtons };
    }
    return null;
}

/**
 * Рендерит кнопки текстовым списком — так варианты ответа доходят до пользователя
 * на платформе без клавиатуры.
 *
 * Кнопка со ссылкой печатается как `Название: url`, обычная — просто названием;
 * кнопки без названия пропускаются (пустой пункт отправлять бессмысленно).
 *
 * @param buttons Кнопки в формате umbot
 * @returns Текст со списком вариантов либо `null`, если выводить нечего
 *
 * @example
 * ```text
 * • Каталог
 * • Поддержка: https://example.com/help
 * ```
 */
export function buttonsToText(buttons: IButtonType[]): string | null {
    const lines = pUtils
        .getCorrectButtons(buttons, WECHAT_MAX_BUTTONS)
        .map((button) => {
            const title = (button.title || '').trim();
            if (!title) {
                return null;
            }
            return button.url ? `• ${title}: ${button.url}` : `• ${title}`;
        })
        .filter((line): line is string => line !== null);

    return lines.length ? lines.join('\n') : null;
}
