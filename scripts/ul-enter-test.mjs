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
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
await page.goto(`http://127.0.0.1:${port}/test/harness-enter.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset ul li', { timeout: 20000 });
await page.waitForTimeout(600);

const dumpUl = () => page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const ul = root.querySelector('ul');
	return Array.from(ul.children).map((li) => {
		const box = li.querySelector('input[type=checkbox]');
		return {
			text: li.textContent.trim(),
			hasBox: !!box,
			checked: box ? box.checked : null,
			html: li.innerHTML.replace(/\s+/g, ' ').slice(0, 80),
		};
	});
});

console.log('UL BEFORE:', JSON.stringify(await dumpUl()));

// 点第一个任务项的文字（取元素中心，确保落进 contenteditable）
await page.locator('.vditor-wysiwyg .vditor-reset ul li').first().click();
await page.waitForTimeout(200);
const focus = await page.evaluate(() => ({
	active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : 'none',
	anchor: window.getSelection() && window.getSelection().anchorNode ? window.getSelection().anchorNode.nodeName : 'none',
}));
console.log('FOCUS:', JSON.stringify(focus));

await page.evaluate(() => {
	const el = document.querySelector('.vditor-wysiwyg .vditor-reset');
	el.addEventListener('keydown', (e) => console.log('KEYDOWN', e.key, e.keyCode, e.target.tagName));
	document.addEventListener('keydown', (e) => console.log('DOC KEYDOWN', e.key), true);
});
await page.keyboard.press('Home');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

console.log('UL AFTER ENTER:', JSON.stringify(await dumpUl()));
await page.screenshot({ path: 'test/shot-enter-ul.png', clip: { x: 40, y: 60, width: 620, height: 300 } });

// 也看看存回的 Markdown 是什么
await page.keyboard.press('Meta+s');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => {
	const saves = window.__posted.filter(m => m.type === 'save');
	return saves.length ? saves[saves.length - 1].value : '';
});
console.log('SAVED MD:', JSON.stringify(saved));

await browser.close();
server.close();
