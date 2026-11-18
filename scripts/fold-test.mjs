import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
	const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
	fs.readFile(p, (err, data) => {
		if (err) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
		res.end(data);
	});
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset h1', { timeout: 20000 });
await page.waitForTimeout(600);

const box0 = await page.evaluate(() => {
	const r = document.querySelector('.vditor-wysiwyg .vditor-reset h1').getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height };
});
console.log('BOX0:', JSON.stringify(box0));

// 折叠
await page.mouse.click(box0.x - 8, box0.y + box0.h / 2);
await page.waitForTimeout(250);
const box1 = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const h = root.querySelector('h1');
	const r = h.getBoundingClientRect();
	return {
		x: r.left, y: r.top, w: r.width, h: r.height,
		folded: h.classList.contains('aw-folded'),
		hidden: root.querySelectorAll('.aw-fold-hidden').length,
		html: h.outerHTML.slice(0, 160),
	};
});
console.log('AFTER FOLD:', JSON.stringify(box1));

// 展开：用新的 box 坐标
await page.mouse.click(box1.x - 8, box1.y + box1.h / 2);
await page.waitForTimeout(250);
const box2 = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const h = root.querySelector('h1');
	return { folded: h.classList.contains('aw-folded'), hidden: root.querySelectorAll('.aw-fold-hidden').length };
});
console.log('AFTER UNFOLD:', JSON.stringify(box2));

// 折叠后再输入，验证存盘内容
await page.mouse.click(box0.x - 8, box0.y + box0.h / 2);
await page.waitForTimeout(200);
await page.mouse.click(box0.x + 40, box0.y + box0.h / 2);
await page.waitForTimeout(150);
const editState = await page.evaluate(() => ({
	active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 40) : 'none',
	editable: String(document.querySelector('.vditor-wysiwyg').getAttribute('contenteditable')),
	selAnchor: window.getSelection() && window.getSelection().anchorNode ? window.getSelection().anchorNode.nodeName : 'none',
}));
console.log('EDIT STATE:', JSON.stringify(editState));

await page.keyboard.press('End');
await page.keyboard.type('Z');
await page.waitForTimeout(300);
// webview 里的 input 回调在本测试页不稳定，改用 Cmd+S 直接取 getValue() 的结果
await page.keyboard.press('Meta+s');
await page.waitForTimeout(300);
await page.screenshot({ path: 'test/shot-fold.png' });
const stored = await page.evaluate(() => {
	const types = {};
	window.__posted.forEach(m => { types[m.type] = (types[m.type] || 0) + 1; });
	const saves = window.__posted.filter(m => m.type === 'save');
	const last = saves.length ? saves[saves.length - 1].value : '';
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	return {
		types,
		len: last.length,
		hasZ: last.includes('Z'),
		hasQuote: last.includes('引用块示例'),
		hasCode: last.includes('const hello'),
		hiddenNow: root.querySelectorAll('.aw-fold-hidden').length,
	};
});
console.log('STORED:', JSON.stringify(stored));

await browser.close();
server.close();
