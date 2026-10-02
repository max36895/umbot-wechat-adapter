import { IButtonType } from 'umbot';
import { IWeChatButton, IWeChatKeyboard, IWeChatMenu, IWeChatMenuButton } from './IWeChatPlatform';
import { pUtils } from 'umbot/plugins';
import { WECHAT_MAX_BUTTONS } from './constants';
import { truncateUtf8 } from './utils';

// Ограничения menu/create: до 3 пунктов верхнего уровня, название до 16 байт,
// ключ CLICK до 128 байт, ссылка до 1024 байт
const MENU_MAX_BUTTONS = 3;
const MENU_NAME_MAX_BYTES = 16;
const MENU_KEY_MAX_BYTES = 128;
const MENU_URL_MAX_BYTES = 1024;

/**
 * Преобразует кнопки umbot в тело запроса `menu/create` — меню Official Account.
 *
 * Меню у WeChat статичное: оно настраивается один раз этим методом API и не привязано к
 * ответу. Кнопка со ссылкой становится пунктом `view`, остальные — `click`: нажатие
 * приходит событием CLICK с `key` = payload кнопки (или её названием), и адаптер
 * передаёт его в `addAction`/`addCommand`. Пункты сверх 3, со слишком длинным ключом
 * или ссылкой пропускаются; длинное название обрезается до 16 байт.
 *
 * @param buttons Кнопки в формате umbot
 * @returns Тело `menu/create` либо `null`, если подходящих кнопок нет
 *
 * @example
 * ```ts
 * const buttons = new Buttons(appContext);
 * buttons.addBtn('Каталог', null, 'catalog');
 * buttons.addBtn('Сайт', 'https://example.com');
 * const menu = buttons.getButtons(WeChatButton.menuButtonsProcessing);
 * // POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=... с телом menu
 * ```
 */
export function menuButtonsProcessing(buttons: IButtonType[]): IWeChatMenu | null {
    const menu: IWeChatMenuButton[] = [];
    for (const button of pUtils.getCorrectButtons(buttons, WECHAT_MAX_BUTTONS)) {
        const title = (button.title || '').trim();
        if (!title || menu.length >= MENU_MAX_BUTTONS) {
            continue;
        }
        const name = truncateUtf8(title, MENU_NAME_MAX_BYTES);
        if (button.url) {
            if (Buffer.byteLength(button.url, 'utf8') <= MENU_URL_MAX_BYTES) {
                menu.push({ type: 'view', name, url: button.url });
            }
            continue;
        }
        const payload = button.payload;
        const key =
            payload === undefined || payload === null || payload === ''
                ? title
                : typeof payload === 'string'
                  ? payload
                  : JSON.stringify(payload);
        if (Buffer.byteLength(key, 'utf8') <= MENU_KEY_MAX_BYTES) {
            menu.push({ type: 'click', name, key });
        }
    }
    return menu.length ? { button: menu } : null;
}

/**
 * Преобразует кнопки umbot в список `{ title, url, callback_data }`.
 *
 * ⚠️ У Customer Service API WeChat нет inline-клавиатуры: единственное «меню» —
 * статичное меню Official Account, которое настраивается отдельным вызовом
 * `menu/create` и не привязано к конкретному ответу. Функция оставлена для тех,
 * кто строит такое меню сам; в ответ пользователю адаптер отправляет кнопки
 * текстом — см. {@link buttonsToText}.
 *
 * @param buttons Кнопки в формате umbot
 * @returns Структура клавиатуры либо `null`, если кнопок нет
 * @deprecated Это не формат `menu/create`: WeChat его не примет. Используйте {@link menuButtonsProcessing}.
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
