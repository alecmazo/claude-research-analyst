# `@dga/auth` (placeholder)

Single sign-on for the suite. Today every API uses an HMAC-style
password (`PORTFOLIO_PASSWORD` env var) → token exchange (Research's
`/api/auth`).

Phase 1 of the suite split keeps this token model but extends it:

- One **issuer** service (or library) that mints JWTs scoped per app:
  `{ "sub": "alec", "apps": ["research","fund"], "exp": ... }`.
- Each app validates the JWT, checks scopes, and only allows access
  to its own resources.
- LP users (Fund Admin) get tokens with `apps: ["fund"]` only — they
  can't see Research, can't see other LPs.

This unblocks giving an LP read-only access to their own statements
without giving them the keys to the rest of the suite.

See `../../MONOREPO.md` Phase 1.
