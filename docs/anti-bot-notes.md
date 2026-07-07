# Anti-bot / "look human" deep dive

Notes behind the humanisation in `src/human.js`, from current (2025–2026)
research. The guiding rule throughout: **randomise behaviour, keep identity
stable, and don't spoof what a real browser already reports honestly.** Every
monkey-patch is a liability — a clumsy one is more detectable than the thing it
hides.

The target here (DVSA) is fronted by **Imperva/Incapsula**, which scores trust
*continuously over a session* from many signals, not per-request.

---

## 0. The single most important finding: where you run it beats any code

Once you drive **real Google Chrome**, the network-layer fingerprints (TLS
JA3/JA4, HTTP/2 "Akamai", header order, Client Hints) are *genuine and cannot be
made to fail* — you **are** the browser. What's left as the dominant signal is
**egress IP reputation**:

| Egress | How Imperva treats it | Rough per-session pass rate* |
| --- | --- | --- |
| **GitHub Actions** (Azure datacenter) | near-zero trust, often blocked pre-origin | ~10–35% |
| Residential (home broadband, sticky) | implicit "likely human" trust | ~85–95% |
| Mobile (CGNAT) | highest trust | ~90–95% |

\* Vendor-blog estimates, directionally consistent across independent sources;
Imperva's exact weights aren't public.

GitHub-hosted runners egress from **Azure datacenter ranges**, so the checker
currently presents *perfect real-Chrome fingerprints from a known server block* —
an internal contradiction (real users don't browse from Azure). **The highest-
impact change available is to run the checker from a residential IP**, e.g. the
owner's home machine, a small always-on box, or a self-hosted GitHub runner at
home. See the README "Where to run it" section. Everything below is second-order
by comparison — but it's what makes the browser itself pass.

---

## 1. Behavioural realism (mouse / keystroke / scroll)

Imperva penalises sessions that generate **no** mouse events, or events in
non-human patterns, even when the fingerprint is clean. The two Playwright
defaults are the loudest tells:

- `locator.fill()` sets the value instantly with **zero key events** → a hard
  bot signature on a field a human types. We type key-by-key instead.
- `page.mouse.move(x,y,{steps})` **linearly interpolates** at constant velocity
  in a few ms → the textbook bot path (zero acceleration).

### What detectors model
- **Velocity/acceleration**: human reaches have a bell-shaped ("minimum-jerk")
  velocity — accelerate to a mid-path peak, decelerate onto the target.
  Acceleration ≈ 0 everywhere ⇒ flagged.
- **The Bézier pitfall**: a plain uniform-parameter Bézier curve is itself a
  *known, discriminable class* (~98.7% detection accuracy) — uniform `t` gives
  near-constant speed and unnaturally low jerk. A Bézier is only safe once it's
  **re-timed by a minimum-jerk profile and roughened**.
- **Curvature / overshoot / tremor**: humans bow the path, overshoot distant
  targets then correct, and carry sub-pixel jitter + low-frequency drift.
- **Fitts's law**: movement time scales with distance ÷ target width; moves that
  are too fast for their distance are flagged.

### What `src/human.js` does
- `moveMouseTo`: one-sided Bézier bow, **re-timed with `minJerk()`**,
  autocorrelated drift + gaussian tremor, Fitts-law step counts, emitted as many
  small `mouse.move` calls (not the `{steps}` shortcut) with uneven inter-event
  timing and occasional mid-flight hesitation.
- `humanClick`: hover-dwell, **non-atomic** down→hold→up (`click({delay})`),
  landing slightly off-centre, overshoot-and-correct on long hops.
- `humanType`: **log-normal** inter-key flight (median ~140–210 ms, per-run),
  boundary/repeat pauses, ~2% thinking pauses, digit-group pauses. Types
  **cleanly** — no simulated typos, which would risk corrupting the exact-match
  licence/theory fields (the caller verifies the field value instead).
- `humanScroll`: eased bursts (min-jerk within a burst), ±jitter, occasional
  back-scroll / re-read, reading pauses.

### Higher-order tells (cheap, high value)
- **Don't replay one timing sequence every run** → a per-run *persona* shifts the
  distributions (typing pace, move speed, reading pace, bow direction).
- **Don't fire on the clock** → the workflow jitters each run 0–45 min.
- **Don't chain actions at machine speed / with zero idle** → page `dwell()`.
- **Enter via the normal path**, not a deep link → we start at the landing page
  and click through.

### Skipped as over-engineering (for a 3×/day checker)
Per-finger biomechanics, full digraph tables, diffusion-model trajectories,
simulated typos (net-negative on exact-match fields), chasing an exact
mouse-event count.

---

## 2. Fingerprint hardening — commit to ONE honest identity

**Real headed Chrome + a persistent profile already fixes most JS tells**
(plugins, `window.chrome`, `navigator.languages`, UA-CH population, codecs,
canvas/audio realism, permission consistency). The residual tells for this stack
are few, and the biggest risk is **contradictions you introduce yourself**.

- **`navigator.webdriver`** — fix with the launch **flag**
  (`--disable-blink-features=AutomationControlled` + dropping
  `--enable-automation`), *not* a JS getter (an instance getter leaves a
  detectable descriptor mismatch). If a Playwright build still forces it true,
  the answer is Patchright/rebrowser-playwright, not a hand patch.
- **Don't** fake `chrome.runtime` (a 2019-era tell that now backfires — real
  Chrome leaves it `undefined` on normal pages), **don't** spoof `plugins`,
  **don't** randomise canvas/audio (stability is *good*).
