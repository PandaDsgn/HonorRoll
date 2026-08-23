// Sends transactional email via the Gmail API (send-as-yourself), using an
// OAuth2 refresh token obtained once via the OAuth Playground — not raw
// SMTP, since Render blocks outbound SMTP ports 25/465/587 for free web
// services. Gmail's send endpoint is plain HTTPS, so it isn't affected.
//
// Chosen over a Resend-verified custom domain: no domain to own/renew/keep
// alive — mail genuinely comes from the product owner's own Gmail address,
// authenticated once via OAuth2, refreshed automatically after that.
//
// No fallback for any of these four env vars, same "no sane default for a
// secret" posture as JWT_SECRET/RAZORPAY_*/B2_*: getGmailClient() returns
// null when unconfigured, and every caller here checks for that and fails
// gracefully rather than the app refusing to boot at all.
const { OAuth2Client } = require('google-auth-library');

let oauth2Client = null;
function getGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER_EMAIL } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_SENDER_EMAIL) return null;
  if (!oauth2Client) {
    oauth2Client = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  }
  return oauth2Client;
}

function isGmailConfigured() {
  return getGmailClient() !== null;
}

// Builds the raw RFC 2822 message Gmail's API expects, base64url-encoded.
// Plain text only when there's no attachment (every such caller sends plain
// text today). With one or more attachments, switches to
// multipart/mixed: a text/plain body part plus one application/octet-stream
// part per attachment, each base64-encoded — the standard shape for a
// file attached to an otherwise plain-text email.
function buildRawMessage({ from, to, subject, text, attachments = [] }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
  if (attachments.length === 0) {
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      text,
    ].join('\r\n');
    return Buffer.from(message, 'utf-8').toString('base64url');
  }

  const boundary = `honorroll_${Buffer.from(String(Date.now())).toString('hex')}`;
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    '',
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      att.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      ''
    );
  }
  parts.push(`--${boundary}--`);
  return Buffer.from(parts.join('\r\n'), 'utf-8').toString('base64url');
}

// Shared send used by every transactional email in this app — welcome
// emails, org-signup verification, password reset, billing notifications.
// Returns { error } (never throws) so every call site can keep its existing
// "best-effort, log and move on" pattern without a try/catch of its own.
async function sendEmail({ to, subject, text, fromName = 'HonorRoll', attachments = [] }) {
  const client = getGmailClient();
  if (!client) return { error: new Error('Gmail is not configured') };
  try {
    const { token: accessToken } = await client.getAccessToken();
    const raw = buildRawMessage({ from: `${fromName} <${process.env.GMAIL_SENDER_EMAIL}>`, to, subject, text, attachments });
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { error: new Error(`Gmail send failed (${res.status}): ${body}`) };
    }
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

module.exports = { isGmailConfigured, sendEmail };
