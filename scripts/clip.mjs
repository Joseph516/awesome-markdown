import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
	const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
	fs.readFile(p, (err, data) => {
		if (err) { res.writeHead(404); res.end('x'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
		res.end(data);
	});
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset h1', { timeout: 20000 });
await page.waitForTimeout(600);

const info = await page.evaluate(() => {
	const h = document.querySelector('.vditor-wysiwyg .vditor-reset h1');
	const cs = getComputedStyle(h);
	const b = getComputedStyle(h, '::before');
	return {
		position: cs.position,
		boxLeft: h.getBoundingClientRect().left,
		beforeLeft: b.left,
		beforeContent: b.content,
		beforeDisplay: b.display,
		beforePosition: b.position,
	};
});
console.log('INFO:', JSON.stringify(info));

await page.locator('.vditor-wysiwyg .vditor-reset h1').hover();
await page.waitForTimeout(400);
await page.screenshot({ path: 'test/shot-fold-crop.png', clip: { x: 95, y: 75, width: 90, height: 70 } });
console.log('crop written');

await browser.close();
server.close();
