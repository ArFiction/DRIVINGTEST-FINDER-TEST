/**
 * DVSA driving test availability checker - ALERT ONLY (book-a-test flow).
 *
 * Walks the public "book your driving test" journey far enough to read the
 * availability calendar for a test centre, then STOPS. It never selects a slot,
 * never enters personal or payment details, and never books anything. If
 * bookable dates fall inside your window, it sends an alert (see src/notify.js).
 *
 * Human behaviour + fingerprint hardening live in src/human.js. Every step also
 * saves a numbered screenshot + HTML dump to ARTIFACT_DIR and tries several
 * likely selectors, so the first real run is self-documenting if DVSA's markup
 * differs from the guesses here.
 *
 * Required env vars:
 *   DVSA_LICENCE_NUMBER   - your driving licence number
 *   DVSA_THEORY_NUMBER    - your theory test pass certificate number
 *
 * Optional env vars:
 *   DVSA_TEST_CENTRE      - postcode or town to search for a test centre
 *   DVSA_TEST_TYPE        - test category (default "car")
 *   DVSA_CENTRE_MATCH     - pick the centre whose name contains this text
 *   DVSA_EARLIEST_DATE    - ignore slots before this date (YYYY-MM-DD)
 *   DVSA_LATEST_DATE      - ignore slots after this date (default today+6mo)
 *   DVSA_WEBGL_SPOOF      - "off" to disable the WebGL GPU override
 *   HEADLESS              - "false" to run headed (CI runs headed under xvfb)
 *   USER_DATA_DIR         - persistent Chrome profile dir (default .chrome-profile)
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sendAlert } from './notify.js';
import {
  LAUNCH_ARGS,
  IGNORE_DEFAULT_ARGS,
  CONTEXT_OPTIONS,
  applyStealth,
  humanClick,
  humanType,
  idleMouse,
  dwell,
  sleep,
} from './human.js';

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
if (!centreQuery) missing.push('DVSA_TEST_CENTRE');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(2);
}
if (!theory) {
  console.warn(
    'DVSA_THEORY_NUMBER not set - running without it. The run will show whether DVSA requires it.'
  );
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

/**
 * Human-type into the first present candidate selector. When `verify` is set
 * (licence / theory number), read the field back and retype once if it does not
 * match - an exact-match field must not be left corrupted by a dropped keystroke
 * or an autoformatting input.
 */
async function typeInto(page, candidates, text, what, { verify = false } = {}) {
  const el = await firstPresent(page, candidates, what);
  await humanType(page, el, text);
  if (!verify) return;
  const norm = (s) => (s || '').replace(/\s+/g, '').toUpperCase();
  const got = await el.inputValue().catch(() => '');
  if (norm(got) !== norm(text)) {
    console.warn(`  Field "${what}" read back as "${got}"; clearing and retyping once.`);
    await el.fill('');
    await humanType(page, el, text);
    const got2 = await el.inputValue().catch(() => '');
    if (norm(got2) !== norm(text)) {
      throw new Error(`Field "${what}" would not accept the value correctly (got "${got2}").`);
    }
  }
}

/** Human-click the first present candidate; returns false if none exist. */
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

/** Human-type into the first present candidate; returns false if none (no throw). */
async function typeIfPresent(page, candidates, text) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await humanType(page, loc, text);
      return true;
    }
  }
  return false;
}

/**
 * The new-booking candidate page may ask about an extended test and special
 * requirements. Pick the plain options (no / none) if present; harmless if not.
 */
async function handleCandidateOptions(page) {
  await clickIfPresent(page, ['#extended-test-no', 'input[name*="extended" i][value="no" i]']);
  await clickIfPresent(page, ['#special-needs-none', 'input[name*="special" i][value="none" i]']);
}

