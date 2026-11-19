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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(`http://127.0.0.1:${port}/test/harness-enter.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset ul li', { timeout: 20000 });
await page.waitForTimeout(700);

// 构造“回车之后”的现场：空项把勾选状态抢走了，原已完成项被重置为未勾选
const result = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const ul = root.querySelector('ul');
	ul.innerHTML =
		'<li><input type="checkbox" checked> </li>' +
		'<li><input type="checkbox"> 任务A</li>' +
		'<li><input type="checkbox"> 任务B</li>';

	const snapshot = [
		{ text: '任务A', checked: true },
		{ text: '任务B', checked: false },
	];

	window.__awNormalizeNewTaskItems(ul, snapshot);

	return Array.from(ul.children).map((li) => {
		const box = li.querySelector('input[type=checkbox]');
		return { text: li.textContent.trim(), hasBox: !!box, checked: box ? box.checked : null };
	});
});

console.log('AFTER RESTORE:', JSON.stringify(result));

await browser.close();
server.close();
