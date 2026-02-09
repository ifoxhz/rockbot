const RESEND_API_URL = 'https://api.resend.com/emails';

export function buildMatchedEmail({ date, matched }) {
  const lines = [];
  lines.push(`Rock analysis date: ${date}`);
  lines.push(`Matched count: ${matched.length}`);
  lines.push('');
  lines.push('Matched codes:');
  if (matched.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of matched) {
      lines.push(`  - ${item.code}`);
    }
  }
  lines.push('');
  lines.push('Matched details (JSON):');
  lines.push(JSON.stringify(matched, null, 2));
  return lines.join('\n');
}

export async function sendMatchedEmail({ to, from, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is required');
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text
    })
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Resend error: ${res.status} ${msg}`);
  }
}
