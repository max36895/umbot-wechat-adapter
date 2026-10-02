/**
 * Обрезает строку до лимита в байтах UTF-8, не разрывая символ.
 * WeChat ограничивает поля в байтах, а кириллица и китайский занимают 2–3 байта на символ.
 * @param text Строка
 * @param maxBytes Лимит, байт
 * @param ellipsis Что дописать при обрезке (входит в лимит)
 * @returns Строка не длиннее `maxBytes` байт
 */
export function truncateUtf8(text: string, maxBytes: number, ellipsis = ''): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return text;
    }
    const limit = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
    let bytes = 0;
    let result = '';
    for (const char of text) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > limit) {
            break;
        }
        bytes += size;
        result += char;
    }
    return result + ellipsis;
}
