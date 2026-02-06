/**
 * Shared headless browser management for Cloudflare-protected marketplaces.
 *
 * Uses puppeteer-core with the stealth plugin to bypass TLS fingerprinting.
 * Requires system Chrome/Chromium installed.
 * Browser instance is lazy-initialized and shared across requests.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer-core';
import { existsSync } from 'fs';

puppeteer.use(StealthPlugin());

let browser: Browser | null = null;

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findChrome(): string | null {
  const paths = CHROME_PATHS[process.platform] ?? [];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) {
    return browser;
  }

  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium not found. Install Google Chrome or set a custom path. ' +
      `Checked: ${(CHROME_PATHS[process.platform] ?? []).join(', ')}`
    );
  }

  browser = await (puppeteer as any).launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  }) as Browser;

  return browser;
}

export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Clean shutdown
process.on('exit', () => {
  if (browser) {
    browser.close().catch(() => {});
  }
});
