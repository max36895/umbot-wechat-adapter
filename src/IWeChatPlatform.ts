/**
 * Интерфейсы для работы с WeChat Official Account
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
 */

/** Входящий запрос от WeChat (распарсенный из XML) */
export interface IWeChatRequestContent {
    /** OpenID Official Account (получатель) */
    ToUserName: string;
    /** OpenID отправителя — используется как `controller.userId` */
    FromUserName: string;
    /** Время отправки, unix-time в секундах */
    CreateTime: number;
    /** Тип сообщения: text, image, voice, video, shortvideo, location, link, event */
    MsgType: string;
    /** Текст сообщения (MsgType: text) */
    Content?: string;
    /** Идентификатор медиафайла */
    MediaId?: string;
    /** Ссылка на изображение (MsgType: image) */
    PicUrl?: string;
    /** Распознанный текст голосового сообщения (MsgType: voice) */
    Recognition?: string;
    /** Формат голосового сообщения (amr, speex) */
    Format?: string;
    /** Заголовок ссылки (MsgType: link) */
    Title?: string;
    /** Описание ссылки (MsgType: link) */
    Description?: string;
    /** URL (MsgType: link) */
    Url?: string;
    /** Идентификатор превью видео */
    ThumbMediaId?: string;
    /** Широта (MsgType: location) */
    Location_X?: number;
    /** Долгота (MsgType: location) */
    Location_Y?: number;
    /** Масштаб карты (MsgType: location) */
    Scale?: number;
    /** Текстовое описание места (MsgType: location) */
    Label?: string;
    /** Широта (Event: LOCATION — фоновая отправка геопозиции) */
    Latitude?: number;
    /** Долгота (Event: LOCATION) */
    Longitude?: number;
    /** Точность геопозиции (Event: LOCATION) */
    Precision?: number;
    /** Идентификатор сообщения; у событий отсутствует */
    MsgId?: number;
    /** Тип события (MsgType: event): subscribe, unsubscribe, SCAN, CLICK, VIEW, LOCATION */
    Event?: string;
    /** Полезная нагрузка события: ключ пункта меню или сценарий QR-кода */
    EventKey?: string;
    /** Тикет QR-кода (события subscribe/SCAN) */
    Ticket?: string;
    /** Статус служебного события */
    Status?: string;
}

/** Параметры для отправки через Customer Service API */
export interface IWeChatParams {
    touser: string;
    msgtype: string;
    content?: string;
    media_id?: string;
    thumb_media_id?: string;
    title?: string;
    description?: string;
    articles?: IWeChatArticle[];
    msgid?: string;
}

/** Статья для news-сообщения */
export interface IWeChatArticle {
    title: string;
    description: string;
    picurl: string;
    url: string;
}

/** Ответ WeChat API */
export interface IWeChatResult {
    errcode: number;
    errmsg: string;
}

/** Ответ API загрузки медиа */
export interface IWeChatMediaResult extends IWeChatResult {
    type?: string;
    media_id?: string;
    created_at?: number;
}

/** Ответ API получения access_token */
export interface IWeChatTokenResult {
    access_token: string;
    expires_in: number;
    errcode?: number;
    errmsg?: string;
}

/** Ответ API получения информации о пользователе */
export interface IWeChatUserInfo {
    openid: string;
    nickname: string;
    sex: number;
    province: string;
    city: string;
    country: string;
    headimgurl: string;
    privilege: string[];
    unionid?: string;
    errcode?: number;
    errmsg?: string;
}

/**
 * Дополнительные опции конструктора WeChatAdapter
 * (второй аргумент `new WeChatAdapter(token, options)`).
 */
export interface IWeChatAdapterOptions {
    /** AppID Official Account — нужен для получения access_token */
    app_id?: string;
    /** AppSecret Official Account */
    app_secret?: string;
    /** Ключ шифрования сообщений (режим Safe Mode); адаптером пока не используется */
    encoding_aes_key?: string;
    /**
     * Запрашивать имя пользователя через `user/info` на входящем сообщении
     * и класть его в `controller.nlu.thisUser`.
     *
     * По умолчанию выключено: это дополнительный HTTP-запрос на каждое сообщение,
     * а у метода жёсткий суточный лимит. Результат кэшируется в памяти процесса.
     */
    fetch_user_info?: boolean;
}

/** Кнопка меню WeChat (см. Button.buttonProcessing) */
export interface IWeChatButton {
    title: string;
    url?: string;
    callback_data?: Record<string, unknown> | string;
}

/** Меню WeChat (см. Button.buttonProcessing) */
export interface IWeChatKeyboard {
    buttons?: IWeChatButton[];
}
