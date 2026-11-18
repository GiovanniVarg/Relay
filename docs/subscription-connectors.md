# Subscription connections

Relay offers OpenAI, Claude and Cursor connections. Each uses its supported native subscription integration, with separate account, billing and enabled-model checks. Google and Grok direct connections were removed at the user's request on 2026-10-22.

## Removed-provider compatibility

Google/Grok do not appear in account settings, bot/composer routes, group routes or automatic model choices. Their provider endpoints reject before sign-in or refresh. A one-time retired-connections-v1 migration moves affected saved bot preferences to Auto and clears their provider-specific model override. Names, roles, instructions, memory, folders, files, conversations, historical run attribution and saved provider billing/model records are retained.

Legacy provider IDs remain readable for historical records. Production factory compatibility entries are inert and cannot authenticate or dispatch. They do not import or start the retired native adapters. Stored provider profiles and private runtime files are not deleted as part of removing the connections. Grok-named models supplied through an eligible Cursor subscription are Cursor model choices and are not removed by this connection change.

## Setup and execution

Connect the desired account, refresh its available models, choose enabled models and confirm its actual billing arrangement. A model catalog is not proof of remaining allowance. Native OpenAI/Claude Agent tools require the configured working folder and their provider permissions; Cursor remains app-only on this Windows host. Ordinary bot discussions use text-only calls. No paid API fallback is enabled.

See [Agent behavior and permissions](../README.md#conversational-agents), [Cursor account and worker setup](cursor-workers.md) and [conversational app controls](../README.md#conversational-agents). Removed Google/Grok connectors are not current setup options.
