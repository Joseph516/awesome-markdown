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

const result = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const ul = root.querySelector('ul');
	const before = new Set(Array.from(ul.children));

	// 模拟两种“回车后新增项”：复制了 checked 的空项、完全没有复选框的空项
	const checkedEmpty = document.createElement('li');
	checkedEmpty.innerHTML = '<input type="checkbox" checked> ';
	ul.appendChild(checkedEmpty);

	const bareEmpty = document.createElement('li');
	bareEmpty.textContent = '\u200b';
	ul.appendChild(bareEmpty);

	window.__awNormalizeNewTaskItems(ul, before);

	return Array.from(ul.children).map((li) => {
		const box = li.querySelector('input[type=checkbox]');
		return { text: li.textContent.trim(), hasBox: !!box, checked: box ? box.checked : null };
	});
});

console.log('NORMALIZED:', JSON.stringify(result));

const md = await page.evaluate(() => {
	const save = window.__posted.filter(m => m.type === 'save');
	return save.length ? save[save.length - 1].value : '(no save)';
});
console.log('MD AFTER (should keep 4 items):', JSON.stringify(md));

await browser.close();
server.close();
