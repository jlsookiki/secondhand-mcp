/**
 * Shared headless browser management for Cloudflare-protected marketplaces.
 *
 * Uses puppeteer-core with the stealth plugin to bypass TLS fingerprinting.
 * Requires system Chrome/Chromium installed.
 * Browser instance is lazy-initialized and shared across requests.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer-core';
import { existsSync } from 'fs';

const puppeteer = puppeteerExtra.default ?? puppeteerExtra;
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

  // In Docker/production, use PUPPETEER_EXECUTABLE_PATH. Fall back to local detection for dev.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || findChrome();
  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium not found. Set PUPPETEER_EXECUTABLE_PATH or install Google Chrome. ' +
      `Checked: ${(CHROME_PATHS[process.platform] ?? []).join(', ')}`
    );
  }

  browser = await (puppeteer as any).launch({
    headless: true,
    executablePath,
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-software-rasterizer',
      '--js-flags=--max-old-space-size=256',
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

/**
 * Restart the browser. This build has no residential proxy (it runs from the
 * user's own machine), so rotation is just a fresh browser to clear transient
 * state between retries.
 */
export async function rotateBrowser(): Promise<void> {
  await closeBrowser();
}

/**
 * Serialize browser-based scrapes. The browser is a process-wide singleton and
 * rotateBrowser() closes it — so if two scrapes ran concurrently, one restarting
 * would yank the browser out from under the other. All scrapes run through this.
 */
let browserLock: Promise<void> = Promise.resolve();
export async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = browserLock;
  let release!: () => void;
  browserLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// Clean shutdown
process.on('exit', () => {
  if (browser) {
    browser.close().catch(() => {});
  }
});
