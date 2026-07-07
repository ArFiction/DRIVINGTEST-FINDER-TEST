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

## ⚠️ Before you use this: DVSA's terms

Be aware: **DVSA's 2026 booking terms prohibit automated access to the
service** — and that wording covers automated *interaction*, not just automated
booking, so even this read-only checker is against the letter of their terms.
DVSA has suspended 1,000+ licence numbers for "unusual booking activity". For a
low-volume, own-data, read-only tool like this the realistic worst case isn't
legal trouble — it's **your licence number getting flagged and your booking
cancelled or blocked**, which hits the very test you're trying to bring forward.

This is defensible on intent (personal, low-impact, never books) but not on
compliance. Keeping it to ~3 quiet checks a day from your own connection, and
stopping if DVSA ever objects, is the sensible line. Your call — the
[detailed notes](docs/anti-bot-notes.md) lay out the full picture.

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

## Where to run it (this matters most)

DVSA is behind **Imperva/Incapsula**. Once the script drives real Chrome, the
biggest remaining signal a bot-detector has is your **IP address**:

- **GitHub Actions runs from Azure datacenter IPs**, which Imperva treats as
  near-zero-trust. A perfect real-Chrome browser arriving from a server range
  is itself a contradiction, so datacenter runs are the most likely to be
  challenged (independent estimates put datacenter pass rates around 10–35%).
- **A residential IP** (your home broadband) is treated as "likely human"
  (~85–95%). Your home IP making three requests a day is indistinguishable
  from you checking the site yourself.

So the single highest-impact choice is **where it runs**:

| Option | IP | Effort | Notes |
| --- | --- | --- | --- |
| GitHub Actions (default here) | datacenter | zero | Works, but most likely to be challenged. Fine to start with. |
| **Self-hosted GitHub runner at home** | residential | ~1 hr | Keep this exact workflow; jobs execute on your home IP. Best if you like the Actions setup. |
| Home machine / mini-PC on a cron | residential | ~1–2 hr | Run `npm run check` from a small always-on **x86** box (an old laptop, or a ~£120 Intel N100). |
| Raspberry Pi | residential | ~1–2 hr | Works, but ARM has **no official Google Chrome** — it falls back to Chromium, losing part of the browser-layer disguise. Prefer an x86 box. |

Avoid paid residential proxies for a personal checker — your own home IP is
cleaner and free. Start on GitHub Actions; if it gets challenged often, move to
a home/self-hosted run. The code is identical either way.

## Looking like a real browser

The checker removes the obvious automation tells and behaves like a person,
without fragile fingerprint spoofing. The full reasoning and sources are in
[`docs/anti-bot-notes.md`](docs/anti-bot-notes.md); in short:

- **Real Google Chrome** (not bundled Chromium), **headed under xvfb**, with a
  **persistent profile** cached between runs — genuine TLS/HTTP2 fingerprints
  and a returning-visitor session, which is most of the battle.
- **One honest identity, no self-contradictions** — `navigator.webdriver` is
  cleared by the launch flag (not a detectable JS getter); plugins, canvas and
  the `chrome` object are left as real Chrome reports them (faking them
  backfires); locale/timezone are UK. The WebGL GPU string is left honest by
  default (a Windows GPU string on a Linux browser is a worse tell than the
  truth).
- **Human input** — the pointer follows a curved, minimum-jerk path (with
  drift, tremor and overshoot, not a straight teleport), clicks are a real
  press-and-hold slightly off-centre, and text is typed key-by-key with
  log-normal timing and the odd hesitation. Licence/theory fields are read back
  and retyped if a keystroke didn't land.
- **Human pacing** — scroll-and-read dwells, random waits between steps, a
  fresh per-run "persona" so timing differs each run, exactly one pass per run,
  and no retry storms.

It deliberately does **not** try to defeat the anti-bot system — aggressive
evasion is what gets flagged. Runs can still occasionally hit the Imperva
challenge or the DVSA queue; the script waits out the queue, logs a challenge,
and tries again next window.

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
