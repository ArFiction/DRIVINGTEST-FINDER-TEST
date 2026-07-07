/**
 * DVSA driving test availability checker - ALERT ONLY (book-a-test flow).
 *
 * This walks the public "book your driving test" journey far enough to read
 * the availability calendar for a test centre, then STOPS. It never selects a
 * slot, never enters personal or payment details, and never books anything.
 * If bookable dates fall inside your preferred window, it sends an alert
 * (see src/notify.js).
 *
 * Looking human: it drives the real Google Chrome, keeps a persistent profile
 * so it's a returning visitor, strips the usual automation fingerprints,
 * moves the mouse to a field before clicking, and types character by character
 * in short chunks with varied speed and the odd "reading the card" pause. It
 * makes ONE gentle pass per run - no retry storms.
 *
 * Required env vars:
 *   DVSA_LICENCE_NUMBER   - your driving licence number
 *   DVSA_THEORY_NUMBER    - your theory test pass certificate number
 *   DVSA_TEST_CENTRE      - postcode or town to search for a test centre
 *
 * Optional env vars:
 *   DVSA_TEST_TYPE        - test category (default "car")
 *   DVSA_CENTRE_MATCH     - pick the centre whose name contains this text
 *   DVSA_EARLIEST_DATE    - ignore slots before this date (YYYY-MM-DD)
 *   DVSA_LATEST_DATE      - ignore slots after this date (default today+6mo)
 *   HEADLESS              - "false" to run headed (CI runs headed under xvfb)
 *   USER_DATA_DIR         - persistent Chrome profile dir (default .chrome-profile)
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sendAlert } from './notify.js';

const START_URL = process.env.DVSA_START_URL || 'https://driverpracticaltest.dvsa.gov.uk/';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'artifacts';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '.chrome-profile';

const licence = process.env.DVSA_LICENCE_NUMBER;
const theory = process.env.DVSA_THEORY_NUMBER;
const centreQuery = process.env.DVSA_TEST_CENTRE;
const testType = (process.env.DVSA_TEST_TYPE || 'car').toLowerCase();
const centreMatch = (process.env.DVSA_CENTRE_MATCH || '').toLowerCase();

const missing = [];
if (!licence) missing.push('DVSA_LICENCE_NUMBER');
if (!theory) missing.push('DVSA_THEORY_NUMBER');
if (!centreQuery) missing.push('DVSA_TEST_CENTRE');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(2);
}

const earliest = process.env.DVSA_EARLIEST_DATE || todayISO();
const latest = process.env.DVSA_LATEST_DATE || addMonthsISO(todayISO(), 6);

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addMonthsISO(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/** Human-like pause between actions. */
const pause = (page, min = 900, max = 2600) => page.waitForTimeout(rand(min, max));

const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

// Fingerprint tweaks so an automated Chrome does not announce itself.
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

let stepNo = 0;
async function snapshot(page, label) {
  stepNo += 1;
  const name = `${String(stepNo).padStart(2, '0')}-${label}`;
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: `${ARTIFACT_DIR}/${name}.png`, fullPage: true });
    writeFileSync(`${ARTIFACT_DIR}/${name}.html`, await page.content());
    console.log(`  [snapshot] ${name}  (url: ${page.url()})`);
  } catch (err) {
    console.error(`  Could not save snapshot ${name}:`, err.message);
  }
}

/** Move the pointer to a target in small steps, then click - not a teleport-click. */
async function humanClick(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (box) {
      const x = box.x + box.width / 2 + rand(-6, 6);
      const y = box.y + box.height / 2 + rand(-4, 4);
      await page.mouse.move(x, y, { steps: rand(6, 20) });
      await page.waitForTimeout(rand(90, 280));
    }
  } catch {
    /* boundingBox can fail for off-screen elements; fall through to click */
  }
  await locator.click();
}

