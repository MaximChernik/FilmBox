import { fetchText } from '../fetcher';
import type { Episode, Stream, StreamCatalog, Subtitle } from '../models';

interface RawAudio {
  names?: string[];
  order?: number[];
}

interface RawEpisode {
  episode?: string | number;
  id?: string | number;
  hls?: string;
  dash?: string;
  mp4?: string;
  file?: string;
  duration?: number;
  title?: string;
  cc?: Array<{ url?: string; name?: string }>;
  audio?: RawAudio;
}

interface RawSeason {
  season?: number | string;
  episodes?: RawEpisode[];
}

function extractBalanced(source: string, openIdx: number): string | null {
  if (openIdx < 0 || openIdx >= source.length) return null;
  const open = source[openIdx];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

function extractBalancedArray(source: string, key: string): string | null {
  const marker = `"${key}":`;
  let idx = source.indexOf(marker);
  if (idx < 0) {
    const alt = `${key}:`;
    idx = source.indexOf(alt);
    if (idx < 0) return null;
    idx += alt.length;
  } else {
    idx += marker.length;
  }
  while (idx < source.length && /\s/.test(source[idx])) idx++;
  return source[idx] === '[' ? extractBalanced(source, idx) : null;
}

function extractBalancedValue(source: string, key: string): string | null {
  const marker = `"${key}":`;
  let idx = source.indexOf(marker);
  if (idx < 0) {
    const alt = `${key}:`;
    idx = source.indexOf(alt);
    if (idx < 0) return null;
    idx += alt.length;
  } else {
    idx += marker.length;
  }
  while (idx < source.length && /\s/.test(source[idx])) idx++;
  return source[idx] === '{' || source[idx] === '[' ? extractBalanced(source, idx) : null;
}

function stringField(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`(?:^|[^\\w$])${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function buildStreams(raw: RawEpisode): Stream[] {
  const streams: Stream[] = [];
  if (raw.hls) streams.push({ type: 'hls', url: raw.hls, label: 'HLS' });
  if (raw.dash) streams.push({ type: 'dash', url: raw.dash, label: 'DASH' });
  if (raw.mp4) streams.push({ type: 'mp4', url: raw.mp4, label: 'MP4' });
  if (raw.file) streams.push({ type: 'mp4', url: raw.file, label: 'MP4' });
  return streams;
}

function buildSubtitles(raw: RawEpisode): Subtitle[] {
  return (raw.cc ?? [])
    .filter((c) => !!c?.url)
    .map((c) => ({ name: c.name?.trim() || 'Субтитры', url: c.url as string }));
}

function buildAudioNames(audio?: RawAudio): string[] | undefined {
  const names = audio?.names;
  return Array.isArray(names) && names.length ? names.map((n) => String(n)) : undefined;
}

function parseMovieSource(html: string): Episode | null {
  const callIdx = html.indexOf('makePlayer({');
  if (callIdx < 0) return null;
  const obj = extractBalanced(html, html.indexOf('{', callIdx));
  if (!obj) return null;
  const sourceIdx = obj.search(/(?:^|[^.\w$])source:\s*\{/);
  if (sourceIdx < 0) return null;
  const braceIdx = obj.indexOf('{', sourceIdx);
  const block = extractBalanced(obj, braceIdx);
  if (!block) return null;

  const streams: Stream[] = [];
  const hls = stringField(block, 'hls');
  const dash = stringField(block, 'dash');
  const mp4 = stringField(block, 'mp4') ?? stringField(block, 'file');
  if (hls) streams.push({ type: 'hls', url: hls, label: 'HLS' });
  if (dash) streams.push({ type: 'dash', url: dash, label: 'DASH' });
  if (mp4) streams.push({ type: 'mp4', url: mp4, label: 'MP4' });
  if (!streams.length) return null;

  let subtitles: Subtitle[] = [];
  const ccRaw = extractBalancedArray(block, 'cc');
  if (ccRaw) {
    try {
      const cc = JSON.parse(ccRaw) as Array<{ url?: string; name?: string }>;
      subtitles = cc
        .filter((c) => !!c?.url)
        .map((c) => ({
          name: c.name?.trim() || 'Субтитры',
          url: c.url as string,
        }));
    } catch {
      // ignore malformed subtitles
    }
  }

  let audioNames: string[] | undefined;
  const audioRaw = extractBalancedValue(block, 'audio');
  if (audioRaw) {
    try {
      audioNames = buildAudioNames(JSON.parse(audioRaw) as RawAudio);
    } catch {
      // ignore malformed audio block
    }
  }

  return {
    season: 1,
    episode: '1',
    label: 'Видео',
    streams,
    subtitles,
    audioNames,
  };
}

export function parseEmbedHtml(html: string): Episode[] {
  const episodes: Episode[] = [];

  const seasonsRaw = extractBalancedArray(html, 'seasons');
  if (seasonsRaw) {
    try {
      const seasons = JSON.parse(seasonsRaw) as RawSeason[];
      for (const season of seasons) {
        const seasonNum = Number(season?.season ?? 1) || 1;
        for (const ep of season?.episodes ?? []) {
          const streams = buildStreams(ep);
          if (!streams.length) continue;
          episodes.push({
            season: seasonNum,
            episode: String(ep.episode ?? episodes.length + 1),
            label: ep.title?.trim() || `Сезон ${seasonNum} - Серия ${ep.episode ?? ''}`.trim(),
            duration: ep.duration,
            streams,
            subtitles: buildSubtitles(ep),
            audioNames: buildAudioNames(ep.audio),
          });
        }
      }
    } catch {
      // ignore malformed playlist, fallback below
    }
  }

  if (!episodes.length) {
    // Fallback: try to extract season/episode from HTML when no seasons JSON
    const fallbackEpisodes = parseEmbedFallback(html);
    if (fallbackEpisodes.length) {
      episodes.push(...fallbackEpisodes);
    } else {
      const movie = parseMovieSource(html);
      if (movie) episodes.push(movie);
    }
  }

  if (!episodes.length) {
    const m = html.match(/"hls"\s*:\s*"([^"]+)"/);
    if (m) {
      episodes.push({
        season: 1,
        episode: '1',
        label: 'Видео',
        streams: [{ type: 'hls', url: JSON.parse(`"${m[1]}"`), label: 'HLS' }],
        subtitles: [],
      });
    }
  }

  // Ceramet-style players (gencit.info et al.): window.playerData.config.video
  if (!episodes.length) {
    const m = html.match(/"video"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
    if (m) {
      try {
        const url = JSON.parse(`"${m[1]}"`) as string;
        const durM = html.match(/"duration"\s*:\s*(\d+)/);
        episodes.push({
          season: 1,
          episode: '1',
          label: 'Видео',
          streams: [{ type: 'hls', url, label: 'HLS' }],
          subtitles: [],
          duration: durM ? Number(durM[1]) : undefined,
        });
      } catch {
        // malformed JSON escape — leave for the iframe fallback
      }
    }
  }

  return episodes;
}

function parseEmbedFallback(html: string): Episode[] {
  const episodes: Episode[] = [];

  // Try to extract season number from HTML patterns common in ZONA and similar sources
  const seasonMatch = html.match(/(?:season|сезон)[\s:]+(\d+)/i);
  const seasonNum = seasonMatch ? Number(seasonMatch[1]) : 1;

  // Try to extract episode number from HTML patterns
  const episodeMatch = html.match(/(?:episode| серия|эп)[\s:]+(\d+)/i);
  const episodeNum = episodeMatch ? String(episodeMatch[1]) : '1';

  // Try to extract episode title
  const titleMatch = html.match(/"title"\s*:\s*"([^"]+)"/i);
  const title = titleMatch ? titleMatch[1] : undefined;

  // Try to extract audio names from HTML
  const audioNamesRaw = extractBalancedValue(html, 'audio');
  const audioNames = audioNamesRaw
    ? buildAudioNames(JSON.parse(audioNamesRaw) as RawAudio)
    : undefined;

  // Try to extract subtitles CC data
  const ccRaw = extractBalancedArray(html, 'cc');
  const subtitles = ccRaw
    ? buildSubtitlesFromRaw(JSON.parse(ccRaw) as Array<{ url?: string; name?: string }>)
    : [];

  // If we have at least an HLS stream URL, create an episode
  const hlsMatch = html.match(/"hls"\s*:\s*"([^"]+)"/i);
  if (hlsMatch) {
    episodes.push({
      season: seasonNum,
      episode: episodeNum,
      label: title || `Сезон ${seasonNum} - Серия ${episodeNum}`.trim(),
      streams: [{ type: 'hls' as const, url: hlsMatch![1], label: 'HLS' }],
      subtitles,
      audioNames,
    });
  } else {
    // Also try DASH/MP4 patterns
    const dashMatch = html.match(/"dash"\s*:\s*"([^"]+)"/i);
    const mp4Match = html.match(/"mp4"\s*:\s*"([^"]+)"/i);
    const streams: Stream[] = [];
    if (dashMatch) streams.push({ type: 'dash', url: dashMatch[1], label: 'DASH' });
    if (mp4Match) streams.push({ type: 'mp4', url: mp4Match[1], label: 'MP4' });
    if (!streams.length) return episodes;
    episodes.push({
      season: seasonNum,
      episode: episodeNum,
      label: title || `Сезон ${seasonNum} - Серия ${episodeNum}`.trim(),
      streams,
      subtitles,
      audioNames,
    });
  }

  return episodes;
}

function buildSubtitlesFromRaw(cc: Array<{ url?: string; name?: string }>): Subtitle[] {
  return cc
    .filter((c) => !!c?.url)
    .map((c) => ({ name: c.name?.trim() || 'Субтитры', url: c.url as string }));
}

export async function resolveEmbed(
  embedUrl: string,
  sourceId: string,
  tabLabel: string,
  referer?: string,
): Promise<StreamCatalog> {
  const html = await fetchText(embedUrl, { referer });
  const episodes = parseEmbedHtml(html);
  return {
    sourceId,
    tabLabel,
    episodes,
    fallbackEmbedUrl: embedUrl,
  };
}
