/** A fetch that answers with one canned response and remembers what it was asked. */
export class PostgrestStub {
  lastUrl = '';
  lastHeaders: Record<string, string> = {};
  lastBody: unknown = undefined;

  constructor(
    private readonly answer: unknown,
    private readonly status = 200,
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    this.lastUrl = String(input);
    this.lastHeaders = { ...(init?.headers as Record<string, string> | undefined) };
    this.lastBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    return new Response(JSON.stringify(this.answer), {
      status: this.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
