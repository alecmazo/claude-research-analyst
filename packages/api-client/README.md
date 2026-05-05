# `@dga/api-client` (placeholder)

Typed clients for each app's API. Today's mobile and web clients are
hand-written in `mobile/src/api/client.js` and `web/app.js` —
duplicated string-manipulating fetch wrappers.

This package will replace them with a thin code-generation step:
each app's FastAPI server emits an OpenAPI schema; we generate
typed JS clients into `@dga/api-client/{research,fund,brief}`. Mobile
and web import the same client.

See `../../MONOREPO.md` Phase 2/3.