/** Click the step's "continue"/submit, trying the known ids first. */
async function clickContinue(page) {
  return clickIfPresent(page, [
    '#driving-licence-submit',
    '#theory-test-submit',
    'button:has-text("Continue")',
    'button[type=submit]',
    '.govuk-button:not(.govuk-button--secondary)',
  ]);
}

/** Accept the GOV.UK cookie banner if present, as a person would. */
async function acceptCookies(page) {
  await clickIfPresent(page, [
    'button:has-text("Accept analytics cookies")',
    'button:has-text("Accept additional cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept cookies")',
    '#accept-cookies',
  ]);
}

/**
 * The booking service is fronted by a Queue-it virtual waiting room. When busy,
 * you are held on queue.driverpracticaltest… (or shown "please wait while we
 * process your request") and the page polls itself until it is your turn. We do
 * nothing but keep the single tab open and wait for its automatic redirect - no
 * reloads, no parallel tabs, no token fiddling - up to a hard cap.
 */
async function waitThroughQueue(page) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const url = page.url();
    const body = (await page.textContent('body').catch(() => '')) || '';
    const queued =
      url.includes('queue.driverpracticaltest') ||
      url.includes('queue-it.net') ||
      /waiting room|please wait while we process/i.test(body.slice(0, 2000));
    if (!queued) return;
    console.log('In the DVSA queue, waiting 30s for the automatic redirect...');
    await page.waitForTimeout(30_000);
  }
  throw new Error('Still stuck in the DVSA queue after 10 minutes; giving up this run.');
}

function assertNotBlocked(html) {
  if (
    /_Incapsula_Resource|incapsula|imperva|request unsuccessful|access denied|pardon our interruption/i.test(
      html
    )
  ) {
    throw new Error(
      'DVSA served an anti-bot challenge page instead of the service. ' +
        'This is most likely the datacentre IP; see the README "Where to run it". ' +
        'It will retry on the next scheduled run.'
    );
  }
}

/**
 * If a CAPTCHA appears, a human is needed - alert and stop cleanly rather than
 * hammering (auto-solving would be exactly the abusive behaviour to avoid).
 * Returns true if it bailed.
 */
async function bailIfCaptcha(page) {
  const captcha = page.locator(
    '#recaptcha_widget_div, iframe[src*="recaptcha"], iframe[title*="captcha" i], .g-recaptcha'
  );
  if (!(await captcha.count().catch(() => 0))) return false;
  await snapshot(page, 'captcha');
  await sendAlert({
    title: 'DVSA checker needs a hand',
    message:
      'The DVSA site showed a CAPTCHA, so the automated check stopped. ' +
      'Open https://driverpracticaltest.dvsa.gov.uk/ yourself to continue.',
  }).catch(() => {});
  console.log('CAPTCHA encountered; alerted and stopping this run.');
  return true;
}

