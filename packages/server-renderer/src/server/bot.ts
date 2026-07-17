/**
 * Default crawler detection — one regex shared by every handler (the fetch
 * handler here, the Node handler in `./node`, and the dev handler in
 * `@sigx/vite`, which defaults through the Node one). Bots get
 * `mode: 'blocking'` (complete inline content, no replacement scripts).
 */
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|outbrain|pinterest|vkshare|whatsapp|telegrambot/i;

export function defaultIsBot(userAgent: string): boolean {
    return BOT_UA.test(userAgent);
}
