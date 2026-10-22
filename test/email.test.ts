import { describe, expect, it } from 'vitest';
import { buildRawEmail } from '../src/email.js';

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe('buildRawEmail', () => {
  it('encodes subject, sender name and body as UTF-8 with the headers send_email requires', () => {
    const raw = buildRawEmail({
      from: 'guard@example.com',
      fromName: 'Vigía',
      to: 'ops@example.com',
      subject: 'Vigía: reserva ACTIVADA',
      body: 'example.com sirve ahora desde la reserva. Ñandú '.repeat(5),
      date: new Date('2026-10-25T18:00:00Z'),
      id: 'abc',
    });
    const [head, body] = raw.split('\r\n\r\n');

    expect(head).toContain('Message-ID: <abc@example.com>');
    expect(head).toContain('To: <ops@example.com>');
    expect(head).toContain('Date: Sun, 25 Oct 2026 18:00:00 GMT');
    expect(decode(head!.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1]!)).toBe('Vigía: reserva ACTIVADA');
    expect(decode(head!.match(/From: =\?UTF-8\?B\?(.+)\?= </)![1]!)).toBe('Vigía');
    expect(body!.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(decode(body!.replace(/\r\n/g, ''))).toContain('Ñandú');
  });
});
