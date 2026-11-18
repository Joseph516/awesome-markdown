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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg .vditor-reset h1', { timeout: 20000 });
await page.waitForTimeout(600);

const t = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const h = root.querySelector('h1');
	const hbox = h.getBoundingClientRect();
	const range = document.createRange();
	range.selectNodeContents(h);
	const rr = range.getClientRects()[0] || { left: 0 };
	const cs = getComputedStyle(h);
	const before = getComputedStyle(h, '::before');
	const rootBox = root.getBoundingClientRect();
	return {
		rootLeft: rootBox.left,
		rootPaddingLeft: getComputedStyle(root).paddingLeft,
		headingBoxLeft: hbox.left,
		headingPaddingLeft: cs.paddingLeft,
		textLeft: rr.left,
		beforeLeft: before.left,
		beforeWidth: before.width,
		beforeBorderRight: before.borderRightWidth,
		beforeBorderTop: before.borderTopWidth,
		beforeContent: before.content,
		matchedRules: (() => {
			const out = [];
			for (const sheet of document.styleSheets) {
				try {
					for (const rule of sheet.cssRules) {
						const t = rule.cssText || '';
						if (t.includes('h1') && t.includes('H1')) out.push(t.slice(0, 160));
					}
				} catch (e) {}
			}
			return out;
		})(),
		afterContent: getComputedStyle(h, '::after').content,
		afterLeft: getComputedStyle(h, '::after').left,
	};
});
console.log(JSON.stringify(t, null, 1));
await browser.close();
server.close();
