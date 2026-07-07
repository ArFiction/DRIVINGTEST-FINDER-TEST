/**
 * Human-like browser behaviour + fingerprint hardening for Playwright.
 *
 * Design principle from current (2026) anti-bot research: randomise BEHAVIOUR,
 * keep IDENTITY stable. The viewport, user agent, timezone and GPU strings are
 * constant across runs (a persistent profile makes that a returning visitor),
 * while mouse paths, keystroke timing and scrolling vary every run.
 *
 * The movement model matters: a plain uniform-parameter Bezier curve is itself a
 * known tell (constant velocity, unnaturally low jerk - detectable with ~98.7%
 * accuracy in the literature). So the mouse mover below re-times the curve with
 * a minimum-jerk velocity profile (accelerate to a mid-path peak, decelerate
 * onto the target), bows the path to one side, and adds autocorrelated drift +
 * sub-pixel tremor. Clicks are non-atomic (a real down/hold/up), and each run
 * draws a fresh "persona" so timing distributions differ run to run.
 *
 * What this does NOT do: defeat TLS/JA3 or HTTP/2 fingerprinting (only a real
 * browser + a residential IP address help there - see README), or beat
 * enterprise anti-bot. It removes the obvious automation tells and makes the
 * interaction look human, the right bar for a personal, low-frequency checker.
 */

export const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
export const randf = (min, max) => min + Math.random() * (max - min);
export const sleep = (page, min, max) => page.waitForTimeout(rand(min, max));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Normal-ish distribution (Box-Muller). */
function gaussian(mean, sd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Right-skewed (log-normal) draw - matches human inter-key timing. */
const lognormal = (median, sigma) => median * Math.exp(sigma * gaussian(0, 1));
/** Minimum-jerk easing: 0 speed at both ends, bell-shaped velocity in between. */
const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

// A per-run "persona": each process types and moves at its own pace, so the
// timing DISTRIBUTIONS shift run to run rather than replaying one fixed sequence.
const persona = {
  typeMedian: rand(140, 210), // ms inter-key flight median
  typeSigma: randf(0.28, 0.4),
  moveSpeed: randf(0.85, 1.2), // multiplies Fitts movement time
  readPace: randf(0.8, 1.3), // multiplies reading pauses
  bowSide: Math.random() < 0.5 ? 1 : -1, // which way mouse paths bow
};

// --- Stable identity ------------------------------------------------------

export const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
  '--force-webrtc-ip-handling-policy=default_public_interface_only', // no local-IP leak
];

export const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

// Constant desktop fingerprint. Locale/timezone match a UK visitor (and must
// match the egress IP's region). Accept-Language is left to Chrome to emit
// natively from the locale - hand-injecting headers risks a UA/header mismatch.
export const CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 955 },
  screen: { width: 1920, height: 1080 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  colorScheme: 'light',
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
};

// Optional WebGL renderer override, used ONLY when DVSA_WEBGL_SPOOF=on.
// Off by default: on the real-Chrome (Linux) path an honest software renderer
// is internally consistent, whereas a Windows GPU string on a Linux browser is
// a contradiction that scores WORSE. Only enable this if you have committed to a
// fully consistent Windows profile (fonts, UA-CH, WebGPU) - see README.
export const WEBGL_VENDOR = process.env.DVSA_WEBGL_VENDOR || 'Google Inc. (Intel)';
export const WEBGL_RENDERER =
  process.env.DVSA_WEBGL_RENDERER ||
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';

/**
 * Minimal, opt-in page hardening.
 *
 * Deliberately does almost nothing: real headed Chrome already reports correct
 * plugins, languages, chrome object, codecs and permissions, and navigator.
 * webdriver is handled by the --disable-blink-features launch flag (a native
 * fix, unlike a JS getter which leaves a detectable descriptor). Faking those in
 * JS is a known tell that backfires. The only optional patch is a WebGL vendor/
 * renderer override, and only when explicitly enabled for a consistent profile;
 * it masks getParameter AND its toString so a native-code probe cannot spot it.
 */