- **WebGL / SwiftShader**: a GPU-less runner reports a software renderer. On the
  **Linux real-Chrome path this is honest and internally consistent** and matches
  millions of real VM/RDP users — so we **leave it honest by default**. Forcing a
  Windows "Direct3D11" GPU string onto a Linux browser (Linux fonts, software
  WebGPU) is a *contradiction that scores worse*. The optional
  `DVSA_WEBGL_SPOOF=on` override exists only for someone who has committed to a
  *fully* consistent Windows profile (UA + UA-CH + fonts + WebGPU); when enabled
  it also masks `getParameter.toString()` so the patch reads as native code.
- **Consistency / stability**: locale `en-GB` + timezone `Europe/London` must
  match the egress region; the fingerprint must **not mutate run to run**
  (the persistent profile keeps it constant, which is what a returning human
  looks like). Don't hand-inject headers/UA — let Chrome emit them.
- **WebRTC**: modern Chrome already masks the local IP behind mDNS; we add
  `--force-webrtc-ip-handling-policy=default_public_interface_only` as hygiene.
  (Only matters as a leak if you route through a proxy.)

**Two strategies** (we use A): **A = honest Linux Chrome, minimal patching**
(lowest variance for a solo maintainer). **B = full Windows spoof** — only worth
it if *every* surface (UA, UA-CH, WebGL, WebGPU, fonts, `availHeight`) agrees;
one slip is worse than A.

---

## 3. Network / transport — already handled by real Chrome

