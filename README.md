# DVSA driving test availability checker (alert only)

A headless-server script that checks the DVSA **change your driving test**
service a few times a day — at a random time around 6am and at random times
around the midday and evening peaks — logs in with your licence details, and
pings your phone if test dates are available in your preferred window.

**It never books, moves, or cancels anything.** It reads the availability
calendar and leaves. You book manually at
<https://driverpracticaltest.dvsa.gov.uk/login> when an alert comes in.

## Schedule

Three checks a day, each at a random time inside its window (GitHub's own
cron delay adds extra natural jitter on top):

| Window | Lands between (UK time) |
| --- | --- |
| Early morning | ~05:35 – 06:20 |
| Lunch peak | ~11:20 – 12:05 |
| Evening peak | ~17:20 – 18:05 |

That's deliberately light — three gentle visits a day spread out like a
person checking on their phone, not a hammering bot. UK daylight-saving is
handled automatically (both UTC offsets are scheduled; a guard step keeps
the right one).

## Looking like a real browser

The checker avoids the obvious bot tells without any fingerprint-spoofing
tricks:

- **Real Google Chrome**, not Playwright's bundled Chromium — the bundled
  build has a TLS fingerprint that matches no real Chrome release, which
  anti-bot systems can spot before a single page renders.
- **Headed, in a virtual display (xvfb)** on the runner — classic headless
  mode leaks signals like a software GPU renderer.
- **Persistent Chrome profile**, cached between runs — cookies survive, so
  the site sees a returning visitor rather than a fresh browser every time.
- **Human pacing** — fields are typed character by character and every step
  waits a random 1–4 seconds; one single pass per run, then it leaves.
- Realistic UK locale, timezone, and viewport.

Runs can still occasionally hit the Imperva block page or the DVSA queue;
the script waits out the queue, logs a block, and simply tries again at the
next window.

## Phone notifications

**Recommended: [ntfy.sh](https://ntfy.sh)** — free, no account, instant
push. Install the app
([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
[Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)),
subscribe to a hard-to-guess topic name (e.g. `dvsa-kp-8f3k2`), and put the
same name in the `NTFY_TOPIC` secret. Alerts are sent with high priority so
they buzz through. Anyone who knows the topic name can read it, so keep it
random.

Also supported: `ALERT_WEBHOOK_URL` — any endpoint that accepts a JSON POST.
A Discord webhook works out of the box (Discord's mobile app then does the
pushing); Slack, Zapier, or IFTTT relays work too. Configure either channel
or both.

## Setup

You need an **existing test booking** — the checker uses the DVSA
change-booking flow, which requires a licence number plus booking reference.

### 1. GitHub secrets

In the repo: **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Required | Value |
| --- | --- | --- |
| `DVSA_LICENCE_NUMBER` | yes | Your driving licence number |
| `DVSA_BOOKING_REF` | yes | Your booking/application reference |
| `NTFY_TOPIC` | one alert channel | A hard-to-guess ntfy topic |
| `NTFY_SERVER` | no | Only if self-hosting ntfy (defaults to `https://ntfy.sh`) |
| `ALERT_WEBHOOK_URL` | one alert channel | Any URL accepting a JSON POST |

### 2. Optional date window

Under **Secrets and variables → Actions → Variables** (not secrets):

| Variable | Meaning |
| --- | --- |
| `DVSA_EARLIEST_DATE` | Ignore slots before this date (`YYYY-MM-DD`) |
| `DVSA_LATEST_DATE` | Ignore slots after this date. Default: 6 months out |

Set `DVSA_LATEST_DATE` to the day before your current test to only be
alerted about **earlier** slots.

### 3. Test it

Run the workflow manually: **Actions → DVSA availability check →
Run workflow**. Manual runs skip the random delay. Each run uploads a
screenshot + HTML dump as a workflow artifact, which is the first place to
look if something breaks.

## Running locally

```bash
npm install
npx playwright install chrome    # real Chrome; falls back to chromium
set -a; source .env; set +a      # after copying .env.example to .env
HEADLESS=false npm run check
```

## Caveats

- DVSA occasionally changes their page markup; if runs start failing, the
  selectors in `src/check-tests.js` are the place to update (the uploaded
  HTML artifact shows what the page looked like).
- Keep the schedule light. Hammering the service is against DVSA's terms
  and will get the runner's IPs blocked — three spread-out checks a day is
  the point.
