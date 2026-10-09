/**
 * Рекламные и трекинговые эндпоинты внутри embed-плееров.
 *
 * Регистрируется как webRequest.onBeforeRequest-фильтр в main: плееры грузят
 * VAST-креативы, рекламные конфиги и беконы до/во время потока — их отмена
 * пропускает рекламу и ускоряет подключение медиа (модули видеоплееров
 * падают в тихий fallback и сразу идут к контенту). Фильтр вынесен в
 * отдельный модуль — main подключает его к webRequest напрямую.
 */
const AD_RE = new RegExp(
  [
    'doubleclick\\.net',
    'googlesyndication\\.com',
    'googleadservices\\.com',
    'adnxs\\.com',
    'criteo\\.(com|net)',
    'taboola\\.com',
    'outbrain\\.com',
    'adform\\.net',
    'rubiconproject\\.com',
    'pubmatic\\.com',
    'openx\\.net',
    'smartadserver\\.com',
    'advertising\\.com',
    'adsterra\\.(com|net)',
    'exoclick\\.(com|net)',
    'popads\\.net',
    'hilltopads\\.net',
    'monetag\\.com',
    'adcash\\.com',
    'propellerads\\.com',
    'seedtag\\.com',
    'teads\\.tv',
    'adfox',
    'adsbygoogle',
    'pagead2\\.',
    'imasdk',
    '\\/vast[/?]',
    'vast\\.xml',
    '\\/ad-tags',
    'adserver',
    'prebid',
    '\\/ads?\\/',
    '\\/banner-ads',
    '\\/promo-ads',
  ].join('|'),
  'i',
);

export function shouldBlockAd(url: string): boolean {
  return AD_RE.test(url);
}