- **TLS JA3/JA4 & HTTP/2 fingerprints** fire *before any JavaScript* and cannot
  be touched from page JS. Node HTTP clients (undici/axios) **cannot** match
  Chrome (OpenSSL vs BoringSSL; extension/curve order isn't configurable), and
  Playwright's **bundled Chromium** has a JA3 that matches no real Chrome. Driving
  `channel:'chrome'` is the fix — you stop spoofing and simply are Chrome.
- **Header order / Accept-Language / Sec-CH** are emitted natively and correctly
  by real Chrome; the only way to break this is to hand-inject headers, so we
  don't.
- **Cadence / cookies**: Imperva flags perfectly even intervals and retry storms;
  its clearance cookies (`incap_ses`, `visid_incap`, `reese84`) must persist
  unmodified and are bound to IP+TLS. So: jittered schedule, capped backoff (no
  hammering), and a **persistent profile** to keep clearance valid across runs.
  3 spread-out checks/day is orders of magnitude below any velocity threshold.

---

## 4. Imperva/Incapsula + DVSA specifics

**Why a plain `curl` gets a 403.** Imperva evaluates in layers: TLS+IP → cookie
challenge → the `reese84` JavaScript challenge (which fingerprints canvas, WebGL
`RENDERER` — `SwiftShader` on headless is a giveaway — AudioContext, fonts) →
extended JS validation → behaviour. `curl` can't run the JS, so it never mints
the tokens and is served the `_Incapsula_Resource` interstitial. A real browser
runs the challenge, gets its cookies, and reloads the real page.

**Cookies:** `visid_incap_*` (long-lived visitor id — the reason a persistent
profile warm-starts you as a returning visitor), `incap_ses_*` (short-lived
session; rotates; must stay consistent), `reese84`/`___utmvc` (the challenge
token). Let Chrome own them all; never hand-inject or replay them through curl.
The token isn't publicly documented as hard-bound to IP+TLS, but the model
expects the **same IP and TLS for a session's lifetime** — which is exactly why a
**VPN/datacenter proxy is the fastest way to turn a passing browser into a 403**,
and a stable home IP + real Chrome is the low-risk profile.

**The queue is Queue-it**, not Incapsula: DVSA sends you to
`queue.driverpracticaltest…` / `assets.queue-it.net` with a 302, the room polls
itself, and redirects you back with a signed token when it's your turn. Correct
behaviour: keep the single tab open and wait for the automatic redirect; never
reload, open parallel tabs, or fake the token. New slots drop **Mondays 06:00**
(deepest queue — avoid unless you truly want that drop). Service hours 06:00–23:40.

**Selectors (from open-source checkers; verify against the live DOM):**
- Licence: `#driving-licence-number` (older `#driving-licence`); continue
  `#driving-licence-submit`. Candidate options `#extended-test-no`,
  `#special-needs-none`; instructor PRN `#instructor-prn` (leave blank).
- Theory/certificate number field id **not confirmed** in any public repo — the
  checkers log in via licence + application reference instead. Likely
  `#theory-test-number` or `#certificate-number` by DVSA's naming convention;
  the code treats it as optional and snapshots the page so it can be pinned.
- Test centre: `#test-centres-input` + `#test-centres-submit`; results
  `.test-centre-results` / `.test-centre-details`.
- Calendar: `.BookingCalendar-datesBody`; a `td` is bookable when its class does
  **not** contain `--unavailable`; ISO date in `data-date` on the cell /
  `.BookingCalendar-dateLink`. Empty state: "No tests found on any date".
- **Never** click the booking/confirm controls (`#confirm-changes`,
  `#slot-warning-continue`, slot buttons) — the checker stops at the calendar.
- reCAPTCHA (`#recaptcha_widget_div`) → alert the human and stop, never auto-solve.

Source repos: `tp223/DVSA-Driving-Test-Check`, `2e0byo/YADC`,
`ciuffetelli/driver-practical-test-dvsa`, `saul/dvsa-auto-booker`. A consistent
theme across all of them: **DVSA's anti-bot changes eventually break every one**,
so expect to maintain the selectors or stop.

## 5. Ethics & DVSA terms — read this

Be straight about it: **DVSA tightened its booking terms in 2026 to prohibit
third-party apps, bots and automated services**, and the wording targets
automated *access/interaction*, not just automated payment. So an alert-only,
read-only checker is **still against the letter of the terms**, even though it
never books. DVSA has already **suspended 1,178+ licence numbers** over "unusual
booking activity", and their enforcement ladder runs from warnings up to
suspending licence numbers and cancelling bookings (criminal referral is reserved
for actual attacks/unauthorised access).

What separates this from the abusive bots DVSA is fighting: own licence and data,
read-only (never books/pays/changes/cancels), low volume (~3×/day), human
cadence, and no queue/challenge circumvention. The **realistic worst case for an
individual is your licence number being flagged and your booking cancelled or
blocked** — a modest but real cost that lands on the very test you care about.
This is defensible on *intent and impact*, not on *compliance*. Keep it personal,
low-impact and read-only, and be prepared to stop if DVSA objects.

## Priority order (most impact first)

1. **Run from a residential IP** (home box / self-hosted runner / N100 mini-PC).
   Dominant signal. — *infrastructure choice, see README*
2. **Keep `channel:'chrome'`** (real Chrome, x86 — note ARM/Raspberry Pi has no
   official Chrome). — *done*
3. **Persistent profile, never mutated** (cookie continuity + stable
   fingerprint). — *done*
4. **`navigator.webdriver` via flag**, honest identity, no self-contradictions.
   — *done*
5. **Human behaviour**: min-jerk mouse, key-by-key typing, scroll, dwell,
   jittered cadence, per-run persona. — *done*

---

## Sources

Behavioural: Castle (automated-mouse detection), arXiv 2410.18233 (Bézier
detectability, jerk/entropy features), Ghost Cursor, Pydoll evasion docs, CHI
2018 "136M keystrokes", keystroke-dynamics survey (PMC3835878), GeeLark scroll
simulation, Playwright Mouse API.

Fingerprint: Castle (WebGL renderer; detecting Playwright-instrumented Chrome;
Puppeteer-stealth→Nodriver), deviceandbrowserinfo (real ANGLE strings),
Wilico / send.win (UA vs UA-CH consistency), antoinevastel / infosimples
(headless tests), botbrowser (Mesa llvmpipe vs SwiftShader), Playwright browsers
docs, Chrome Enterprise WebRTC policy.

Network: HTTP Toolkit (Node TLS limits), Scrapfly (Imperva bypass; HTTP/2-HTTP/3
fingerprinting), ProxyHat (Imperva detection layers, pass-rate table), Akamai
BlackHat EU 2017 (HTTP/2 fingerprint), Browserless / AlterLab (bundled Chromium
JA3), send.win / DataImpulse (residential vs datacenter), GitHub Community #26442
(runner IPs = Azure), krowdev (JA4/HTTP2 2026).

Imperva/DVSA: Scrapfly / ScrapeBadger / ZenRows (Incapsula reese84/incap_ses/
visid mechanics), Queue-it developer docs (virtual queue 302 + signed token),
open-source DVSA checkers (tp223/DVSA-Driving-Test-Check, 2e0byo/YADC,
ciuffetelli/driver-practical-test-dvsa, saul/dvsa-auto-booker) for selectors,
GOV.UK Despatch blog + What Car?/Carwow (2026 rule changes, bot ban, 1,178+
licence suspensions).
