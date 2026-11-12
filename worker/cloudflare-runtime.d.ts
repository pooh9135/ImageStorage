interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare abstract class D1Database {}

declare module "cloudflare:workers" {
  const env: {
    readonly DB?: D1Database;
  };

  export { env };
}
