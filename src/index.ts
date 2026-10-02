export { WeChatAdapter } from './Adapter';
export * from './IWeChatPlatform';
/**
 * Кнопки WeChat: меню Official Account (`buttonProcessing`) и рендер вариантов
 * ответа текстом (`buttonsToText`) — inline-клавиатуры у платформы нет.
 */
export * as WeChatButton from './Button';
/**
 * Звуки WeChat: загрузка аудио в media/upload и озвучка tts через Yandex SpeechKit.
 */
export * as WeChatSound from './Sound';
/**
 * Карточки WeChat: изображения уходят отдельными сообщениями Customer Service API.
 */
export * as WeChatCard from './Card';
export { WeChatRequest } from './API/WeChatRequest';
export { makeWeChatApi } from './apiFacade';
/**
 * Транспортный слой: разбор XML-тела вебхука, проверка подписи и верификация URL.
 * Нужны, потому что ядро umbot принимает только JSON и только POST.
 */
export {
    parseWeChatXml,
    verifyWeChatSignature,
    handleWeChatVerification,
    WECHAT_MAX_XML_LENGTH,
} from './webhook';
export { T_WECHAT, WECHAT_MAX_TEXT_LENGTH, WECHAT_MAX_BUTTONS } from './constants';
