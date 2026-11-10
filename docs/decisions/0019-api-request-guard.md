# ADR-0019: API request guard (CSRF / Origin / Content-Type / Host) and security headers

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Security
- **Owners:** Finance Dashboard maintainers

## Context

The API has no authentication (README "Security"). A cross-origin `POST` with
`Content-Type: text/plain` or a form encoding is a CORS "simple" request: the browser
sends it without a preflight, so any page the user visits could fire `/api/sync` (live
bank logins), overwrite `/api/credentials`, rewrite `/api/rules`, or drive `/api/chat`.
Because the API is reached by host name, a DNS-rebinding page could also read it. There
was no `src/middleware.ts` (Trello card #45).

## Decision

`src/middleware.ts` runs on `/api/:path*` (Node runtime, so `APP_ORIGIN` is read at
server start) and delegates to the pure `evaluateApiRequest` in
`src/lib/services/requestGuard.ts`:

1. **Host allowlist, every method:** `localhost`, `127.0.0.1`, `[::1]` (any port) plus
   the `host[:port]` of each origin in `APP_ORIGIN` (comma-separated). Defeats DNS
   rebinding.
2. `GET` / `HEAD` / `OPTIONS` then pass.
3. **Provenance for mutations:** `Sec-Fetch-Site` is authoritative when present —
   `same-origin` / `none` allowed, `same-site` / `cross-site` rejected. Without it,
   `Origin` must be a loopback origin or listed in `APP_ORIGIN`. Neither header →
   rejected (so plain `curl` mutations need an `Origin` header).
4. **Content-Type:** a body must be `application/json` (parameters such as `charset`
   allowed). Bodyless requests (Sync Now `POST`, `DELETE`s) may omit Content-Type; a body
   with no Content-Type, `text/plain`, form-encoded, or multipart is rejected. Every
   client-side mutating `fetch` in `src/` was checked against this.
5. Rejections are `403` with a stable `{"error": "host_not_allowed" |
   "cross_site_request_rejected" | "unsupported_content_type"}` and a log line with the
   method and path only.

`next.config.mjs` sets `poweredByHeader: false` and, on every response,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. The CSP is
limited to `frame-ancestors` so it cannot break Next.js inline scripts or the PWA manifest.

**Non-goals:** this is browser CSRF / rebinding hardening, not authentication. Any client
that can reach the listener can still set these headers. The card's proposed shared
bearer token was not implemented: a self-minted shared secret is invented auth with no
owner to maintain it. The network boundary — loopback/tailnet bind (card #44) — remains
the wall, with an authenticating reverse proxy as the path to real auth.

## Consequences

### Positive
- Drive-by pages can no longer trigger scrapes, credential writes, or rule changes, and
  cannot read the API via DNS rebinding.
- The decision is unit tested (`requestGuard.test.ts`) independently of Next.js.

### Negative / risks
- Opening the UI under any host name other than localhost/127.0.0.1 (phone over Tailscale
  or LAN, a reverse proxy that rewrites `Host`) requires that origin in `APP_ORIGIN`;
  otherwise every `/api/*` call returns `403 host_not_allowed`.
- Scripts or tools that call mutating endpoints must send JSON and an allowed `Origin`.

## Alternatives considered

- **Synchronizer / double-submit CSRF tokens:** more moving parts (token issuance, client
  plumbing on every fetch) for no extra protection over Fetch Metadata + Origin + JSON-only
  in a same-origin app.
- **Shared bearer token from env (card step 3):** rejected — self-minted auth; see Non-goals.
- **Full CSP:** deferred; needs nonce plumbing through Next.js to avoid breaking the app.

## Follow-up

- Card #44: loopback/tailnet bind for every start path (including `npm start`, which binds
  all interfaces by default).
- Set `APP_ORIGIN` on any machine where the UI is opened from another host name.

## References

- Trello card #45 (12.4); card #44 (12.3).
- `src/middleware.ts`, `src/lib/services/requestGuard.ts`, `next.config.mjs`.
