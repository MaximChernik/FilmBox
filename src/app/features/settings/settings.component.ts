import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { LibraryService } from '../../core/library.service';
import { SettingsService } from '../../core/settings.service';
import type { Category, SourceInfo } from '../../core/models';

@Component({
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  imports: [FormsModule, RouterLink],
})
export class SettingsComponent {
  private readonly api = inject(ApiService);
  readonly settings = inject(SettingsService);
  readonly library = inject(LibraryService);

  readonly sources = signal<SourceInfo[]>([]);
  readonly version = signal('');
  readonly updateMessage = signal('');
  private importInput?: HTMLInputElement;

  /** Sources displayed in the user-defined parse order. */
  readonly orderedSources = computed(() => {
    const ids = this.settings.orderedSourceIds(this.sources().map((s) => s.id));
    const byId = new Map(this.sources().map((s) => [s.id, s]));
    return ids.map((id) => byId.get(id)).filter((s): s is SourceInfo => !!s);
  });

  readonly dragIndex = signal<number | null>(null);
  readonly dragOverIndex = signal<number | null>(null);

  onDragStart(index: number, event: DragEvent): void {
    this.dragIndex.set(index);
    const dt = event.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'move';
    dt.setData('text/plain', String(index));
    // a styled clone of the row becomes the cursor's drag image
    const row = event.currentTarget as HTMLElement | null;
    if (!row) return;
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging', 'drag-over');
    const src = row.querySelector('input');
    const dst = ghost.querySelector('input');
    if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      dst.checked = src.checked;
    }
    ghost.style.width = `${row.offsetWidth}px`;
    document.body.appendChild(ghost);
    dt.setDragImage(ghost, 18, Math.round(row.offsetHeight / 2));
    setTimeout(() => ghost.remove(), 0);
  }

  onDragOver(index: number, event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (this.dragIndex() !== null && this.dragOverIndex() !== index) {
      this.dragOverIndex.set(index);
    }
  }

  onDragEnd(): void {
    this.dragIndex.set(null);
    this.dragOverIndex.set(null);
  }

  onDrop(index: number, event: DragEvent): void {
    event.preventDefault();
    const from = this.dragIndex();
    this.dragIndex.set(null);
    this.dragOverIndex.set(null);
    if (from === null || from === index) return;
    const list = this.orderedSources();
    if (from >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(index, 0, moved);
    this.settings.update({ sourceOrder: next.map((s) => s.id) });
  }

  onCheckUpdate(): void {
    this.updateMessage.set('Проверяем…');
    this.api
      .checkUpdate()
      .then((r) => this.updateMessage.set(r.message))
      .catch(() => this.updateMessage.set('Ошибка проверки'));
  }

  exportLibrary(): void {
    const blob = new Blob([this.library.exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `filmbox-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  triggerImport(): void {
    this.importInput ??= document.createElement('input');
    this.importInput.type = 'file';
    this.importInput.accept = 'application/json';
    this.importInput.onchange = () => {
      const file = this.importInput!.files?.[0];
      if (!file) return;
      file
        .text()
        .then((text) => {
          this.library.importBackup(text);
          window.alert('Библиотека импортирована');
        })
        .catch((err) => window.alert('Не удалось импортировать: ' + (err as Error).message));
      this.importInput!.value = '';
    };
    this.importInput.click();
  }

  readonly densities = [
    { id: 'compact' as const, title: 'Компактные', hint: 'больше карточек в ряд' },
    { id: 'normal' as const, title: 'Средние', hint: 'по умолчанию' },
    { id: 'large' as const, title: 'Крупные', hint: 'для больших окон' },
  ];

  readonly homeTabs = computed(() => {
    const cats = new Map<string, string>();
    for (const source of this.sources()) {
      for (const cat of source.categories) {
        if (!cats.has(cat.id)) cats.set(cat.id, cat.title);
      }
    }
    if (!cats.size) cats.set('home', 'Главная');
    const list = [...cats].map(([id, title]) => ({ id, title }));
    return [
      ...list,
      { id: 'favorites', title: 'Избранное' },
      { id: 'later', title: 'Смотреть позже' },
    ];
  });

  constructor() {
    if (this.api.isElectron) {
      this.api
        .listSources()
        .then((sources) => this.sources.set(sources))
        .catch(() => undefined);
      this.api
        .getVersion()
        .then((v) => this.version.set(v))
        .catch(() => undefined);
    }
  }

  isSourceActive(id: string): boolean {
    return !this.settings.get().disabledSources.includes(id);
  }

  toggleSource(id: string): void {
    this.settings.toggleSource(id);
  }

  setDensity(density: 'compact' | 'normal' | 'large'): void {
    this.settings.update({ density });
  }

  onHomeTab(event: Event): void {
    this.settings.update({ homeTab: (event.target as HTMLSelectElement).value });
  }

  toggleAutoNext(): void {
    this.settings.update({ autoNext: !this.settings.get().autoNext });
  }

  toggleHistory(): void {
    this.settings.update({ historyEnabled: !this.settings.get().historyEnabled });
  }

  /** Записываем локальный путь к видеотеке из текстового поля (по change). */
  onLocalPathChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.settings.update({ localVideosPath: value });
  }

  /** Нативный диалог выбора папки — заполняет путь в настройках. */
  async pickLocalFolder(): Promise<void> {
    const folder = await this.api.pickFolder();
    if (folder) this.settings.update({ localVideosPath: folder });
  }

  clearHistory(): void {
    if (window.confirm('Очистить историю просмотра?')) this.library.clearHistory();
  }

  clearFavorites(): void {
    if (window.confirm('Очистить список избранного?')) this.library.clearFavorites();
  }

  clearLater(): void {
    if (window.confirm('Очистить список «Смотреть позже»?')) this.library.clearLater();
  }

  resetSettings(): void {
    if (window.confirm('Сбросить все настройки к значениям по умолчанию?')) this.settings.reset();
  }
}
