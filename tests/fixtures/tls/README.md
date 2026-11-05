Self-signed test-only TLS certificate for `pinned.upstream.test` (SAN), valid 100 years.
Used by tests/unit/security/url-guard.test.ts to prove that a pinned request (connect to the
checked IP) still sends the original SNI / Host and verifies the certificate against the original
host name (red team 2026-11-02 RA3). Never used outside tests.
