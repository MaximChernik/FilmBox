import { Component, input, output } from '@angular/core';
import type { EmbedMenuGroup } from '../../core/electron-api';

export interface QualityOption {
  index: number;
  label: string;
}

export interface AudioTrackOption {
  index: number;
  label: string;
}

export interface SubtitleOption {
  index: number;
  label: string;
}

/**
 * Контурные иконки для шапок контролов: по типу группы (embed-группы
 * распознаются по тем же словам, что и собственные).
 */
const HEAD_ICON_PATHS: Array<{ test: RegExp; paths: string[] }> = [
  { test: /качеств|quality/i, paths: ['M4 6h16v12H4z', 'M7.5 10h9', 'M7.5 14h6'] },
  {
    test: /голос|озвуч|voice|audio/i,
    paths: ['M4 9.5h3.2L12 5.5v13l-4.8-4H4z', 'M15.4 9.2a4.4 4.4 0 0 1 0 5.6'],
  },
  { test: /субтитр|subtitle/i, paths: ['M3.5 6.5h17v11h-17z', 'M7.5 12.5h3.5', 'M13 12.5h3.5'] },
  {
    test: /сезон|season/i,
    paths: ['M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z'],
  },
  {
    test: /серия|episode/i,
    paths: ['M4 6.5h11', 'M4 12h11', 'M4 17.5h7', 'M17.5 12.5v6l5-3z'],
  },
];
const HEAD_ICON_MENU = ['M4.5 8h15', 'M4.5 16h15', 'M9 5.5v5', 'M15 13.5v5'];

@Component({
  selector: 'app-player-controls',
  templateUrl: './player-controls.component.html',
  styleUrl: './player-controls.component.scss',
})
export class PlayerControlsComponent {
  readonly qualityLevels = input<QualityOption[]>([]);
  readonly activeQuality = input(-1);
  readonly audioTracks = input<AudioTrackOption[]>([]);
  readonly activeAudioTrack = input(-1);
  readonly subtitles = input<SubtitleOption[]>([]);
  readonly activeSubtitle = input(-1);
  readonly embedGroups = input<EmbedMenuGroup[]>([]);
  readonly seasons = input<number[]>([]);
  readonly activeSeason = input(1);
  readonly episodes = input<{ episode: string; label: string }[]>([]);
  readonly activeEpisode = input<string>('');
  readonly embedLastPick = input<Map<string, string>>(new Map());
  readonly eqEnabled = input(false);
  readonly eqOpen = input(false);

  readonly qualityChange = output<number>();
  readonly audioTrackChange = output<number>();
  readonly subtitleChange = output<number>();
  readonly embedPick = output<{ group: string; label: string }>();
  readonly seasonChange = output<number>();
  readonly episodeChange = output<string>();
  readonly toggleEq = output<void>();

  onQualityChange(event: Event): void {
    this.qualityChange.emit(Number((event.target as HTMLSelectElement).value));
  }

  onAudioTrackChange(event: Event): void {
    this.audioTrackChange.emit(Number((event.target as HTMLSelectElement).value));
  }

  onSubtitleChange(event: Event): void {
    this.subtitleChange.emit(Number((event.target as HTMLSelectElement).value));
  }

  onEmbedPick(group: EmbedMenuGroup, event: Event): void {
    const label = (event.target as HTMLSelectElement).value;
    if (label) this.embedPick.emit({ group: group.name, label });
  }

  onSeasonChange(event: Event): void {
    const season = Number((event.target as HTMLSelectElement).value);
    if (Number.isFinite(season)) this.seasonChange.emit(season);
  }

  onEpisodeChange(event: Event): void {
    this.episodeChange.emit((event.target as HTMLSelectElement).value);
  }

  activeEmbedItem(group: EmbedMenuGroup): string {
    const active = group.items.find((i) => i.active);
    if (active) return active.label;
    const picked = this.embedLastPick().get(group.name);
    if (picked && group.items.some((i) => i.label === picked)) return picked;
    return '';
  }

  /** Контур иконки в шапке контрола — по названию группы. */
  iconPaths(label: string): string[] {
    return HEAD_ICON_PATHS.find((icon) => icon.test.test(label))?.paths ?? HEAD_ICON_MENU;
  }
}
