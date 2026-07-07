/**
 * DVSA driving test availability checker - ALERT ONLY.
 *
 * Logs into the DVSA "change your driving test" service with your licence
 * number + booking reference, opens the date-change calendar for your test
 * centre, records which dates are bookable, then leaves WITHOUT selecting
 * or confirming anything. If a date inside your preferred window is found,
 * an alert is sent (see src/notify.js). Your booking is never touched.
 *
 * Required env vars:
 *   DVSA_LICENCE_NUMBER   - your driving licence number
 *   DVSA_BOOKING_REF      - your test booking / application reference
 *
 * Optional env vars:
 *   DVSA_EARLIEST_DATE    - ignore slots before this date (YYYY-MM-DD)
 *   DVSA_LATEST_DATE      - ignore slots after this date (YYYY-MM-DD).
 *                           If unset, any date earlier than today+6 months counts.
 *   HEADLESS              - set to "false" to watch the browser locally
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sendAlert } from './notify.js';

const LOGIN_URL = 'https://driverpracticaltest.dvsa.gov.uk/login';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'artifacts';

const licence = process.env.DVSA_LICENCE_NUMBER;
const bookingRef = process.env.DVSA_BOOKING_REF;

if (!licence || !bookingRef) {
  console.error('DVSA_LICENCE_NUMBER and DVSA_BOOKING_REF must be set.');
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

async function saveDebug(page, name) {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: `${ARTIFACT_DIR}/${name}.png`, fullPage: true });
    writeFileSync(`${ARTIFACT_DIR}/${name}.html`, await page.content());
  } catch (err) {
    console.error(`Could not save debug artifacts (${name}):`, err.message);
  }
}

/** The service sits behind a waiting-room queue at busy times; wait it out. */
async function waitThroughQueue(page) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const url = page.url();
    const body = (await page.textContent('body').catch(() => '')) || '';
    const queued =
      url.includes('queue.driverpracticaltest') || /queue|waiting room/i.test(body.slice(0, 2000));
    if (!queued) return;
    console.log('In the DVSA queue, waiting 30s...');
    await page.waitForTimeout(30_000);
  }
  throw new Error('Still stuck in the DVSA queue after 10 minutes.');
}

function assertNotBlocked(html) {
  if (/incapsula|imperva|request unsuccessful|access denied/i.test(html)) {
    throw new Error(
      'The DVSA site served an anti-bot block page instead of the service. ' +
        'Nothing to do but try again on the next scheduled run.'
    );
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });
  const context = await browser.newContext({
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  try {
    console.log(`Checking for slots between ${earliest} and ${latest}.`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());

    // --- Log in ---------------------------------------------------------
    await page.fill('#driving-licence-number', licence);
    await page.fill('#application-reference-number', bookingRef);
    await page.click('#booking-login');
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());

    const loginError = await page
      .textContent('.error-summary, .govuk-error-summary')
      .catch(() => null);
    if (loginError) {
      throw new Error(`DVSA rejected the login details: ${loginError.trim().slice(0, 300)}`);
    }

    // --- Open the "change test date" flow --------------------------------
    await page.click('#date-time-change');
    await waitThroughQueue(page);

    // Ask for the earliest available dates rather than a specific one.
    const earliestChoice = page.locator('#test-choice-earliest');
    if (await earliestChoice.count()) {
      await earliestChoice.check();
    }
    await page.click('#driving-licence-submit');
    await waitThroughQueue(page);
    assertNotBlocked(await page.content());

    // --- Read the availability calendar ----------------------------------
    // Bookable days carry the BookingCalendar-date--bookable class; each
    // contains a link whose data-date (or href fragment) is the ISO date.
    await page.waitForSelector('.BookingCalendar-datesBody, .BookingCalendar', {
      timeout: 60_000,
    });

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
        ? `Bookable dates on the calendar: ${unique.join(', ')}`
        : 'No bookable dates shown on the calendar.'
    );

    const matches = unique.filter((d) => d >= earliest && d <= latest);

    // Alert only: we deliberately stop here. No date is clicked, no slot is
    // reserved, and the existing booking is left exactly as it was.
    if (matches.length) {
      await saveDebug(page, 'availability-found');
      await sendAlert({
        title: 'DVSA: driving test slots available!',
        message:
          `Slots inside your window (${earliest} to ${latest}):\n` +
          matches.join('\n') +
          '\n\nBook manually at https://driverpracticaltest.dvsa.gov.uk/login',
        dates: matches,
      });
      console.log(`ALERT SENT for ${matches.length} date(s).`);
    } else {
      console.log('Nothing inside the preferred window; no alert sent.');
    }
  } catch (err) {
    await saveDebug(page, 'failure');
    throw err;
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
