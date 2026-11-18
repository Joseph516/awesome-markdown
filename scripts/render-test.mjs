import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = process.env.AWESOME_THEME === 'dark' ? 'dark' : 'classic';
const THEME_KEY = THEME === 'dark' ? 'dark' : 'light';
const MODE = process.env.AWESOME_MODE === 'ir' ? 'ir' : 'wysiwyg';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.eot': 'application/vnd.ms-fontobject',
	'.map': 'application/json',
};

const INITIAL_MD = [
	'# Awesome Markdown',
	'',
	'这是一个**所见即所得**的 Markdown 编辑器。',
	'',
	'- 直接在渲染结果上编辑',
	'- 右键插入段落、引用、表格',
	'',
	'> 引用块示例',
	'',
	'| 名字 | 说明 |',
	'| --- | --- |',
	'| 表格 | 已渲染 |',
	'',
	'```js',
	'const hello = "world";',
	'```',
	'',
].join('\n');

function buildHtml() {
	const cfg = {
		cdn: '/node_modules/vditor',
		mode: MODE,
		showToolbar: true,
		contextMenu: true,
		theme: THEME,
	};
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<link rel="stylesheet" href="/node_modules/vditor/dist/index.css" />
<link rel="stylesheet" href="/media/style.css" />
</head>
<body data-theme="${THEME_KEY}">
<div id="app"></div>
<script>
window.__AWESOME__ = ${JSON.stringify(cfg)};
window.__INITIAL__ = ${JSON.stringify(INITIAL_MD)};
window.__posted = [];
window.acquireVsCodeApi = function () {
	return {
		postMessage: function (msg) {
			window.__posted.push(msg);
			if (msg.type === 'ready') {
				setTimeout(function () {
					window.postMessage({ type: 'init', value: window.__INITIAL__, theme: '${THEME}' }, '*');
				}, 0);
			}
		},
		setState: function () {},
		getState: function () { return {}; }
	};
};
</script>
<script src="/node_modules/vditor/dist/index.min.js"></script>
<script src="/media/main.js"></script>
</body>
</html>`;
}

async function main() {
	const { chromium } = await import('playwright');

	fs.mkdirSync(path.join(ROOT, 'test'), { recursive: true });
	fs.writeFileSync(path.join(ROOT, 'test', 'webview.html'), buildHtml(), 'utf8');

	const server = http.createServer((req, res) => {
		const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
		const filePath = path.join(ROOT, urlPath);
		if (!filePath.startsWith(ROOT)) {
			res.writeHead(403);
			res.end('forbidden');
			return;
		}
		fs.readFile(filePath, (err, buf) => {
			if (err) {
				res.writeHead(404);
				res.end('not found');
				return;
			}
			res.writeHead(200, {
				'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
			});
			res.end(buf);
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	const browser = await chromium.launch();
	const page = await browser.newPage({
		viewport: { width: 1280, height: Number(process.env.AWESOME_VP_H || 900) },
	});

	const errors = [];
	const badResponses = [];
	page.on('console', (m) => {
		if (m.type() === 'error') {
			errors.push(m.text());
		}
	});
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('response', (r) => {
		if (r.status() >= 400) {
			badResponses.push(r.status() + ' ' + r.url());
		}
	});

	await page.goto(
		`http://127.0.0.1:${port}/test/harness.html${THEME === 'dark' ? '?theme=dark' : ''}`,
		{ waitUntil: 'domcontentloaded' },
	);
	await page.waitForSelector(`.vditor-${MODE} .vditor-reset`, { timeout: 20000 });

	const toolbarLabels = await page.evaluate(() =>
		Array.from(document.querySelectorAll('.vditor-toolbar__item')).map((b) => {
			const use = b.querySelector('use');
			const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
			return {
				type: b.getAttribute('data-type') || (href || '').replace(/^#vditor-icon-/, ''),
				label: b.getAttribute('aria-label'),
			};
		}),
	);
	console.log('TOOLBAR:', JSON.stringify(toolbarLabels));
	await page.waitForTimeout(1200);

	const initial = await page.evaluate(() => ({
		hasVditorGlobal: typeof window.Vditor === 'function',
		h1: !!document.querySelector('.vditor-wysiwyg h1'),
		bold: !!document.querySelector('.vditor-wysiwyg strong'),
		tableCount: document.querySelectorAll('.vditor-wysiwyg table').length,
		blockquote: !!document.querySelector('.vditor-wysiwyg blockquote'),
		codeBlock: !!document.querySelector('.vditor-wysiwyg .vditor-wysiwyg__pre, .vditor-wysiwyg pre'),
	}));

	await page.screenshot({ path: path.join(ROOT, 'test', `shot-1-initial-${THEME_KEY}.png`) });

	// 工具栏悬浮说明：悬停「粗体」按钮，确认提示是中文
	await page.locator('.vditor-toolbar__item').nth(1).hover();
	await page.waitForTimeout(800);
	await page.screenshot({
		path: path.join(ROOT, 'test', `shot-7-toolbar-hint-${THEME_KEY}.png`),
		clip: { x: 0, y: 0, width: 1000, height: 150 },
	});

	// 代码块编辑态：点击渲染出来的代码块后截图，用于对比 wysiwyg 与 ir 两种模式
	const codeTarget = page
		.locator('.vditor-wysiwyg__preview, .vditor-wysiwyg__block, .vditor-ir__node')
		.filter({ hasText: 'const hello' })
		.first();
	if ((await codeTarget.count()) > 0) {
		await codeTarget.click({ position: { x: 60, y: 14 }, timeout: 8000 }).catch(() => undefined);
		await page.waitForTimeout(700);
		const blockHtml = await page.evaluate((mode) => {
			const root = document.querySelector(mode === 'ir' ? '.vditor-ir' : '.vditor-wysiwyg');
			const block = root && root.querySelector('.vditor-wysiwyg__block');
			return block ? block.outerHTML.replace(/\s+/g, ' ').slice(0, 2400) : 'no-block';
		}, MODE);
		console.log('BLOCK_HTML:', blockHtml);
		const geo = await page.evaluate((mode) => {
			const root = document.querySelector(mode === 'ir' ? '.vditor-ir' : '.vditor-wysiwyg');
			const block = root && root.querySelector('.vditor-wysiwyg__block');
			const pre = block && block.querySelector('.vditor-wysiwyg__pre');
			if (!block || !pre) {
				return 'none';
			}
			const s = getComputedStyle(pre);
			const r = pre.getBoundingClientRect();
			const br = block.getBoundingClientRect();
			return JSON.stringify({
				position: s.position,
				top: s.top,
				left: s.left,
				width: Math.round(r.width),
				left_px: Math.round(r.left),
				block_left: Math.round(br.left),
				block_width: Math.round(br.width),
				children: Array.from(block.children).map((c) => `${c.tagName}.${c.className}`),
				parent_is_block: pre.parentElement.className,
			});
		}, MODE);
		console.log('GEO:', geo);
		const actionEls = await page.evaluate(() =>
			Array.from(document.querySelectorAll('[class*="action"], [class*="panel"]'))
				.map((e) => `${e.tagName}.${e.className}`)
				.slice(0, 8),
		);
		console.log('ACTION_ELS:', JSON.stringify(actionEls));
		await page.screenshot({
			path: path.join(ROOT, 'test', `shot-5-codeblock-${MODE}-${THEME_KEY}.png`),
		});
		await page.keyboard.press('Escape').catch(() => undefined);
		await page.waitForTimeout(300);
	}

	// 右键 → 菜单
	const target = page.locator('.vditor-wysiwyg .vditor-reset').first();
	const box = await target.boundingBox();
	await page.mouse.click(box.x + 160, box.y + 28, { button: 'right' });
	await page.waitForSelector('.aw-menu', { timeout: 5000 });
	const menuItems = await page.locator('.aw-menu .aw-menu-item').allInnerTexts();
	await page.screenshot({ path: path.join(ROOT, 'test', `shot-2-menu-${THEME_KEY}.png`) });

	// 表格子菜单 → 3×3
	await page.locator('.aw-menu .aw-menu-item', { hasText: '表格' }).first().click();
	await page.locator('.aw-menu .aw-submenu').first().waitFor({ timeout: 5000 });
	await page.screenshot({ path: path.join(ROOT, 'test', `shot-3-table-submenu-${THEME_KEY}.png`) });
	await page.locator('.aw-menu .aw-submenu .aw-sub-item', { hasText: '3 行 × 3 列' }).first().click();
	await page.waitForTimeout(1200);

	const afterInsert = await page.evaluate(() => {
		const changes = window.__posted.filter((m) => m.type === 'change');
		const last = changes.length ? changes[changes.length - 1].value : undefined;
		return {
			tables: document.querySelectorAll('.vditor-wysiwyg table').length,
			hasNewHeader: !!(last && last.includes('列 1')),
			markdownTail: last ? last.slice(-220) : null,
		};
	});

	await page.screenshot({ path: path.join(ROOT, 'test', `shot-4-after-insert-${THEME_KEY}.png`) });

	// 长菜单：展开「代码块」子菜单（9 项），确认菜单整体不会超出视口
	await page.mouse.click(box.x + 160, box.y + 28, { button: 'right' });
	await page.waitForSelector('.aw-menu', { timeout: 5000 });
	await page.locator('.aw-menu .aw-menu-item', { hasText: '代码块' }).first().click();
	await page.locator('.aw-menu .aw-submenu').first().waitFor({ timeout: 5000 });
	await page.waitForTimeout(250);
	const menuBox = await page.locator('.aw-menu').boundingBox();
	const vp = page.viewportSize();
	const menuScroll = await page.evaluate(() => {
		const el = document.querySelector('.aw-menu');
		return {
			clientHeight: el.clientHeight,
			scrollHeight: el.scrollHeight,
			overflowY: getComputedStyle(el).overflowY,
		};
	});
	console.log(
		'MENU_BOX:',
		JSON.stringify({
			top: Math.round(menuBox.y),
			bottom: Math.round(menuBox.y + menuBox.height),
			viewport: vp.height,
			inViewport: Math.round(menuBox.y + menuBox.height) <= vp.height,
			scroll: menuScroll,
		}),
	);
	await page.screenshot({ path: path.join(ROOT, 'test', `shot-6-code-menu-${THEME_KEY}.png`) });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);

	// 任务列表：勾选第 2 项，验证已完成项自动沉到列表末尾
	const tasks = page.locator('.vditor-wysiwyg input[type=checkbox]');
	const taskCount = await tasks.count();
	console.log('TASK_COUNT:', taskCount);
	// 在根节点打个标记：如果重排走了 setValue，整个编辑器会重建、标记就没了
	await page.evaluate(() => {
		const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
		if (root) {
			root.dataset.awMarker = 'kept';
		}
	});
	if (taskCount >= 2) {
		await tasks.nth(1).click();
		await page.waitForTimeout(900);
	}
	const markerKept = await page.evaluate(() => {
		const root = document.querySelector('.vditor-wysiwyg .vditor-reset');
		return !!(root && root.dataset.awMarker === 'kept');
	});
	console.log('MARKER_KEPT:', markerKept);
	const taskOrder = await page.evaluate(() => {
		const changes = window.__posted.filter((m) => m.type === 'change');
		const last = changes.length ? changes[changes.length - 1].value : '';
		return last.split('\n').filter((line) => /\[[ xX]\]/.test(line));
	});
	console.log('TASK_ORDER:', JSON.stringify(taskOrder));

	// 自定义行列
	await page.mouse.click(box.x + 160, box.y + 28, { button: 'right' });
	await page.waitForSelector('.aw-menu', { timeout: 5000 });
	await page.locator('.aw-menu .aw-menu-item', { hasText: '表格' }).first().click();
	await page.locator('.aw-menu .aw-submenu').first().waitFor({ timeout: 5000 });
	await page.locator('.aw-rows').fill('4');
	await page.locator('.aw-cols').fill('5');
	await page.locator('.aw-sub-primary').click();
	await page.waitForTimeout(1200);

	const custom = await page.evaluate(() => {
		const changes = window.__posted.filter((m) => m.type === 'change');
		const last = changes.length ? changes[changes.length - 1].value : '';
		const lastBlock = last.split('\n').filter((l) => l.trim().startsWith('|')).slice(-5).join('\n');
		return {
			tail: lastBlock,
			hasCol5: last.includes('列 5'),
			hasCol1: last.includes('列 1'),
		};
	});

	// 保存快捷键
	await page.keyboard.press('Meta+s');
	await page.waitForTimeout(300);
	const saved = await page.evaluate(() => window.__posted.some((m) => m.type === 'save'));

	const result = { initial, menuItems, afterInsert, custom, saved, errors, badResponses };
	console.log(JSON.stringify(result, null, 2));

	await browser.close();
	server.close();

	const ok =
		initial.hasVditorGlobal &&
		initial.h1 &&
		initial.bold &&
		initial.tableCount >= 1 &&
		initial.blockquote &&
		menuItems.some((t) => t.includes('表格')) &&
		menuItems.some((t) => t.includes('引用')) &&
		afterInsert.tables >= 2 &&
		afterInsert.hasNewHeader &&
		custom.hasCol5 &&
		saved &&
		errors.length === 0 &&
		badResponses.length === 0;

	if (!ok) {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
