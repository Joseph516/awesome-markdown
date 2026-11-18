import { chromium } from 'playwright';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="76" height="76">
	<path d="M1.3 11.7V4.3l3.05 3.35L7.4 4.3v7.4" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
	<path d="M11.4 4.2v6.5" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round"/>
	<path d="M9.8 9.1l1.6 1.7 1.6-1.7" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const html = `<!DOCTYPE html><html><body style="margin:0">
<div style="width:128px;height:128px;background:#1f2937;border-radius:22px;display:flex;align-items:center;justify-content:center;box-sizing:border-box">
${svg}
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: 'media/icon.png' });
await browser.close();
console.log('media/icon.png written');
