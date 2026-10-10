/**
 * Очистка release/ перед сборкой установщика.
 *
 * electron-builder перезаписывает latest.yml, но старые exe/blockmap
 * прошлых версий остаются лежать и раздувают папку сотнями мегабайт.
 * Вызывается автоматически хуком `predist` перед `npm run dist`.
 */
const fs = require('node:fs');
const path = require('node:path');

const releaseDir = path.join(__dirname, '..', 'release');

if (!fs.existsSync(releaseDir)) {
  process.exit(0);
}

let removed = 0;
for (const name of fs.readdirSync(releaseDir)) {
  // оставляем служебные файлы, удаляем только собранные артефакты
  if (/^FilmBox-(Setup|Portable)-.*\.(exe|blockmap)$/.test(name)) {
    fs.rmSync(path.join(releaseDir, name), { force: true });
    removed++;
  }
}

if (removed) {
  console.log(`clean-release: удалено старых артефактов — ${removed}`);
}
