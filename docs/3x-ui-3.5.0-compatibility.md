# 3x-ui v3.5.0 compatibility

Hollowcon targets the upstream `MHSanaei/3x-ui` tag `v3.5.0`. Programmatic access uses a full-admin API token via `Authorization: Bearer <token>`. Cookie login is intentionally not used. Panel URLs must use HTTPS and preserve any configured base path.

Verified upstream v3.5.0 endpoints used by the initial adapter:

- `GET /panel/api/server/status`
- `GET /panel/api/inbounds/options`
- `GET /panel/api/inbounds/get/{id}`
- `GET /panel/api/clients/get/{email}`
- `POST /panel/api/clients/add`
- `POST /panel/api/clients/update/{email}`
- `POST /panel/api/clients/del/{email}`
- `POST /panel/api/clients/resetTraffic/{email}`
- `GET /panel/api/clients/traffic/{email}`
- `GET /panel/api/clients/links/{email}`
- `GET /panel/api/clients/subLinks/{subId}`

The standard response envelope is `{ success, msg, obj }`. Client updates replace the row rather than patching it, so Hollowcon must read the current client and send the complete desired record. API tokens are full-admin credentials and must be encrypted at rest, redacted from logs, and scoped operationally by using a dedicated token per panel.

## Release gate

The adapter is not considered production-verified until contract tests pass against an isolated real v3.5.0 panel for every enabled protocol and operation. Direct database writes are prohibited.
