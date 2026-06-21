import { IButtonType } from 'umbot';
import { IWeChatButton, IWeChatKeyboard } from './IWeChatPlatform';
import { pUtils } from 'umbot/plugins';

/**
 * Преобразует кнопки umbot в формат клавиатуры WeChat.
 */
export function buttonProcessing(buttons: IButtonType[]): IWeChatKeyboard | null {
    const wechatButtons: IWeChatButton[] = [];

    pUtils.getCorrectButtons(buttons, 8).forEach((button) => {
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
