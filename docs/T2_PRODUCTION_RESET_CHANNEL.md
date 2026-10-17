# T2.1 temporary production Reset channel

Status: local implementation only. No Sites Version, production Secret, or
production invocation is created by this work. No migration is added.

## Entry and removal

`POST /api/admin/operations/production-reset` delegates to the existing
`resetAllBusinessData` core. GET returns a fixed JSON 405 without inspecting any state. There is no visible button,
GET configuration endpoint, SQL interface, or automatically executed action.
Disabled POST returns 503/RESET_DISABLED. All responses are private/no-store.

Removal consists of deleting the route and `lib/production-reset-channel.ts`,
removing their dedicated tests/configuration, and retaining the lifecycle core.
The new in-transaction core authorization guard is reusable and should remain.

## Configuration inventory (names only; do not place real values in this file)

| Server setting | Required meaning |
| --- | --- |
| APP_ENV | Must explicitly identify production |
| MAINTENANCE_MODE | Must be enabled |
| PRODUCTION_RESET_ENABLED | Dedicated opt-in; absent/false disables this route |
| PRODUCTION_RESET_SECRET | Secret: 32–64 securely random bytes, encoded as 64–128 lowercase hex characters |
| PRODUCTION_RESET_ALLOWED_PROJECT_ID | Exact project ID already in .openai/hosting.json |
| PRODUCTION_RESET_DATABASE_BINDING | The existing DB binding only |
| PRODUCTION_RESET_APPROVED_BACKUP_SHA256 | The approved, locally restore-verified archive SHA-256 |
| PRODUCTION_RESET_APPROVED_SITES_VERSION | Positive integer of the separately approved execution release |
| PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID | Its exact Sites deployment ID |

Only Sites server-side configuration supplies the real Secret. Do not put it in
Git, environment example files, browser storage, logs, documentation, or a URL.
The code validates its encoded length/format; no software can prove a manually
configured value was generated randomly. The operator must use a secure random
generator. No real Secret is generated or configured in T2.1.

The request sends the Secret only in `X-Production-Reset-Secret`. Existing
`ling_session` authentication is still mandatory. The JSON body accepts exactly
`projectId`, `databaseBinding`, `schema`, `sitesVersion`, `deploymentId`,
`backupSha256`, and `confirmation`. No arbitrary user ID, table name, origin,
Secret, or operator role may be supplied in the body. Maximum body size: 2048
bytes, checked while reading the stream.

The exact confirmation is `RESET_ALL_BUSINESS_DATA:<project_id>`; schema is
exactly `0010`. The backup SHA is compared against the configured approved SHA,
not presented as a server-side reread of an operator's local archive. Rehash the
actual archive locally immediately before any separately approved execution.

## Target and deployment evidence

Project configuration must equal the checked-in Sites project; both source and
runtime configuration must name `DB`. The route uses only the DB object injected
into that Worker. A caller cannot select another database. The physical D1 UUID
is not exposed to this code; verify the Sites project's binding externally before
execution instead of claiming the UUID has been read from the Worker.

Request Version/Deployment must match the server's approved values. This is
configuration matching, **not evidence of the running release**. Sites currently
provides no documented trusted Version/Deployment binding to this application.
The production route therefore reports
`X-Reset-Deployment-Verification: UNAVAILABLE` and logs that status. It never
trusts request headers or server-entered approval values as platform metadata.
If a real platform adapter becomes available, the handler requires its values to
match before reporting VERIFIED; local tests cover both match and mismatch.

The old Version 41/Deployment is the development baseline. A future deployment of
this channel necessarily has a new release identity. T2.2 must record that actual
saved Version/Deployment, separately approve it, pin it in server configuration,
and recheck it using Sites tools. Configuration changes can themselves require
redeployment, so record the final actual deployment after all configuration is
ready. Do not mistake configured approval values for live platform proof or
enter a redeploy loop to try to self-prove them. Do not claim Version 41 is still
the running release after deploying a new version. Keep maintenance enabled
throughout. If approval requires independent VERIFIED runtime metadata, this
adapter is not available and execution must stop.

## Authentication, CSRF and errors

