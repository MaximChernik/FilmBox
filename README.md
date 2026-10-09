# FilmBox

Десктопный агрегатор фильмов и сериалов: собирает каталоги нескольких сайтов, ищет по ним,
показывает синопсисы и трейлеры и играет видео во встроенном плеере (HLS) — без браузера.

Стек: **Angular 21** (сигналы, standalone-компоненты) + **Electron 37** + **TypeScript**,
сборка — Angular CLI и `electron-builder`.

## Возможности

- Каталог/категории/поиск/фильтры (тип, жанр, год, рейтинг), сортировка, подгрузка страниц.
- Плеер: выбор качества (ABR/уровни HLS), дорожки озвучки, субтитры, 5-полосный эквалайзер
  с пресетами, автопереход к следующей серии, resume позиции и серии.
- Горячие клавиши в плеере: `Space` — пауза, `←/→` — ±10 с (`Shift` — 30 с), `↑/↓` — громкость,
  `M` — звук, `F` — во весь экран, `N` — следующая серия.
- Библиотека: избранное, «смотреть позже», история, прогресс просмотра (полоса на карточке,
  «осталось …» на странице фильма), экспорт/импорт бэкапа.
- Страница фильма: описание, рейтинги, плееры источника, трейлер с YouTube (nocookie-embed).
- Настройки: плотность карточек, вкладка главной, авто-переход, история, громкость/EQ,
  включение/выключение источников, проверка обновлений.
- Автообновление установленной (NSIS) версии через `electron-updater`.

## Требования

Node.js 20+ и npm. Для сборки установщика под Windows — запуск на Windows (или wine не поддерживается).

## Команды

| Команда                | Что делает                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `npm install`          | установка зависимостей                                                                |
| `npm start`            | собрать и запустить приложение в Electron                                             |
| `npm run dev:web`      | только веб-режим (`ng serve`, часть API будет недоступна)                             |
| `npm run dev:electron` | запуск Electron с пересборкой main-процесса                                           |
| `npm run watch`        | dev-сборка в режиме watch                                                             |
| `npm run build`        | продакшен-сборка: `dist/` (Angular) + `dist-electron/` (main)                         |
| `npm run dist`         | `build` + установщики `release/FilmBox-Setup-*.exe`, `release/FilmBox-Portable-*.exe` |
| `npm run icon`         | перегенерация иконки `build/icon.ico`                                                 |

## Структура

```
src/app/                 Angular-приложение
  core/                  api.service, library.service (избранное/история/прогресс),
                         settings.service, models, persistent-storage, electron-api
  features/
    catalog/             главная, категории, поиск, фильтры
    details/             страница фильма
    player/              HLS-плеер, серии, EQ, субтитры
    recs/                подборки
    library/             избранное / смотреть позже / история
    settings/            настройки
  shared/                media-card, nav-icon, spinner
electron/                main-процесс
  main.ts                окно, окружение, selftest, запуск автообновления
  registry.ts            IPC-каналы (каталог/детали/стримы/state)
  preload.ts             contextBridge → window.api
  fetcher.ts             запросы с редиректами и заголовками источников
  state-store.ts         durable-хранилище userData/filmbox-state.json
  updater.ts             electron-updater (NSIS-версия)
  parsers/               парсеры источников: kinogo, lordfilm, reyohoho, kinokong, zetflix,
                         rutube, embed-resolver, base/shared
scripts/                 make-icon.js (перегенерация иконки)
release/                 собранные установщики (не входят в репозиторий)
```

## Хранилище данных

Состояние живёт в `userData/filmbox-state.json` (IPC `state:getSync` / `state:set`), ключи:
`filmbox:settings`, `filmbox:favorites`, `filmbox:later`, `filmbox:history`, `filmbox:progress`,
`filmbox:ratings`, `filmbox:statuses`, `filmbox:srcstats` (статистика источников).
В обычном браузере (без Electron) используется `localStorage`, оттуда данные мигрируют в файл.

## Проверки

- Форматирование: `npx prettier --check "src/**/*.{ts,html,scss}"`.

## Автообновление

`electron/updater.ts` проверяет релизы и скачивает обновление в фоне для NSIS-сборки
(Portable-версия обновляться не может). Чтобы проверка работала, замените плейсхолдеры
`YOUR_GITHUB_OWNER` / `YOUR_GITHUB_REPO` в `package.json` → `build.publish` на реальный
репозиторий с GitHub Releases.
