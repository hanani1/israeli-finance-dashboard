# ADR-0002: Encrypt credentials and prefer least-privilege bank access

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** Security / Business
- **Owners:** Finance Dashboard maintainers

## Context

Bank scraping requires reusable login credentials. Database or backup theft must not immediately expose those credentials, and a leaked login should have as little authority as the bank permits.

## Decision

Encrypt provider-specific credential JSON with AES-256-GCM before persistence, using a fresh 96-bit IV and authentication tag for every write. Resolve the key from an environment variable, credential file, or macOS Keychain; never return plaintext through an API. Decrypt only in the ingestion process. Recommend a separate information-only/view-only bank user where the provider actually supports one, and label provider support as verified or unverified rather than making universal claims.

## Consequences

### Positive
- Database and backup disclosure alone does not reveal credentials.
- Authenticated encryption detects ciphertext tampering.
- View-only access limits impact if both host key and ciphertext are compromised.

### Negative / risks
- Full host compromise can expose both key and decrypted credentials.
- Losing the encryption key makes stored credentials unrecoverable.
- Bank-specific least-privilege options may require a branch/phone request and can change.

## Alternatives considered

- **Plaintext database fields:** rejected.
- **Hashing credentials:** impossible because scraping requires recovering the original secret.
- **Universal “view-only user exists” claim:** rejected; availability must be verified per bank/account type.

## References

- `src/lib/security/crypto.ts`
- `src/lib/services/credentialService.ts`
- `docs/DESIGN.md` §§4, 7
