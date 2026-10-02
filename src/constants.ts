/**
 * Идентификатор платформы. Используется как ключ в `appConfig.tokens`
 * и как значение `controller.appType`.
 */
export const T_WECHAT = 'wechat';

/**
 * Лимит текста одного сообщения Customer Service API — 2048 байт UTF-8 (кириллица и
 * китайский занимают 2–3 байта на символ). Более длинный текст WeChat отклоняет целиком.
 */
export const WECHAT_MAX_TEXT_LENGTH = 2048;

/**
 * Код ошибки WeChat «недопустимый media_id»: так WeChat отвечает и на просроченный
 * временный файл (хранится 3 дня).
 */
export const WECHAT_INVALID_MEDIA_ID = 40007;

/**
 * Сколько кнопок имеет смысл выводить списком под текстом ответа.
 * У Customer Service API нет inline-клавиатуры, поэтому кнопки рендерятся текстом.
 */
export const WECHAT_MAX_BUTTONS = 8;
