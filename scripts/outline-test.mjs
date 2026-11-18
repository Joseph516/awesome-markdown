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
const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
await page.goto(`http://127.0.0.1:${port}/test/harness-outline.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset h1', { timeout: 20000 });
await page.waitForTimeout(700);

const headings = await page.evaluate(() =>
	Array.from(document.querySelectorAll('.vditor-wysiwyg .vditor-reset h1, .vditor-wysiwyg .vditor-reset h2, .vditor-wysiwyg .vditor-reset h3')).map(h => h.textContent.trim()),
);
console.log('HEADINGS:', JSON.stringify(headings));

// 折叠 h1，让下面的内容全部隐藏
const box = await page.evaluate(() => {
	const h = document.querySelector('.vditor-wysiwyg .vditor-reset h1');
	const r = h.getBoundingClientRect();
	return { x: r.left, y: r.top, h: r.height };
});
await page.mouse.click(box.x - 8, box.y + box.h / 2);
await page.waitForTimeout(250);
const folded = await page.evaluate(() => ({
	hidden: document.querySelectorAll('.aw-fold-hidden').length,
	foldedH1: document.querySelector('.vditor-wysiwyg .vditor-reset h1').classList.contains('aw-folded'),
}));
console.log('FOLDED:', JSON.stringify(folded));

// 模拟大纲点击「配置」(index=2)
await page.evaluate(() => {
	window.postMessage({ type: 'reveal', index: 2, level: 3, text: '配置' }, '*');
});
await page.waitForTimeout(900);

const result = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const flashed = root.querySelector('.aw-reveal-flash');
	const target = root.querySelector('h3');
	const rect = target.getBoundingClientRect();
	return {
		hiddenAfter: root.querySelectorAll('.aw-fold-hidden').length,
		stillFolded: root.querySelector('h1').classList.contains('aw-folded'),
		flashed: flashed ? flashed.textContent.trim() : null,
		targetTop: Math.round(rect.top),
		inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
	};
});
console.log('REVEAL:', JSON.stringify(result));

await page.screenshot({ path: 'test/shot-outline-reveal.png' });
await browser.close();
server.close();
