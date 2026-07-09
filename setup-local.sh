#!/usr/bin/env bash
# One-command local setup for macOS / Linux.
# Run from inside the repo folder:   bash setup-local.sh
set -e
cd "$(dirname "$0")"

echo "==> Checking Node..."
if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Get it from https://nodejs.org (v20+), then re-run this."
  exit 1
fi
echo "    Node $(node -v) found."

echo "==> Installing dependencies (npm install)..."
npm install

echo "==> Installing Google Chrome for Playwright..."
npx playwright install chrome

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from the template."
  echo
  echo "NEXT: open the .env file and fill in your details:"
  echo "  DVSA_LICENCE_NUMBER, DVSA_THEORY_NUMBER, DVSA_TEST_CENTRE, NTFY_TOPIC"
  echo
  echo "Then test it with:   npm run local:now"
else
  echo "==> .env already exists; leaving it as-is."
  echo "Test the checker with:   npm run local:now"
fi
