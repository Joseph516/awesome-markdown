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
	const first = ul.children[0];
	const box = first.querySelector('input[type=checkbox]');

	// 现场：第一项已完成，光标停在项首
	box.checked = true;
	box.setAttribute('checked', '');
	const textNode = first.lastChild;
	const range = document.createRange();
	range.setStart(textNode, 0);
	range.collapse(true);
	const sel = window.getSelection();
	sel.removeAllRanges();
	sel.addRange(range);

	const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
	root.dispatchEvent(evt);

	await new Promise((r) => setTimeout(r, 250));

	const caretSel = window.getSelection();
	const caretLi = caretSel && caretSel.rangeCount
		? (caretSel.getRangeAt(0).startContainer.nodeType === 3
			? caretSel.getRangeAt(0).startContainer.parentElement.closest('li')
			: caretSel.getRangeAt(0).startContainer.closest('li'))
		: null;

	return {
		prevented: evt.defaultPrevented,
		items: Array.from(ul.children).map((li) => {
			const input = li.querySelector('input[type=checkbox]');
			return {
				text: li.textContent.replace(/\u200b/g, '').trim(),
				checked: input ? input.checked : null,
				html: li.innerHTML.replace(/\s+/g, ' ').slice(0, 60),
				outer: li.outerHTML.replace(/\s+/g, ' ').slice(0, 120),
			};
		}),
		caretText: caretLi ? caretLi.textContent.trim() || '(空项)' : '(无)',
	};
});

console.log('START ENTER:', JSON.stringify(result));

const md = await page.evaluate(() => {
	const sent = window.__posted.filter((m) => m.type === 'change');
	return sent.length ? sent[sent.length - 1].value : '(none)';
});
console.log('MD AFTER:', JSON.stringify(md));

await browser.close();
server.close();
