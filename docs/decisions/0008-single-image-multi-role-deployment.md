# ADR-0008: Build one image for web and worker roles

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** Deployment / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

The web API and scheduled worker share Prisma models, services, encryption, and ingestion code. Maintaining separate images would duplicate dependency and Chromium setup.

## Decision

Build one multi-stage image containing the standalone Next.js server, worker TypeScript/runtime dependencies, Prisma schema/migrations, and Chromium. Run it as separate `app` and `worker` services with different commands, alongside PostgreSQL.

## Consequences

### Positive
- One build artifact contains matching web and worker code.
- Docker Compose can start the complete deployment and apply migrations/seeds.
- Chromium setup is centralized.

### Negative / risks
- The runtime image is larger because the worker needs Chromium and development-time tooling such as `tsx`/Prisma CLI.
- Host-only integrations such as Kiro CLI are not automatically available inside the image.

## Alternatives considered

- **Separate web and worker images:** deferred until image size or release cadence justifies duplication.
- **Run cron inside the web process:** rejected because scheduling and web lifecycle should remain independent.

## References

- `Dockerfile`
- `docker-compose.yml`
- `docs/DESIGN.md` §8
