import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
	const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
	fs.readFile(p, (err, data) => {
		if (err) {
			res.writeHead(404);
			res.end('not found');
			return;
		}
		res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
		res.end(data);
	});
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.vditor-wysiwyg', { timeout: 20000 });
await page.waitForTimeout(500);

const info = await page.evaluate(() => {
	const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
	const rows = [];
	Array.from(root.children).forEach((el, i) => {
		rows.push({
			i,
			tag: el.tagName.toLowerCase(),
			cls: el.className,
			type: el.getAttribute('data-type') || '',
			head: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 26),
		});
	});
	const firstHeading = root.querySelector('h1,h2,h3,h4,h5,h6');
	return {
		count: root.children.length,
		headingHTML: firstHeading ? firstHeading.outerHTML.slice(0, 220) : '',
		rows,
	};
});

console.log(JSON.stringify(info, null, 1));
await browser.close();
server.close();