Existing `requireSuperAdmin` requires a nonexpired Session belonging to an ACTIVE
SUPER_ADMIN. USER and family OWNER/ADMIN are rejected. Production, maintenance,
opt-in, Secret, target, schema and backup requirements are independent gates.

The request URL and Host must identify the exact existing HTTPS Sites origin.
Origin must match that same origin; cross-site fetch metadata, every query
string, foreign Host, and missing Origin are rejected. Forwarded host headers do
not establish trust. There is no permissive CORS response.

The existing schema inspector must find the exact 19-table 0010 profile with an
actual migration ledger and no unknown extra business tables. A preflight foreign
key error also prevents Reset. Known platform tables are read only for inspection
and never added to the DELETE allowlist.

Error responses contain only `ok:false` and a fixed error code, plus a generated
request ID header. They do not serialize raw exceptions, SQL, headers, data, or
credentials. Success returns only ok/reset/schema/tablesCleared. Structured logs
contain only event, outcome, request ID, operator user ID, safe error code,
schema/table count on success, and deployment verification status.

## Attempts, operation lock and atomicity

`action_idempotency` is reused; no table or index is added. The operation key is a
hash of the configured project/schema/Version/Deployment/approved-backup tuple.
It does not contain the Secret, Session token, or raw IP.

There are at most three authenticated attempts across all users, IPs and Sessions
for that approved operation, including wrong Secret/confirmation attempts. The
cap persists across Worker restarts and has no automatic expiry. The fourth
attempt returns 429/RESET_ATTEMPTS_EXCEEDED even with the correct Secret. There is
no public reset-counter API. An operator may only clear a lock or counter under a
separately approved recovery action after investigating the failure.

After all gates pass, a unique IN_PROGRESS record claims the operation. A failed
core invocation leaves it FAILED, rejects replay with 409/RESET_ALREADY_EXECUTED,
and never automatically retries DELETE. A lost response must be investigated
with read-only counts, not by blindly sending another Reset.

The existing fixed 19-table DELETE list remains the only deletion implementation.
Its single D1 batch now starts with a NOT NULL assertion that rechecks the live
ACTIVE SUPER_ADMIN and the claimed lock/nonce inside the transaction. Any failed
assertion or DELETE rolls back the complete batch. Attempt and claim writes also
check a live SUPER_ADMIN in SQL so an already-authenticated racing request cannot
recreate an operational row after a successful Reset. The guard and operation
records are removed by the existing DELETE list, leaving all 19 business tables
at zero.

### Honest permanence boundary

There cannot be a permanent database tombstone in a design that requires every
business table, including audit/idempotency, to be empty and forbids changing
platform tables or schema. Successful Reset therefore invalidates all old users
and Sessions; a repeat old request fails authentication (401). Concurrent calls
cannot pass the in-transaction authorization check or leave late state behind.

This is **not a permanent lock across later administrator re-creation or restoring
the old database**. Before registering or bootstrapping any new account, a
separately authorized operator must disable the opt-in, remove the Secret and
temporary route, redeploy the cleaned release, and verify the path is gone.
Those cleanup steps are mandatory; do not retain an enabled channel for future
administrators. No runtime code can revoke a Sites Secret or remove its own
deployment safely using the currently available bindings.

## Local validation

Run lint, typecheck, build, `test:reset-channel`, `test:security-s0`,
`test:maintenance`, `test:production-reset`, and `backup:test-fixture`.
The new route tests create new isolated local D1 fixtures, apply 0000–0010,
generate test-only credentials in memory/temp files, and remove Cloudflare
credentials from all subprocess environments. Wrangler calls use --local only.
The fixture Worker is scripts-only and must never enter the release bundle.

The test suite covers the auth/config/origin/size/error gates, attempt exhaustion,
SQL failure rollback, failed-operation replay, concurrent success, all 19 counts
being zero, unchanged schema/ledger, foreign keys, and absence of automatically
created users/OWNER/families or static genealogy fallback.

Result: 135 Reset-channel assertions PASS, including framework-build HTTP checks.
Local Wrangler can emit the specific transient message `worker restarted
mid-request`. Only harmless read-only or explicitly disabled unauthenticated
empty-parameter smoke requests retry that infrastructure response, at most three
times. Authenticated calls into the Reset core never retry.
