/**
 * Alert delivery. All channels are optional and configured via env vars;
 * every configured channel is tried, and failures in one do not stop the others.
 *
 *   NTFY_TOPIC          - topic name on ntfy.sh (or your own server via NTFY_SERVER)
 *   NTFY_SERVER         - defaults to https://ntfy.sh
 *   ALERT_WEBHOOK_URL   - any URL that accepts a JSON POST ({ title, message, dates })
 *                         (works with Discord/Slack-style relays, Zapier, IFTTT, etc.)
 */

export async function sendAlert({ title, message, dates = [] }) {
  const channels = [];

  if (process.env.NTFY_TOPIC) {
    channels.push(sendNtfy({ title, message }));
  }
  if (process.env.ALERT_WEBHOOK_URL) {
    channels.push(sendWebhook({ title, message, dates }));
  }

  if (channels.length === 0) {
    console.warn(
      'No alert channel configured (set NTFY_TOPIC and/or ALERT_WEBHOOK_URL). ' +
        'Alert content follows:'
    );
    console.warn(`${title}\n${message}`);
    return;
  }

  const results = await Promise.allSettled(channels);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('Alert channel failed:', r.reason?.message ?? r.reason);
    }
  }
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error('Every configured alert channel failed');
  }
}

async function sendNtfy({ title, message }) {
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const res = await fetch(`${server}/${process.env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'high',
      Tags: 'car,calendar',
    },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  console.log('Alert sent via ntfy.');
}

async function sendWebhook({ title, message, dates }) {
  const res = await fetch(process.env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // "content" is included so plain Discord webhooks render it with no relay needed.
    body: JSON.stringify({ title, message, dates, content: `**${title}**\n${message}` }),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  console.log('Alert sent via webhook.');
}
