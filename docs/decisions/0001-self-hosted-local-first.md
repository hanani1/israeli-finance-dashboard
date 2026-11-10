# ADR-0001: Self-hosted, local-first product boundary

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** Business / Architecture / Privacy
- **Owners:** Finance Dashboard maintainers

## Context

The dashboard replaces a hosted personal-finance product and stores bank credentials, account balances, and transaction history. Convenience must not silently expand the exposure of this data.

## Decision

Run the product on owner-controlled hardware. Keep PostgreSQL, bank credentials, transaction history, rules, and analytics local. Do not add application-level authentication in the initial version; instead, bind deployment to localhost or a trusted LAN/VPN and require an authenticating reverse proxy before any broader exposure.

## Consequences

### Positive
- The owner controls retention, backups, and access.
- A third-party application database does not hold complete household finances.
- Local processing remains available without a SaaS dependency.

### Negative / risks
- The owner operates backups, updates, uptime, and network controls.
- Port 3000 is highly sensitive because the app itself has no authentication.
- Features that call remote AI services must be explicitly disclosed as exceptions to local-only processing.

## Alternatives considered

- **Hosted SaaS:** rejected for the initial product because it increases credential/data custody and operational security scope.
- **Application authentication immediately:** deferred; trusted-network deployment is simpler but must not be mistaken for internet-safe access.

## References

- `docs/REQUIREMENTS.md` §§1, 3.7, 4
- `docs/DESIGN.md` §§1, 8
- `README.md` Security
