/** Plain-text RFC 5322 message, as the send_email binding wants it. */
export function buildRawEmail(opts: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  date: Date;
  id: string;
}): string {
  return [
    `From: ${encodedWord(opts.fromName)} <${opts.from}>`,
    `To: <${opts.to}>`,
    `Subject: ${encodedWord(opts.subject)}`,
    `Date: ${opts.date.toUTCString()}`,
    `Message-ID: <${opts.id}@${opts.from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Utf8(opts.body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}

const encodedWord = (text: string) => `=?UTF-8?B?${base64Utf8(text)}?=`;

function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
