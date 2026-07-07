# DVSA driving test availability checker (alert only)

A headless-server script that walks the DVSA **book your driving test**
journey a few times a day — at a random time around 6am and at random times
around the midday and evening peaks — and pings your phone if test dates are
available at your chosen test centre in your preferred window.

**It never books anything.** It goes as far as the availability calendar,
reads the dates, and stops — no slot is selected, and no personal or payment
details are ever entered. You book manually at
<https://driverpracticaltest.dvsa.gov.uk/> when an alert comes in.

> DVSA won't show you any dates until you've identified yourself, so the
> journey needs your **driving licence number** *and* your **theory test
> pass certificate number**, plus a **test centre** to search. Licence
> number alone isn't enough — that's a DVSA gate, not a limitation of this
> script.

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

### 0. Enable the schedule (one manual step)

GitHub blocked the automation that created this branch from writing Actions
workflow files, so the workflow lives at [`setup/daily-check.yml`](setup/daily-check.yml)
and needs moving once:

- On GitHub: open `setup/daily-check.yml` → pencil icon → change the
  filename to `.github/workflows/daily-check.yml` → commit. Or locally:
  `git mv setup/daily-check.yml .github/workflows/ && git commit -am "Enable workflow" && git push`

Nothing runs until this file sits in `.github/workflows/`.

### 1. GitHub secrets

Private details go in **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Required | Value |
| --- | --- | --- |
| `DVSA_LICENCE_NUMBER` | yes | Your driving licence number |
| `DVSA_THEORY_NUMBER` | yes | Your theory test pass certificate number |
| `NTFY_TOPIC` | one alert channel | A hard-to-guess ntfy topic |
| `NTFY_SERVER` | no | Only if self-hosting ntfy (defaults to `https://ntfy.sh`) |
| `ALERT_WEBHOOK_URL` | one alert channel | Any URL accepting a JSON POST |

### 2. Where and when to look

Non-secret settings go in the **Variables** tab (next to Secrets):

| Variable | Required | Meaning |
| --- | --- | --- |
| `DVSA_TEST_CENTRE` | yes | Postcode or town to search, e.g. `SW1A 1AA` |
| `DVSA_CENTRE_MATCH` | no | Pick the centre whose name contains this text (else the first result) |
| `DVSA_TEST_TYPE` | no | Test category, default `car` |
| `DVSA_EARLIEST_DATE` | no | Ignore slots before this date (`YYYY-MM-DD`) |
| `DVSA_LATEST_DATE` | no | Ignore slots after this date. Default: 6 months out |

### 3. Test it

Run the workflow manually: **Actions → DVSA availability check →
Run workflow**. Manual runs skip the random delay. Each run uploads a
**numbered screenshot + HTML dump of every step** (`01-landing`,
`02-after-test-type`, …) as a workflow artifact. On the very first run this
is important: the book-a-test journey has several pages, and if DVSA's field
IDs differ from the script's guesses, the step named `NOTFOUND-…` shows
exactly which page and field needs its selector corrected in
`src/check-tests.js`.

## Running locally

```bash
npm install
npx playwright install chrome    # real Chrome; falls back to chromium
set -a; source .env; set +a      # after copying .env.example to .env
HEADLESS=false npm run check
```

## Caveats

- **Selectors are best-effort.** The book-a-test journey's exact field IDs
  couldn't be verified against the live site while this was written (DVSA's
  anti-bot layer blocks automated access to confirm them), so the script
  tries several likely selectors per step and records each page. If a step
  fails, open that step's screenshot/HTML in the artifact and adjust the
  candidate list in `src/check-tests.js` — the code is structured to make
  that a one-line change.
- **Datacentre IPs get challenged.** DVSA uses Imperva/Incapsula. GitHub's
  shared runner IPs may sometimes be served a challenge page; the script
  detects this, logs it, and retries next window. If it's persistent, run
  the same script from a home machine or Raspberry Pi (a residential IP is
  trusted far more) — it's the identical `npm run check`.
- Keep the schedule light. Hammering the service is against DVSA's terms
  and will get IPs blocked — three spread-out checks a day is the point.
