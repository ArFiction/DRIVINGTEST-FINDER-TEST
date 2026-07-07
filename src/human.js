/**
 * Human-like browser behaviour + fingerprint hardening for Playwright.
 *
 * Design principle drawn from current (2026) anti-bot research: randomise
 * BEHAVIOUR, keep IDENTITY stable. Detectors flag a fingerprint that mutates
 * on every visit as readily as one that is obviously fake, so the viewport,
 * user agent, timezone and GPU strings here are constant across runs (backed by
 * a persistent profile), while the mouse paths, keystroke timing and scrolling
 * vary every time the way a real person's would.
 *
 * What this does NOT do: defeat TLS/JA3 fingerprinting (only a real browser and
 * a residential IP fix that - see README) or guarantee anything against
 * enterprise anti-bot. It removes the obvious automation tells and makes the
 * interaction look human, which is the appropriate bar for a personal, low-
 * frequency checker.
 */

export const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
export const randf = (min, max) => min + Math.random() * (max - min);
export const sleep = (page, min, max) => page.waitForTimeout(rand(min, max));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Normal-ish distribution (Box-Muller) - real timing clusters around a mean. */
function gaussian(mean, sd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- Stable identity ------------------------------------------------------

export const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage', // avoids crashes on small-/tmp CI runners
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
];

export const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

// Constant desktop fingerprint. innerHeight < screen height leaves room for the
// browser chrome + Windows taskbar, matching a real 1080p laptop.
export const CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 955 },
  screen: { width: 1920, height: 1080 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  colorScheme: 'light',
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
};

export const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

// A GPU-less CI runner reports "SwiftShader" for WebGL, an instant bot tell.
// These override it with a plausible Windows desktop GPU (consistent with the
// Windows user agent). Override or disable via env if running on real hardware.
export const WEBGL_VENDOR = process.env.DVSA_WEBGL_VENDOR || 'Google Inc. (Intel)';
export const WEBGL_RENDERER =
  process.env.DVSA_WEBGL_RENDERER ||
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';

/**
 * Patch the residual automation tells on every page. Guards mean each patch
 * only fires where the value is actually missing/wrong, so it is harmless on
 * real headed Chrome (which already looks right) and corrective on the bundled
 * headless fallback.
 */
export async function applyStealth(context, opts = {}) {
  const spoofWebgl = opts.spoofWebgl !== false;
  await context.addInitScript(
    ({ vendor, renderer, spoofWebgl }) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!navigator.languages || !navigator.languages.length) {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      }
      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {};
      try {
        if (typeof Notification !== 'undefined') {
          Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        }
      } catch (e) {
        /* some contexts freeze Notification; ignore */
      }
      if (navigator.plugins && navigator.plugins.length === 0) {
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      }
      if (spoofWebgl) {
        const patch = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return vendor; // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return renderer; // UNMASKED_RENDERER_WEBGL
            return orig.call(this, p);
          };
        };
        if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
      }
    },
    { vendor: WEBGL_VENDOR, renderer: WEBGL_RENDERER, spoofWebgl }
  );
}

// --- Randomised behaviour -------------------------------------------------

// Tracked pointer position; the mouse starts somewhere plausible on screen.
let mx = 400;
let my = 400;

/**
 * Move the pointer along an imperfect cubic-Bezier path with random control
 * points, ease-in-out speed (accelerate away, decelerate onto the target) and
 * sub-pixel tremor - the opposite of a bot's straight-line, constant-speed dash.
 */
export async function moveMouseTo(page, x, y) {
  const dist = Math.hypot(x - mx, y - my) || 1;
  const steps = clamp(Math.round(dist / rand(8, 14)), 12, 42);
  const c1x = mx + (x - mx) * randf(0.15, 0.4) + rand(-60, 60);
  const c1y = my + (y - my) * randf(0.15, 0.4) + rand(-60, 60);
  const c2x = mx + (x - mx) * randf(0.6, 0.85) + rand(-60, 60);
  const c2y = my + (y - my) * randf(0.6, 0.85) + rand(-60, 60);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const bx =
      mt * mt * mt * mx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x + randf(-0.8, 0.8);
    const by =
      mt * mt * mt * my + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y + randf(-0.8, 0.8);
    await page.mouse.move(bx, by);
    if (Math.random() < 0.15) await page.waitForTimeout(rand(4, 22)); // uneven speed
  }
  mx = x;
  my = y;
}

/** A few aimless moves, as a person settles before interacting with a page. */
export async function idleMouse(page, min = 2, max = 4) {
  const vp = page.viewportSize() || { width: 1920, height: 955 };
  for (let i = 0, n = rand(min, max); i < n; i++) {
    await moveMouseTo(page, rand(80, vp.width - 80), rand(80, vp.height - 120));
    await sleep(page, 120, 520);
  }
}

/** Move to an element (sometimes overshooting and correcting), then click. */
export async function humanClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const tx = box.x + box.width * randf(0.3, 0.7);
    const ty = box.y + box.height * randf(0.3, 0.7);
    if (Math.random() < 0.25) {
      await moveMouseTo(page, tx + rand(-25, 25), ty + rand(-15, 15)); // overshoot
      await sleep(page, 40, 130);
    }
    await moveMouseTo(page, tx, ty);
    await sleep(page, 60, 200);
  }
  await locator.click();
}

/**
 * Type into a focused field the way someone copying an unfamiliar string off a
 * card does: keystrokes clustered around a mean with variance, the occasional
 * hesitation, and a small pause at group boundaries.
 */
export async function humanType(page, locator, text) {
  await humanClick(page, locator);
  await sleep(page, 250, 700);
  const groupEvery = rand(3, 5);
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    let d = clamp(gaussian(120, 45), 55, 320);
    if (Math.random() < 0.08) d += rand(350, 1100); // re-read the card
    else if (i > 0 && i % groupEvery === 0 && Math.random() < 0.5) d += rand(150, 500);
    await page.waitForTimeout(d);
  }
}

/** Smooth wheel scrolling in small increments, with the odd read-back upward. */
export async function humanScroll(page, total) {
  const target = total ?? rand(400, 1100);
  let done = 0;
  while (done < target) {
    const step = Math.min(rand(80, 200), target - done);
    await page.mouse.wheel(0, step);
    done += step;
    if (Math.random() < 0.12) {
      await sleep(page, 120, 350);
      await page.mouse.wheel(0, -rand(40, 120));
    }
    await sleep(page, 90, 300);
  }
}

/** Idle "reading" time on a page: a little scrolling and mouse drift. */
export async function dwell(page) {
  if (Math.random() < 0.7) await humanScroll(page, rand(200, 700));
  if (Math.random() < 0.5) await idleMouse(page, 1, 2);
  await sleep(page, 600, 2000);
}
