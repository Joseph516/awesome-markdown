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
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${port}/test/harness-enter.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset ul li', { timeout: 20000 });
await page.waitForTimeout(700);

const result = await page.evaluate(async () => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const ul = root.querySelector('ul');
	const items = Array.from(ul.children);
	const first = items[0];
	const box = first.querySelector('input[type=checkbox]');

	// 现场：第一项是已完成状态，光标停在这一项文字开头
	box.checked = true;
	box.setAttribute('checked', '');
	const textNode = first.lastChild;
	const range = document.createRange();
	range.setStart(textNode, 0);
	range.collapse(true);
	const sel = window.getSelection();
	sel.removeAllRanges();
	sel.addRange(range);

	// 和真实环境一致：按键事件的 target 是整个编辑区
	root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

	await new Promise((r) => setTimeout(r, 30));

	// 模拟 Vditor 回车的结果：空项插到上方并带走勾选，原项被重置成未勾选
	box.checked = false;
	box.removeAttribute('checked');
	const blank = document.createElement('li');
	blank.innerHTML = '<input type="checkbox" checked> \u200b';
	ul.insertBefore(blank, first);

	await new Promise((r) => setTimeout(r, 250));

	return Array.from(ul.children).map((li) => {
		const input = li.querySelector('input[type=checkbox]');
		return { text: li.textContent.replace(/\u200b/g, '').trim(), checked: input ? input.checked : null };
	});
});

console.log('GUARD RESULT:', JSON.stringify(result));

const saved = await page.evaluate(() => {
	const s = window.__posted.filter((m) => m.type === 'save');
	return s.length ? s[s.length - 1].value : '(none)';
});
console.log('MD SAVED:', JSON.stringify(saved));

await browser.close();
server.close();