async function launchBrowser() {
  const base = {
    headless: process.env.HEADLESS !== 'false',
    args: LAUNCH_ARGS,
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    ...CONTEXT_OPTIONS,
  };
  let context;
  try {
    // Real Chrome: authentic TLS + HTTP/2 + Client Hints, unlike bundled
    // Chromium. No userAgent override on either path - an honest UA that matches
    // the real build beats a spoofed one that can contradict the TLS fingerprint.
    context = await chromium.launchPersistentContext(USER_DATA_DIR, { ...base, channel: 'chrome' });
  } catch (err) {
    console.warn(`Real Chrome unavailable (${err.message.split('\n')[0]}); using Chromium.`);
    context = await chromium.launchPersistentContext(USER_DATA_DIR, base);
  }
  await applyStealth(context, { spoofWebgl: process.env.DVSA_WEBGL_SPOOF === 'on' });
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
    if (await bailIfCaptcha(page)) return;
    await snapshot(page, 'landing');
    await idleMouse(page); // settle before touching anything
    await acceptCookies(page);
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
      await sleep(page, 800, 1800);
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
    // Verified id from open-source DVSA checkers: #driving-licence-number
    // (older: #driving-licence). Value is read back after typing.
    await typeInto(
      page,
      ['#driving-licence-number', '#driving-licence', 'input[name="driving-licence-number" i]', '#dln'],
      licence,
      'driving licence field',
      { verify: true }
    );
    await handleCandidateOptions(page); // extended-test / special-needs, if on this page
    await sleep(page, 600, 1500);
    await clickContinue(page);
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());
    if (await bailIfCaptcha(page)) return;
    await snapshot(page, 'after-licence');
    await dwell(page);

    // 4. Theory test certificate number -----------------------------------
    // Exact id couldn't be confirmed from a public repo; the DVSA convention is
    // label-matches-id, so #theory-test-number / #certificate-number are the
    // likely candidates. Non-fatal: if the field isn't on this page (the flow
    // may order things differently), we log and carry on rather than abort.
    const typedTheory = theory
      ? await typeIfPresent(page, [
          '#theory-test-number',
          '#certificate-number',
          'input[name*="theory" i]',
          'input[name*="certificate" i]',
          '#theoryTestNumber',
        ], theory)
      : false;
    if (typedTheory) {
      await handleCandidateOptions(page);
      await sleep(page, 600, 1500);
      await clickContinue(page);
      await waitThroughQueue(page);
    } else {
      console.log('  Theory-number field not on this page; continuing (see snapshot).');
    }
    await snapshot(page, 'after-theory');
    await dwell(page);

    // 5. Instructor reference: leave the PRN blank (private candidate), continue.
    await clickIfPresent(page, [
      '#instructor-referral-no',
      'input[name*="instructor" i][value="no" i]',
    ]);
    await clickContinue(page);
    await waitThroughQueue(page);
    await snapshot(page, 'after-instructor');
    await dwell(page);

    // 6. Test centre search -----------------------------------------------
    await typeInto(
      page,
      ['#test-centres-input', 'input[name="test-centres" i]', 'input[name*="centre" i]', '#postcode'],
      centreQuery,
      'test centre search box'
    );
    await sleep(page, 600, 1500);
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

    // Results container/rows from tp223 + ciuffetelli checkers.
    const centreLinks = page.locator(
      '.test-centre-details-link, .test-centre-details a, .test-centre-results a, a.test-centre, ol li a'
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
    if (await bailIfCaptcha(page)) return;
    await snapshot(page, 'calendar');

    // 7. Read the availability calendar -----------------------------------
    // Grounded in tp223/DVSA-Driving-Test-Check: the calendar is
    // .BookingCalendar-datesBody; a day is bookable when its class does NOT
    // carry the "--unavailable"/"--unbookable" modifier; the ISO date lives in
    // data-date on the day cell or its .BookingCalendar-dateLink.
    const emptyState = await page
      .locator('text=/no tests found/i')
      .count()
      .catch(() => 0);
    await page.waitForSelector('.BookingCalendar-datesBody, .BookingCalendar', { timeout: 60_000 });
    const dates = await page.$$eval('.BookingCalendar-datesBody td, .BookingCalendar td', (cells) =>
      cells
        .filter((td) => {
          const cls = td.className || '';
          if (/--unavailable|--unbookable|--nonWorkingDay/.test(cls)) return false;
          return !!(
            td.getAttribute('data-date') || td.querySelector('[data-date]')
          );
        })
        .map(
          (td) =>
            td.getAttribute('data-date') ||
            td.querySelector('.BookingCalendar-dateLink, a, [data-date]')?.getAttribute('data-date') ||
            null
        )
        .filter(Boolean)
    );

    const unique = [...new Set(dates)].sort();
    console.log(
      unique.length
        ? `  Bookable dates on the calendar: ${unique.join(', ')}`
        : `  No bookable dates shown${emptyState ? ' ("no tests found")' : ''}.`
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
    await sleep(page, 1000, 2500);
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
