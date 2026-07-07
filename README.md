# DVSA driving test availability checker (alert only)

A headless script that runs once a day at a random time around 6am (UK time),
logs into the DVSA **change your driving test** service with your licence
details, and sends you an alert if test dates are available in your preferred
window.

**It never books, moves, or cancels anything.** It reads the availability
calendar and leaves. You book manually at
<https://driverpracticaltest.dvsa.gov.uk/login> when an alert comes in.

## How it works

1. A GitHub Actions cron fires at 05:35 UK time (both BST and GMT are
   handled), then sleeps a random 0–45 minutes so the check lands at a
   random time roughly between 5:35am and 6:20am. GitHub's own cron delay
   adds further natural jitter.
2. Playwright drives a headless Chromium through the DVSA login
   (licence number + booking reference), opens the date-change calendar for
   your existing test centre, and collects the bookable dates.
3. If any date falls inside your window, an alert goes out via
   [ntfy.sh](https://ntfy.sh) (free push notifications to your phone) and/or
   a JSON webhook (Discord webhooks work out of the box).

## Setup

You need an **existing test booking** — the checker uses the DVSA
change-booking flow, which requires a licence number plus booking reference.

### 1. GitHub secrets

In the repo: **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Required | Value |
| --- | --- | --- |
| `DVSA_LICENCE_NUMBER` | yes | Your driving licence number |
| `DVSA_BOOKING_REF` | yes | Your booking/application reference |
| `NTFY_TOPIC` | one alert channel | A hard-to-guess ntfy topic, e.g. `dvsa-kp-8f3k2` |
| `NTFY_SERVER` | no | Only if self-hosting ntfy (defaults to `https://ntfy.sh`) |
| `ALERT_WEBHOOK_URL` | one alert channel | Any URL accepting a JSON POST, e.g. a Discord webhook |

### 2. Optional date window

Under **Secrets and variables → Actions → Variables** (not secrets):

| Variable | Meaning |
| --- | --- |
| `DVSA_EARLIEST_DATE` | Ignore slots before this date (`YYYY-MM-DD`) |
| `DVSA_LATEST_DATE` | Ignore slots after this date. Default: 6 months out |

Set `DVSA_LATEST_DATE` to the day before your current test to only be
alerted about **earlier** slots.

### 3. Phone alerts with ntfy (recommended)

Install the ntfy app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
[Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)),
subscribe to the exact topic you put in `NTFY_TOPIC`, done. Anyone who knows
the topic name can see the alerts, so make it random.

### 4. Test it

Run the workflow manually: **Actions → Daily DVSA availability check →
Run workflow**. Manual runs skip the random delay. Each run uploads a
screenshot + HTML dump as a workflow artifact, which is the first place to
look if something breaks.

## Running locally

```bash
npm install
npx playwright install chromium
set -a; source .env; set +a   # after copying .env.example to .env
npm run check
```

Set `HEADLESS=false` to watch the browser.

## Caveats

- The DVSA site sits behind Imperva anti-bot protection and a queue system.
  The script waits out the queue, but some runs may still be served a block
  page — it logs this and simply tries again the next day. No attempt is
  made to evade the protection.
- DVSA occasionally changes their page markup; if runs start failing, the
  selectors in `src/check-tests.js` are the place to update (the uploaded
  HTML artifact shows what the page looked like).
- Keep this to one gentle check per day. Hammering the service is against
  DVSA's terms and will get the runner's IPs blocked.
