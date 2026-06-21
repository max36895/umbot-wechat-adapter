/**
 * Интерфейсы для работы с WeChat Official Account
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
 */

/** Информация об отправителе */
export interface IWeChatFromUser {
    FromUserName: string;
    CreateTime: number;
    MsgType: string;
    MsgId?: number;
    MediaId?: string;
    PicUrl?: string;
    Recognition?: string;
    Format?: string;
    Title?: string;
    Description?: string;
    Url?: string;
    ThumbMediaId?: string;
    Event?: string;
    EventKey?: string;
    Ticket?: string;
    Status?: string;
}

/** Входящий запрос от WeChat (распарсенный из XML) */
export interface IWeChatRequestContent {
    ToUserName: string;
    FromUserName: string;
    CreateTime: number;
    MsgType: string;
    Content?: string;
    MediaId?: string;
    PicUrl?: string;
    Recognition?: string;
    Format?: string;
    Title?: string;
    Description?: string;
    Url?: string;
    ThumbMediaId?: string;
    MsgId?: number;
    Event?: string;
    EventKey?: string;
    Ticket?: string;
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

/** Дополнительные опции конструктора WeChatAdapter */
export interface IWeChatAdapterOptions {
    app_id?: string;
    app_secret?: string;
    encoding_aes_key?: string;
}

/** Кнопка WeChat */
export interface IWeChatButton {
    title: string;
    url?: string;
    callback_data?: Record<string, unknown> | string;
}

/** Клавиатура WeChat */
export interface IWeChatKeyboard {
    buttons?: IWeChatButton[];
}