export async function applyStealth(context, opts = {}) {
  if (!opts.spoofWebgl) return; // honest by default
  await context.addInitScript(
    ({ vendor, renderer }) => {
      const VENDOR = 37445;
      const RENDERER = 37446;
      const nativeToString = Function.prototype.toString;
      const masked = new WeakMap();
      for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
        if (!Ctx) continue;
        const orig = Ctx.prototype.getParameter;
        const patched = function getParameter(p) {
          if (p === VENDOR) return vendor;
          if (p === RENDERER) return renderer;
          return orig.call(this, p);
        };
        masked.set(patched, 'function getParameter() { [native code] }');
        Ctx.prototype.getParameter = patched;
      }
      const tsProxy = new Proxy(nativeToString, {
        apply(target, thisArg, args) {
          if (masked.has(thisArg)) return masked.get(thisArg);
          if (thisArg === tsProxy) return 'function toString() { [native code] }';
          return Reflect.apply(target, thisArg, args);
        },
      });
      Function.prototype.toString = tsProxy;
    },
    { vendor: WEBGL_VENDOR, renderer: WEBGL_RENDERER }
  );
}

// --- Randomised behaviour -------------------------------------------------

// Tracked pointer position; starts somewhere plausible on screen.
let mx = 400;
let my = 400;

/**
 * Move the pointer from its current spot to (x, y) along a one-sided Bezier bow,
 * re-timed by a minimum-jerk velocity profile, with autocorrelated drift and
 * sub-pixel tremor. Emits many small moves (not the linear {steps} interpolation)
 * so velocity/acceleration look human. `targetW` is the target width for Fitts
 * timing (wider target -> quicker move).
 */
export async function moveMouseTo(page, x, y, targetW = 40) {
  const fromX = mx;
  const fromY = my;
  const dx = x - fromX;
  const dy = y - fromY;
  const dist = Math.hypot(dx, dy) || 1;

  // Fitts's law: movement time grows with distance / target width.
  const fitts = rand(60, 150) + rand(120, 190) * Math.log2((2 * dist) / Math.max(targetW, 8) + 1);
  const T = fitts * persona.moveSpeed;
  const dtMean = rand(11, 15); // native mousemove cadence ~8-16ms
  const steps = Math.max(18, Math.round(T / dtMean));

  // Bow to ONE side (unit normal * a fraction of the distance).
  const nx = -dy / dist;
  const ny = dx / dist;
  const bow = persona.bowSide * dist * randf(0.04, 0.18);
  const c1x = fromX + dx * 0.33 + nx * bow * randf(0.6, 1.1);
  const c1y = fromY + dy * 0.33 + ny * bow * randf(0.6, 1.1);
  const c2x = fromX + dx * 0.66 + nx * bow * randf(0.5, 1.0);
  const c2y = fromY + dy * 0.66 + ny * bow * randf(0.5, 1.0);

  let driftX = 0;
  let driftY = 0;
  for (let i = 1; i <= steps; i++) {
    const t = minJerk(i / steps); // bell-shaped speed, not uniform
    const u = 1 - t;
    let px = u * u * u * fromX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x;
    let py = u * u * u * fromY + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y;
    driftX = driftX * 0.8 + gaussian(0, 0.4);
    driftY = driftY * 0.8 + gaussian(0, 0.4);
    px += driftX + gaussian(0, 0.7);
    py += driftY + gaussian(0, 0.7);
    await page.mouse.move(px, py);
    if (Math.random() < 0.05) await page.waitForTimeout(rand(40, 160)); // mid-flight hesitation
    await page.waitForTimeout(Math.max(4, Math.round(dtMean + gaussian(0, 3))));
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

/**
 * Move to an element (overshooting and correcting on long hops), hover briefly,
 * then click with a real mousedown->hold->mouseup (Playwright's click{delay}),
 * landing slightly off-centre. Keeps Playwright's actionability checks.
 */
export async function humanClick(page, locator) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 15_000 });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (box) {
      const tx = box.x + box.width * randf(0.3, 0.7);
      const ty = box.y + box.height * randf(0.3, 0.7);
      const dist = Math.hypot(tx - mx, ty - my);
      if (dist > 300 && Math.random() < 0.6) {
        const ux = (tx - mx) / dist;
        const uy = (ty - my) / dist;
        const over = rand(6, 22);
        await moveMouseTo(page, tx + ux * over, ty + uy * over, box.width);
        await sleep(page, 70, 170);
      }
      await moveMouseTo(page, tx, ty, box.width);
      await sleep(page, 80, 220); // hover-dwell
    }
  } catch {
    /* fall through to a plain click if geometry/scroll failed */
  }
  await locator.click({ delay: rand(55, 120) }); // non-atomic down/hold/up
}

