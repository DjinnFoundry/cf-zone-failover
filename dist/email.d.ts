/** Plain-text RFC 5322 message, as the send_email binding wants it. */
export declare function buildRawEmail(opts: {
    from: string;
    fromName: string;
    to: string;
    subject: string;
    body: string;
    date: Date;
    id: string;
}): string;
