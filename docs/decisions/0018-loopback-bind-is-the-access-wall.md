# ADR-0018: Loopback/tailnet bind is the access wall; request headers are not

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Security / Operations
- **Owners:** Finance Dashboard maintainers

## Context

ADR-0001 deferred application authentication in favour of a trusted network. In practice
"trusted LAN" meant the web port listened on every interface (`next start` defaults to all
interfaces), so anyone on the Wi-Fi could read transactions and manage bank credentials.
The chat route's "loopback only" check trusted `Host` / `X-Forwarded-For` / `X-Real-IP`,
all of which a client can set (`curl -H 'Host: localhost' http://<lan-ip>:3000/api/chat`
passed). Next.js 15 App Router route handlers do not expose the socket peer address;
Next fills `X-Forwarded-For` with `socket.remoteAddress` only when the client did not send
one, so even that is spoofable. (Trello #44, card 12.3.)

## Decision

- The network bind is the only access control and is private by default:
  `npm start` / `npm run dev` use `-H ${APP_BIND_IP:-127.0.0.1}`; docker-compose publishes
  `${APP_BIND_IP:-127.0.0.1}:3002:3000`. The in-container `HOSTNAME=0.0.0.0` stays — the
  publish is the boundary.
- Remote access (phone) is opt-in by setting `APP_BIND_IP` to the host's Tailscale IP.
  `0.0.0.0` and LAN addresses are not supported configurations.
- `isLoopbackRequest` (chat) is defense-in-depth and fails closed: loopback Host, exactly
  one loopback hop in `X-Forwarded-For`, no `X-Real-IP` / `Forwarded`, matching
  `X-Forwarded-Host`, and browser Fetch Metadata / `Origin` that say same-origin. It never
  accepts on Host alone.
- Non-goal: no invented shared secret or token. Real authentication remains card #15 /
  the #45 follow-up.

## Consequences

### Positive
- LAN clients cannot reach the app at all by default; spoofed Host headers are moot.
- Cross-site (CSRF) and DNS-rebinding requests to the chat are rejected by the header check.

### Negative / risks
- Phone/LAN access over `http://<lan-ip>:3000` stops working until `APP_BIND_IP` is set to a
  Tailscale IP. With a tailnet bind the app does not listen on `127.0.0.1`, so the chat
  (localhost-only) is unavailable in that mode.
- Any tailnet peer allowed by Tailscale ACLs has full access; a non-browser peer that can
  reach the listener can still forge `Host: localhost` + `X-Forwarded-For: 127.0.0.1` to
  pass the chat check.
- The chat is unusable through Docker port publishing (peer is the bridge gateway); it
  already required the host Kiro CLI.

## Alternatives considered

- **Read the socket peer in the route handler:** not exposed by Next 15 public APIs;
  relying on internals would break silently on upgrade.
- **Bind to the LAN with a shared token:** an invented secret; rejected per policy.

## References

- ADR-0001; README "Security"; `src/lib/services/chatSession.ts`; Trello #44, #45, #15.
