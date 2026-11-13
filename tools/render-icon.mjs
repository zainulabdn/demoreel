// Renders docs/media/logo.svg to the PNG icons the plugin manifests need.
// Usage: node tools/render-icon.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from '../skills/demoreel/scripts/lib/chrome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = [
  ['.claude-plugin/icon.png', 1024],
  ['.codex-plugin/icon.png', 1024],
  ['docs/media/logo.png', 256],
];

for (const [file, size] of targets) {
  const browser = await launchChrome({ width: size, height: size, scale: 1 });
  try {
    const session = await browser.connection.newSession();
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 0, mobile: false });
    await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const loaded = session.once('Page.loadEventFired', 15000);
    await session.send('Page.navigate', { url: pathToFileURL(`${root}docs/media/logo.svg`).href });
    await loaded;
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${root}${file}`, Buffer.from(data, 'base64'));
    console.log(`wrote ${file} (${size}px)`);
  } finally {
    await browser.close();
  }
}
