const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const toIcoModule = require('png-to-ico');
const toIco = toIcoModule.default || toIcoModule;

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');

function renderPng(width) {
  const resvg = new Resvg(SVG, { fitTo: { mode: 'width', value: width } });
  return resvg.render().asPng();
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });

  const icon512 = renderPng(512);
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), icon512);
  console.log('assets/icon.png (512)');

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = icoSizes.map((size) => renderPng(size));
  const ico = await toIco(pngs);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  console.log('build/icon.ico [' + icoSizes.join(', ') + ']');

  fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), ico);
  console.log('public/favicon.ico');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
