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
await page.waitForSelector('.vditor-wysiwyg .vditor-reset ol', { timeout: 20000 });
await page.waitForTimeout(600);

const dump = () => page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const ol = root.querySelector('ol');
	const ul = root.querySelector('ul');
	return {
		olItems: ol ? Array.from(ol.children).map(li => li.textContent.trim()) : null,
		ulItems: ul ? Array.from(ul.children).map(li => (li.querySelector('input') ? (li.querySelector('input').checked ? '[x] ' : '[ ] ') : '') + li.textContent.trim()) : null,
			blocks: Array.from(root.children).map(el => el.tagName.toLowerCase() + ':' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12)),
	};
});

// 1. 有序列表：光标放到第一项开头，回车
const firstLi = page.locator('.vditor-wysiwyg .vditor-reset ol li').first();
const b = await firstLi.boundingBox();
await page.mouse.click(b.x + 6, b.y + b.height / 2);
await page.keyboard.press('Home');
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
console.log('OL AFTER ENTER:', JSON.stringify(await dump()));
await page.screenshot({ path: 'test/shot-enter-ol.png', clip: { x: 60, y: 40, width: 600, height: 260 } });


// 2. 任务列表：光标放到第一项开头，回车
const firstTask = page.locator('.vditor-wysiwyg .vditor-reset ul li').first();
const tb = await firstTask.boundingBox();
await page.mouse.click(tb.x + 70, tb.y + tb.height / 2);
await page.keyboard.press('Home');
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
console.log('UL AFTER ENTER:', JSON.stringify(await dump()));

const checkedStates = await page.evaluate(() =>
	Array.from(document.querySelectorAll('.vditor-wysiwyg .vditor-reset ul li')).map(li => {
		const box = li.querySelector('input[type=checkbox]');
		return { text: li.textContent.trim(), checked: box ? box.checked : null };
	}),
);
console.log('UL CHECKBOX:', JSON.stringify(checkedStates));

await browser.close();
server.close();