/**
 * Type into a field the way someone copying an unfamiliar string off a card does:
 * a real click to focus, a pause to read, then per-character entry with
 * log-normal inter-key timing, boundary/repeat pauses and occasional hesitation.
 * Types cleanly (no simulated typos - those risk corrupting an exact-match
 * licence/theory field); the caller can verify the field value afterwards.
 */
export async function humanType(page, locator, text, opts = {}) {
  const digits = opts.digits ?? /^[0-9\s]+$/.test(text);
  await humanClick(page, locator);
  await sleep(page, 300, 1200); // read the label / the card first
  const groupEvery = rand(3, 5);
  let prev = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let flight = lognormal(digits ? persona.typeMedian + 40 : persona.typeMedian, persona.typeSigma);
    if (prev && ch === prev) flight += rand(30, 80); // same key twice
    if (prev === ' ' || '.,-/'.includes(prev)) flight += rand(120, 350); // boundary
    await page.waitForTimeout(clamp(flight, 60, 800));
    if (Math.random() < 0.02) {
      await page.waitForTimeout(rand(400, 1500)); // thinking pause
    } else if (digits && i > 0 && i % groupEvery === 0) {
      await page.waitForTimeout(rand(250, 700)); // glance at the next group of digits
    }
    await page.keyboard.type(ch); // literal char (handles case/symbols correctly)
    prev = ch;
  }
}

/** Smooth wheel scrolling in eased bursts, with jitter, back-scroll and reads. */
export async function humanScroll(page, total) {
  const target = total ?? rand(400, 1100);
  const dir = target < 0 ? -1 : 1;
  let remaining = Math.abs(target);
  while (remaining > 0) {
    const burst = Math.min(remaining, rand(60, 260));
    const events = Math.max(3, Math.round(burst / rand(18, 40)));
    for (let i = 1; i <= events; i++) {
      const ease = minJerk(i / events); // accelerate then decelerate within the burst
      const step = dir * (burst / events) * (0.6 + 0.8 * ease) + gaussian(0, 3);
      await page.mouse.wheel(0, step);
      await sleep(page, 12, 28);
    }
    remaining -= burst;
    if (Math.random() < 0.15) {
      await page.mouse.wheel(0, -dir * rand(20, 70)); // overshoot correct
      await sleep(page, 120, 300);
    }
    if (Math.random() < 0.18) await page.mouse.wheel(0, -dir * rand(40, 140)); // re-read
    await sleep(page, Math.round(220 * persona.readPace), Math.round(1400 * persona.readPace));
  }
}

/** Idle "reading" time on a page: a little scrolling and mouse drift. */
export async function dwell(page) {
  if (Math.random() < 0.7) await humanScroll(page, rand(200, 700));
  if (Math.random() < 0.5) await idleMouse(page, 1, 2);
  await sleep(page, Math.round(600 * persona.readPace), Math.round(2000 * persona.readPace));
}
