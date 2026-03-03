# Structured Logging Policy (Phase 2)

## Required fields
- `timestamp` (ISO8601)
- `severity` (`info`, `warn`, `error`)
- `component`
- `correlationId`
- `message` or event payload

## Security controls
1. Logs are JSON-structured only.
2. Control characters are stripped to prevent log injection.
3. Sensitive keys (`token`, `secret`, `password`, `authorization`, `api_key`, `credential`) are masked.
4. Max payload size is 16KB per log line.
5. Correlation ID must match `^[a-f0-9-]{16,64}$`; invalid values are replaced with a null ID.

## PII classification
- High: authentication artifacts, secrets, access tokens, private keys.
- Medium: principal identifiers, job metadata tied to user identifiers.
- Low: operational status codes and non-sensitive runtime metrics.

High and medium sensitivity values must be masked or minimized before emission.

## Retention
- Runtime logs: 30-day hot retention.
- Audit evidence logs: retained with release artifacts.

## Prohibited behavior
- No plaintext secret logging.
- No multiline raw payload logging.
- No unbounded object dumps.