function splitIntoChunks(s, n) {
  n = Math.max(1, Math.min(n, s.length));
  const size = Math.ceil(s.length / n);
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Type into the first present candidate the way a person copying off a card would. */
async function humanType(page, candidates, text, what) {
  const el = await firstPresent(page, candidates, what);
  await humanClick(page, el);
  await pause(page, 300, 800);
  const chunks = splitIntoChunks(text, rand(2, 4));
  for (let i = 0; i < chunks.length; i++) {
    await el.pressSequentially(chunks[i], { delay: rand(70, 165) });
    if (i < chunks.length - 1) await page.waitForTimeout(rand(250, 850)); // glance back at the card
  }
}

/** A little idle time reading the page: a small scroll and a pause. */
async function dwell(page) {
  try {
    await page.mouse.wheel(0, rand(120, 480));
  } catch {
    /* ignore */
  }
  await pause(page, 700, 2200);
}

/** Return a locator for the first of `candidates` that exists, else throw. */
async function firstPresent(page, candidates, what) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) return loc;
  }
  await snapshot(page, `NOTFOUND-${what}`.replace(/\s+/g, '-'));
  throw new Error(
    `Could not find "${what}" on the page (tried: ${candidates.join(', ')}). ` +
      `See the uploaded artifact to update the selector.`
  );
}

/** Click the first present candidate (human-style); returns false if none exist. */
async function clickIfPresent(page, candidates) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await humanClick(page, loc);
      return true;
    }
  }
  return false;
}

async function waitThroughQueue(page) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const url = page.url();
    const body = (await page.textContent('body').catch(() => '')) || '';
    if (!url.includes('queue.driverpracticaltest') && !/waiting room/i.test(body.slice(0, 2000))) {
      return;
    }
    console.log('In the DVSA queue, waiting 30s...');
    await page.waitForTimeout(30_000);
  }
  throw new Error('Still stuck in the DVSA queue after 10 minutes.');
}

function assertNotBlocked(html) {
  if (/_Incapsula_Resource|incapsula|imperva|request unsuccessful|access denied/i.test(html)) {
    throw new Error(
      'DVSA served an anti-bot challenge page instead of the service. ' +
        'This can happen from datacentre IPs; it will retry on the next scheduled run.'
    );
  }
}

async function launchBrowser() {
  const common = {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1366 + rand(-40, 40), height: 768 + rand(-30, 30) },
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    args: STEALTH_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  };
  let context;
  try {
    // Real Chrome: authentic TLS + feature fingerprint, unlike bundled Chromium.
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...common,
      channel: 'chrome',
    });
  } catch (err) {
    console.warn(`Real Chrome unavailable (${err.message.split('\n')[0]}); using Chromium.`);
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...common,
      userAgent: UA_CHROME,
    });
  }
  // Belt-and-braces masking of the residual automation tells. Real Chrome
  // already covers most of this; harmless where it does.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!navigator.languages || !navigator.languages.length) {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
    }
    window.chrome = window.chrome || { runtime: {} };
  });
  return context;
}

