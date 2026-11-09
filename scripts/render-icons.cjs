// Renders build/icon.svg into build/icon.icns and docs/cover.html into docs/cover.png with Electron's own renderer.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
async function capture(file, width, height) {
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, transparent: true, frame: false });
  await win.loadFile(file);
  await new Promise(r => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  win.destroy();
  return image;
}

// Closing the icon window must not quit the app before the cover renders.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
  const page = path.join(app.getPath('temp'), 'orin-icon.html');
  fs.writeFileSync(page, `<body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', 'width="1024" height="1024" style="display:block"')}</body>`);
  const master = await capture(page, 1024, 1024);
  fs.writeFileSync(path.join(root, 'build/icon.png'), master.toPNG());
  const set = path.join(app.getPath('temp'), 'orin.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${size}x${size}.png`), master.resize({ width: size, height: size, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(set, `icon_${size}x${size}@2x.png`), master.resize({ width: size * 2, height: size * 2, quality: 'best' }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'build/icon.icns')]);
  const cover = await capture(path.join(root, 'docs/cover.html'), 1280, 640);
  fs.writeFileSync(path.join(root, 'docs/cover.png'), cover.toPNG());
  process.stdout.write('Wrote build/icon.icns, build/icon.png, docs/cover.png\n');
  app.exit(0);
});
