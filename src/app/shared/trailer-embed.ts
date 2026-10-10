/**
 * URL вкладки «Трейлер» → рабочий embed для iframe: YouTube — в nocookie
 * (Referer для него подставляет main.ts), RuTube — в play/embed; на всё
 * остальное полагаться не стоит — лучше поискать трейлер заново.
 *
 * Общая утилита: details (модалка «Трейлер») и тизер при наведении на
 * постер (media-card) используют один и тот же маппинг.
 */
export function toTrailerEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('rutube.ru')) {
      if (u.pathname.includes('/play/embed/')) return url;
      const rt = u.pathname.match(/\/video\/([0-9a-f]{32})/i);
      return rt ? `https://rutube.ru/play/embed/${rt[1]}/` : null;
    }
    let id = '';
    if (host.endsWith('youtu.be')) id = u.pathname.split('/')[1] ?? '';
    else {
      id = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})(?:\/|$)/)?.[1] ?? '';
      if (!id) id = u.searchParams.get('v') ?? '';
    }
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch {
    return null;
  }
}

/**
 * Строит URL тизера для карточки: вкладка «Трейлер» со страницы деталей
 * (обогащается через кэш ApiService, 60 с). null — тизера нет, карточка
 * остаётся обычным постером.
 */
export function teaserUrlFromPlayers(players: Array<{ kind?: string; url?: string }> | undefined):
  | string
  | null {
  const own = players?.find((p) => p.kind === 'trailer' && p.url);
  return own?.url ? toTrailerEmbed(own.url) : null;
}

/** YouTube/RuTube embed → url с autoplay без звука (тизер молчит всегда). */
export function mutedAutoplay(embed: string): string {
  try {
    const u = new URL(embed);
    if (u.hostname.endsWith('youtube-nocookie.com')) {
      u.searchParams.set('mute', '1');
      u.searchParams.set('autoplay', '1');
      u.searchParams.set('controls', '0');
      u.searchParams.set('playsinline', '1');
      u.searchParams.set('modestbranding', '1');
      return u.toString();
    }
    if (u.hostname.endsWith('rutube.ru')) {
      u.searchParams.set('autoplay', '1');
      u.searchParams.set('mute', '1');
      return u.toString();
    }
    return embed;
  } catch {
    return embed;
  }
}
