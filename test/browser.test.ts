import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsSync = vi.hoisted(() => vi.fn());
const launch = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({ existsSync }));
vi.mock('puppeteer-extra', () => ({
  default: { use: vi.fn(), launch },
}));
vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: () => ({ name: 'stealth' }) }));

/** Module state is process-wide (the browser singleton and the lock chain), so
 *  each test gets its own copy. */
async function load() {
  vi.resetModules();
  return import('../src/browser.js');
}

function fakeBrowser(connected = true) {
  return {
    connected,
    newPage: vi.fn().mockResolvedValue({ setViewport: vi.fn().mockResolvedValue(undefined) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const platform = process.platform;
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  existsSync.mockReset();
  launch.mockReset();
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
});

afterEach(() => {
  setPlatform(platform);
});

describe('findChrome', () => {
  it.each([
    ['darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['linux', '/usr/bin/google-chrome'],
    ['win32', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ])('returns the first existing path on %s', async (os, expected) => {
    setPlatform(os);
    existsSync.mockImplementation((p: string) => p === expected);
    const { findChrome } = await load();
    expect(findChrome()).toBe(expected);
  });

  it('falls through to the next candidate when the first is absent', async () => {
    setPlatform('linux');
    existsSync.mockImplementation((p: string) => p === '/usr/bin/chromium');
    const { findChrome } = await load();
    expect(findChrome()).toBe('/usr/bin/chromium');
  });

  it('returns null when no candidate exists', async () => {
    setPlatform('darwin');
    existsSync.mockReturnValue(false);
    const { findChrome } = await load();
    expect(findChrome()).toBeNull();
  });

  it('returns null on a platform with no candidates', async () => {
    setPlatform('freebsd');
    existsSync.mockReturnValue(true);
    const { findChrome } = await load();
    expect(findChrome()).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });
});

describe('getBrowser', () => {
  it('prefers PUPPETEER_EXECUTABLE_PATH over detection', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    existsSync.mockReturnValue(true);
    launch.mockResolvedValue(fakeBrowser());
    const { getBrowser } = await load();
    await getBrowser();
    expect(launch.mock.calls[0][0].executablePath).toBe('/opt/chrome');
  });

  it('launches headless with a sandbox-free arg set', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    launch.mockResolvedValue(fakeBrowser());
    const { getBrowser } = await load();
    await getBrowser();
    const opts = launch.mock.calls[0][0];
    expect(opts.headless).toBe(true);
    expect(opts.args).toContain('--no-sandbox');
  });

  it('names the paths it checked when Chrome is missing', async () => {
    setPlatform('linux');
    existsSync.mockReturnValue(false);
    const { getBrowser } = await load();
    await expect(getBrowser()).rejects.toThrow(/\/usr\/bin\/google-chrome/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('reuses a connected browser instead of launching twice', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    launch.mockResolvedValue(fakeBrowser(true));
    const { getBrowser } = await load();
    const first = await getBrowser();
    const second = await getBrowser();
    expect(second).toBe(first);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('relaunches when the previous browser has disconnected', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    launch.mockResolvedValueOnce(fakeBrowser(false)).mockResolvedValueOnce(fakeBrowser(true));
    const { getBrowser } = await load();
    await getBrowser();
    await getBrowser();
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe('newPage', () => {
  it('sets a desktop viewport on the page it returns', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    const b = fakeBrowser();
    launch.mockResolvedValue(b);
    const { newPage } = await load();
    const page = await newPage();
    expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800 });
  });
});

describe('closeBrowser', () => {
  it('drops the singleton so the next call relaunches', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    launch.mockResolvedValue(fakeBrowser());
    const { getBrowser, closeBrowser } = await load();
    await getBrowser();
    await closeBrowser();
    await getBrowser();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('survives a browser that throws on close', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    const b = fakeBrowser();
    b.close.mockRejectedValue(new Error('already dead'));
    launch.mockResolvedValue(b);
    const { getBrowser, closeBrowser } = await load();
    await getBrowser();
    await expect(closeBrowser()).resolves.toBeUndefined();
  });

  it('is a no-op when no browser was ever launched', async () => {
    const { closeBrowser } = await load();
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});

describe('rotateBrowser', () => {
  it('closes the current browser so the next scrape starts clean', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome';
    const b = fakeBrowser();
    launch.mockResolvedValue(b);
    const { getBrowser, rotateBrowser } = await load();
    await getBrowser();
    await rotateBrowser();
    expect(b.close).toHaveBeenCalled();
  });
});

describe('withBrowserLock', () => {
  it('runs the second caller only after the first has finished', async () => {
    const { withBrowserLock } = await load();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((r) => {
      void withBrowserLock(async () => {
        order.push('first:start');
        r();
        await new Promise<void>((done) => { releaseFirst = done; });
        order.push('first:end');
      });
    });

    await firstStarted;
    const second = withBrowserLock(async () => { order.push('second:start'); });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await second;
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('releases the lock when the guarded function throws', async () => {
    const { withBrowserLock } = await load();
    await expect(withBrowserLock(async () => { throw new Error('scrape failed'); })).rejects.toThrow('scrape failed');
    await expect(withBrowserLock(async () => 'after')).resolves.toBe('after');
  });

  it('preserves call order across many waiters', async () => {
    const { withBrowserLock } = await load();
    const finished: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        withBrowserLock(async () => {
          await new Promise((r) => setTimeout(r, (5 - i) * 2));
          finished.push(i);
        }),
      ),
    );
    expect(finished).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns the guarded function value to its own caller', async () => {
    const { withBrowserLock } = await load();
    const [a, b] = await Promise.all([
      withBrowserLock(async () => 'a'),
      withBrowserLock(async () => 'b'),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });
});
