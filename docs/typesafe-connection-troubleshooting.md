# TypeSafe connection troubleshooting

Relay 0.5.1 replaced the generic connection failure with a closed diagnostic code and locally defined message. Relay 0.5.2 corrects overly strict model catalog parsing. This fixes misleading error reporting; a fixture success does not prove that a particular real account/key connects. Re-enter a real key only in Relay's masked field, never a chat message or diagnostic artifact.

## Connection stages

The integration calls GET https://api.typesafe.ai/v1/models with Authorization: Bearer followed by the raw API key. This matches the current [official catalog contract](https://docs.typesafe.ai/api/list-models). The TypeSafe skill is development guidance; installing it does not authenticate Relay or configure a key. See the [official skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md).

Paste the API key itself, without Authorization:, Bearer, surrounding quotes or internal whitespace. Relay deliberately does not retry a credential submission automatically. A failed attempt consumes its nonce and a subsequent manual attempt gets a fresh one.

## Safe diagnostics

- auth_rejected: TypeSafe returned 401 or 403. Check the key's account validity/access; do not assume a local encryption failure.
- invalid_key_format: the field contained header syntax, quotes or whitespace rather than a raw key.
- request_expired: the session, nonce or live task expired. Start a fresh secure connection request.
- rate_limited or service_unavailable: wait for the provider to recover before a manual retry.
- network_error or cancelled_or_timeout: secure transport failed, or the request was cancelled/timed out. TLS verification stays enabled.
- invalid_catalog: the response could not satisfy Relay's operational catalog contract. A closed catalogIssue identifies the failed guard without exposing provider data.
- storage_failed: encrypted storage could not commit safely. The connection remains disabled.
- configuration_busy or unknown: inspect TypeSafe status through the bot; the response still contains only fixed safe text.

The HTTP connect failure envelope is {error,code}. TypeSafe status exposes error and errorCode in process memory for a failed attempt; success clears them. Codes come from a closed local map. Provider bodies, headers, raw exception messages and entered keys are never included. Unknown or hostile codes cannot become sensitive UI error text. Existing nonce, cancellation, encryption and no-replay controls remain in effect.

## Catalog compatibility in 0.5.2

TypeSafe model names are opaque identifiers, not names constrained to Relay's former custom character pattern. Relay preserves usable names exactly in JSON requests, with a 512-character limit and no control characters. Catalogs retain the 128-KiB response bound and a 1,000-entry collection bound. Exact duplicate identifiers collapse to the first entry.

Descriptions and release dates are display metadata. Relay redacts credentials before clipping descriptions to 2,000 characters and dates to 30 characters; missing or non-string display metadata is empty or omitted. Ignored provider extensions do not go through the unrelated decision-input depth/array limits. Operational identity, fixed endpoint, TLS, size and cancellation checks still apply. These compatibility rules fix false rejections; they do not establish which field was present in the user's original rejected response.

Hard failures expose only an allowlisted catalogIssue and fixed local explanation, such as empty list, unexpected wrapper, invalid JSON, over-limit response, unusable model identity or a credential echo. No response body, field value or provider-generated error becomes diagnostic output.
