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
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/test/harness-outline.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset h2', { timeout: 20000 });
await page.waitForTimeout(700);

const dump = () => page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	return Array.from(root.children).map((el) => ({
		tag: el.tagName.toLowerCase(),
		text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 10),
		hidden: el.classList.contains('aw-fold-hidden'),
		folded: el.classList.contains('aw-folded'),
	}));
});

console.log('BEFORE:', JSON.stringify(await dump(), null, 0));
const scopeProbe = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const h = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(x => x.textContent.trim() === '安装');
	const level = Number(h.tagName.slice(1));
	const detail = [];
	let node = h.nextElementSibling;
	while (node) {
		const re = /^H[1-6]$/;
		const m = re.exec(node.tagName);
		detail.push({ tag: node.tagName, tagCode: node.tagName.split('').map(c => c.charCodeAt(0)), test: re.test(node.tagName), matched: !!m });
		if (m && Number(m[1]) <= level) break;
		node = node.nextElementSibling;
	}
	return { headTag: h.tagName, level, direct: /^H[1-6]$/.test('H2'), detail };
});
console.log('SCOPE PROBE:', JSON.stringify(scopeProbe));


// 折叠第二个标题（## 安装）
const box = await page.evaluate(() => {
	const h = Array.from(document.querySelectorAll('.vditor-wysiwyg .vditor-reset h2')).find(x => x.textContent.trim() === '安装');
	const r = h.getBoundingClientRect();
	return { x: r.left, y: r.top, h: r.height };
});
await page.mouse.click(box.x - 8, box.y + box.h / 2);
await page.waitForTimeout(250);

console.log('AFTER:', JSON.stringify(await dump(), null, 0));

await browser.close();
server.close();