async function run() {
  const context = await launchBrowser();
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(60_000);

  try {
    console.log(
      `Looking for "${testType}" slots near "${centreQuery}" between ${earliest} and ${latest}.`
    );

    // 1. Landing / start ---------------------------------------------------
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());
    await snapshot(page, 'landing');
    await dwell(page);
    await clickIfPresent(page, [
      'a:has-text("Start now")',
      'button:has-text("Start now")',
      '.govuk-button--start',
    ]);
    await waitThroughQueue(page);

    // 2. Test type ---------------------------------------------------------
    const picked =
      (await clickIfPresent(page, [
        `#test-category-${testType}`,
        `input[value="${testType}" i]`,
        `label:has-text("${testType}") >> input[type=radio]`,
      ])) || (await clickIfPresent(page, [`label:has-text("${testType}")`]));
    if (picked) {
      await pause(page);
      await clickIfPresent(page, [
        '#driving-licence-submit',
        'button:has-text("Continue")',
        'button[type=submit]',
        '.govuk-button',
      ]);
      await waitThroughQueue(page);
    }
    await snapshot(page, 'after-test-type');
    await dwell(page);

    // 3. Driving licence number -------------------------------------------
    await humanType(
      page,
      ['#driving-licence-number', 'input[name="driving-licence-number" i]', '#dln'],
      licence,
      'driving licence field'
    );
    await pause(page);
    await clickIfPresent(page, [
      '#driving-licence-submit',
      'button:has-text("Continue")',
      'button[type=submit]',
      '.govuk-button',
    ]);
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());
    await snapshot(page, 'after-licence');
    await dwell(page);

    // 4. Theory test certificate number -----------------------------------
    await humanType(
      page,
      [
        '#theory-test-number',
        'input[name="theory-test-number" i]',
        'input[name*="theory" i]',
        '#theoryTestNumber',
      ],
      theory,
      'theory test number field'
    );
    await pause(page);
    await clickIfPresent(page, [
      'button:has-text("Continue")',
      '#theory-test-submit',
      'button[type=submit]',
      '.govuk-button',
    ]);
    await waitThroughQueue(page);
    await snapshot(page, 'after-theory');
    await dwell(page);

    // 5. Instructor / personal reference: answer "no" and continue --------
    await clickIfPresent(page, [
      '#instructor-referral-no',
      'input[value="no" i]',
      'label:has-text("No") >> input[type=radio]',
    ]);
    await clickIfPresent(page, ['button:has-text("Continue")', 'button[type=submit]', '.govuk-button']);
    await waitThroughQueue(page);
    await snapshot(page, 'after-instructor');
    await dwell(page);

    // 6. Test centre search -----------------------------------------------
    await humanType(
      page,
      ['#test-centres-input', 'input[name="test-centres" i]', 'input[name*="centre" i]', '#postcode'],
      centreQuery,
      'test centre search box'
    );
    await pause(page);
    await clickIfPresent(page, [
      '#test-centres-submit',
      'button:has-text("Find")',
      'button:has-text("Search")',
      'button[type=submit]',
      '.govuk-button',
    ]);
    await waitThroughQueue(page);
    await snapshot(page, 'centre-results');
    await dwell(page);

    const centreLinks = page.locator(
      '.test-centre-details-link, a.test-centre, .test-centre-results a, ol li a'
    );
    const count = await centreLinks.count().catch(() => 0);
    if (!count) {
      throw new Error('No test centres appeared for the search - check DVSA_TEST_CENTRE.');
    }
    let chosen = centreLinks.first();
    if (centreMatch) {
      for (let i = 0; i < count; i++) {
        const t = (await centreLinks.nth(i).textContent().catch(() => '')) || '';
        if (t.toLowerCase().includes(centreMatch)) {
          chosen = centreLinks.nth(i);
          break;
        }
      }
    }
    console.log(
      `  Selecting centre: ${(await chosen.textContent().catch(() => '')).trim().slice(0, 60)}`
    );
    await humanClick(page, chosen);
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());
    await snapshot(page, 'calendar');

    // 7. Read the availability calendar -----------------------------------
    await page.waitForSelector('.BookingCalendar-datesBody, .BookingCalendar', { timeout: 60_000 });
    const dates = await page.$$eval(
      '.BookingCalendar-date--bookable a, td.BookingCalendar-date--bookable',
      (els) =>
        els
          .map(
            (el) =>
              el.getAttribute('data-date') ||
              el.querySelector('a')?.getAttribute('data-date') ||
              null
          )
          .filter(Boolean)
    );

    const unique = [...new Set(dates)].sort();
    console.log(
      unique.length
        ? `  Bookable dates on the calendar: ${unique.join(', ')}`
        : '  No bookable dates shown on the calendar.'
    );

    const matches = unique.filter((d) => d >= earliest && d <= latest);

    // ALERT ONLY: stop here. No slot is selected; no booking is made.
    if (matches.length) {
      await sendAlert({
        title: 'DVSA: driving test slots available!',
        message:
          `"${testType}" slots near ${centreQuery} in your window (${earliest} to ${latest}):\n` +
          matches.join('\n') +
          '\n\nBook manually at https://driverpracticaltest.dvsa.gov.uk/',
        dates: matches,
      });
      console.log(`ALERT SENT for ${matches.length} date(s).`);
    } else {
      console.log('Nothing inside the preferred window; no alert sent.');
    }
    await pause(page, 1000, 2500);
  } catch (err) {
    await snapshot(page, 'failure');
    throw err;
  } finally {
    await context.close();
  }
}

run().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
