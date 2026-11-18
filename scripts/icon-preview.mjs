import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (name) =>
	fs
		.readFileSync(path.join(ROOT, 'media/icons', name), 'utf8')
		.replace('width="16" height="16"', 'width="72" height="72"');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 120 } });
await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;display:flex;gap:32px;align-items:center;background:#fff">
	<div style="background:#fff;padding:8px">${read('aw-visual-light.svg')}</div>
	<div style="background:#252526;padding:8px">${read('aw-visual-dark.svg')}</div>
</body></html>`);
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/icon-preview.png' });
await browser.close();
console.log('preview: /tmp/icon-preview.png');
