# Refining the prompt

Original ask: *"A Grok-like platform for enterprise use with GitHub Copilot as the backend: the ability
to create bots, inter-bot messaging, skills, connectors, etc."*

Run through the "deeper, not bigger" template before rewriting it.

## 1. What a top professional would do that the ask leaves out

- **Run every turn as the calling employee, not as a service account.** In an enterprise, Copilot
  access, billing, policy (model allowlists, content exclusions) and data access are per seat. The
  backend should get each user's own GitHub token through the SDK's per-session `gitHubTokenProvider`.
  Connectors should forward that same identity (for example, the GitHub MCP server receives the user's
  token), so a bot can never see more than the person asking.
- **Make a bot a reviewed artifact.** A bot is configuration: persona/instructions, model, which
  skills, which connectors, which tools, who may use it, and which bots it may call. Keep it in
  version-controlled YAML ("bots as code") that is validated at load time, with an admin API that
  writes the same files, rather than settings in a database nobody reviews.
- **Least privilege by default.** Use the SDK's `"empty"` client mode, so the coding-agent defaults
  (shell, file writes, host access) are off and each bot opts in explicitly. A per-bot permission
  policy enforced in `onPermissionRequest` denies by default.
- **Bound inter-bot messaging.** Bot-to-bot calls need an explicit allowlist (`canMessage`), a hop
  limit, cycle detection, a per-request call budget, and provenance: the SDK's `source: "agent-<id>"`
  tells the receiving model that the message came from a bot rather than a human. All of it goes in
  the trace, or two bots will happily ping-pong until the quota is gone.
- **Audit everything:** who asked which bot what, which tools and connectors ran, which bots talked to
  which, and every permission denial, written to an append-only log that compliance can ship to a SIEM.
- **Keep the model runtime behind an interface** so the orchestration (ACLs, bus, budgets,
  conversations) is testable without a Copilot seat and the runtime can be swapped.
- **Keep secrets out of bot files.** Connector configs reference `${env:NAME}` or `${user.githubToken}`,
  resolved at session start and never logged.

## 2. The rawest material to start from

- **The SDK's shipped type definitions** (`@github/copilot-sdk/dist/types.d.ts`,
  `dist/generated/rpc.d.ts`) and README, not summaries of them: `SessionConfig.mcpServers`,
  `skillProvider` / `SkillProviderDescriptor`, `gitHubTokenProvider` (note: `expiresIn` must exceed
  one hour), `availableTools` / `ToolSet`, `onPermissionRequest` result kinds, `hooks`,
  `MessageOptions.source`, `resumeSession`, and `CopilotClientMode = "empty"`.
- **The MCP specification**, for connectors: stdio and streamable-HTTP transports, and how tool names
  are namespaced (`<server>-<tool>`).
- **The `SKILL.md` format** (YAML frontmatter `name` / `description`, markdown body, supporting files),
  which is shared by Copilot, Claude, and other agent runtimes, so skills stay portable.
- **GitHub's REST endpoints for identity and membership** (`GET /user`, `GET /user/orgs`) and the
  Copilot enterprise policy docs, for what an org admin can and cannot already enforce upstream.

## 3. Specific methods and tools

- TypeScript on Node 22, `@github/copilot-sdk` as the runtime, `zod` for config schemas and tool
  parameters, `yaml` for bot and connector files, and `node:http` for the API (no framework needed yet).
- **One `CopilotClient`** (mode `"empty"`), many sessions. Each conversation maps to a Copilot session
  (`sessionId` = conversation ID) that is resumed across turns. Each inter-bot call runs in a fresh,
  short-lived child session.
- Per-bot mapping: `systemMessage` (customize mode, keeping the safety section), `model`,
  `availableTools` (opted-in built-ins plus `mcp:*` plus `custom:*`), `mcpServers` (granted
  connectors only), and a `skillProvider` that serves only the bot's granted skills.
- Bus tools injected as custom tools: `list_bots` and `ask_bot(bot, message)`. Each turn has a trace
  context: `{ traceId, chain, budget }`.
- An append-only JSONL audit log; Server-Sent Events for streaming replies.
- `vitest` with a fake engine for ACL, bus, budget, and HTTP tests, and `tsc --noEmit` against the
  SDK's real types.

## 4. What, other than you or me, shows the result is right

- **`tsc` against the SDK's shipped `.d.ts`**: our session configs compile against the runtime's
  actual contract, not our memory of it.
- **The Copilot runtime itself**: `client.start()` plus `ping()` with the bundled runtime, then a real
  turn with a Copilot-licensed token. A user without a seat must be rejected by GitHub, not by us.
- **GitHub's API for identity**: authentication is decided by `GET /user` on the presented token.
- **The audit log, replayed:** a ping-pong attempt between two bots must show up as a refused hop with
  the chain recorded. A compliance reviewer can verify that from the log alone.
- **Tests run in CI with the fake engine**, so the guarantees (ACL, hop limit, cycle refusal, budget,
  deny-by-default permissions, secret redaction) don't depend on a model behaving.

---

## Rewritten prompt

> Build a self-hostable, enterprise bot platform on the GitHub Copilot SDK (`@github/copilot-sdk`),
> in TypeScript on Node 22.
>
> **Bots as code.** A workspace directory holds `bots/*.yaml`, `connectors/*.yaml`, and
> `skills/<name>/SKILL.md`. A bot defines: id, name, description, instructions, model, built-in tools
> it opts into, skills, connectors, access (GitHub users and orgs, or `*`), `canMessage` (bot IDs it
> may call), and a permission policy. Validate everything with zod at load time, including dangling
> skill or connector references, and fail fast. Provide an admin API that creates and updates bots by
> writing the same YAML, plus a `validate` CLI.
>
> **Runtime.** Use one `CopilotClient` in `mode: "empty"`. Every turn runs with the calling user's own
> GitHub token through `gitHubTokenProvider`. Map each bot onto `SessionConfig`: `systemMessage`
> (customize mode, keeping the safety section), `model`, `availableTools`, `mcpServers` for granted
> connectors only, and a `skillProvider` that serves only granted skills. Connector configs may use
> `${env:NAME}` and `${user.githubToken}` placeholders, resolved at session start and never logged.
> `onPermissionRequest` enforces the bot's policy and denies by default. A conversation is one Copilot
> session, resumed across turns, with turns serialized per conversation.
>
> **Inter-bot messaging.** Inject `list_bots` and `ask_bot(bot, message)` tools. `ask_bot` runs the
> target bot in a fresh child session as the same user, sends with `source: "agent-<callerId>"`, and
> returns its answer. Refuse when the target is not in the caller's `canMessage`, when the user cannot
> access the target, when the hop limit is exceeded, when the target is already in the chain (a
> cycle), or when the request's call budget is spent. Each refusal goes back to the model as a tool
> error, not an exception.
>
> **API.** REST over `node:http`, authenticated with a GitHub bearer token and identity from
> `GET /user`: list visible bots, create a conversation, send a message (JSON or SSE streaming), list
> and delete my conversations, and admin bot CRUD plus catalog reload.
>
> **Audit.** Write append-only JSONL for every user message, reply, tool call, permission decision,
> bot-to-bot hop (with trace ID and chain), and refusal. Redact secrets.
>
> **Proof.** Put the Copilot runtime behind an `AgentEngine` interface. Tests with a fake engine must
> cover catalog validation, access control, deny-by-default permissions, the hop limit, cycle
> refusal, the budget, secret redaction, and the HTTP flow. `tsc --noEmit` must pass against the SDK's
> types. A smoke script must start the real runtime and run one real turn when a Copilot-licensed
> token is available.
