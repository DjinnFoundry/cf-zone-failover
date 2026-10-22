// Stand-in for the Workers-only `cloudflare:email` module.
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: string,
  ) {}
}
