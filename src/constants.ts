/**
 * Идентификатор платформы. Используется как ключ в `appConfig.tokens`
 * и как значение `controller.appType`.
 */
export const T_WECHAT = 'wechat';

/**
 * Лимит текста одного сообщения Customer Service API (2048 байт).
 * Более длинный текст WeChat отклоняет целиком.
 */
export const WECHAT_MAX_TEXT_LENGTH = 2048;

/**
 * Сколько кнопок имеет смысл выводить списком под текстом ответа.
 * У Customer Service API нет inline-клавиатуры, поэтому кнопки рендерятся текстом.
 */
export const WECHAT_MAX_BUTTONS = 8;
