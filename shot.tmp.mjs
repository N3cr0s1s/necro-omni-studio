import { chromium } from 'playwright';
const DEMO = '/tmp/claude-1000/-home-alex-WebstormProjects-necro-omni-studio/8f751375-0fd6-42d6-aefd-f8b7b1434fb9/scratchpad/demo';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9321');
const page = browser.contexts()[0].pages()[0];
await page.evaluate((root) => localStorage.setItem('nos.lastProject', root), DEMO);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(8000);
await page.click('button:has-text("Export")');
await page.waitForTimeout(600);
await page.click('[role="dialog"] button:has-text("Export")');
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => document.querySelector('[role="status"]')?.textContent ?? null);
  if (t) { console.log(JSON.stringify({ timing: t })); break; }
}
await browser.close();
