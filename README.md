# Copilot Bot Platform

A self-hosted enterprise bot platform on the [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk).
Teams define **bots** as reviewed YAML, give them **skills** (`SKILL.md`) and **connectors** (MCP servers),
and let bots **message each other**. Every turn runs as the person asking, on their own Copilot seat.

```
                 ┌──────────── Platform ─────────────┐
 user ──HTTP──▶  │ auth (GitHub) ─▶ conversations    │
 (GitHub token)  │                     │             │
                 │   catalog ◀── bots/*.yaml         │        ┌─ Copilot runtime (mode "empty") ─┐
                 │   (bots, skills,    │             │        │  session per conversation         │
                 │    connectors)      ▼             │ ─────▶ │  gitHubTokenProvider = user token │
                 │                 bot bus ──────────┼──┐     │  mcpServers  = granted connectors │
                 │  (ask_bot: ACL, hops, cycles,     │  │     │  skillProvider = granted skills   │
                 │   budget)                         │  └───▶ │  ephemeral child session per hop  │
                 │   audit log (JSONL, redacted)     │        └───────────────────────────────────┘
                 └───────────────────────────────────┘
```

## Why it is built this way

| Concern | How |
| --- | --- |
| Identity and billing | Each session gets the **caller's** GitHub token through `gitHubTokenProvider`. Copilot seat checks, model policy and usage apply to that person. Connectors can forward the same token (`${user.githubToken}`), so a bot never sees more than the person asking. |
| Least privilege | The client runs in `mode: "empty"`. The coding agent's shell, file edits and host access are off. Bots opt into `web_search` / `web_fetch`, granted skills, and granted connectors only. `onPermissionRequest` denies by default. |
| Bots as code | `bots/*.yaml` is validated (zod) together with skill and connector references at load time. The admin API writes the same files, so changes can go through code review. |
| Inter-bot messaging | `list_bots` / `ask_bot` tools. Each hop runs in a fresh child session as the same user, sent with `source: "agent-<caller>"`. Each hop is checked against `canMessage`, user access, a hop limit, cycle detection, and a call budget shared by the whole request. |
| Audit | Append-only JSONL with a trace ID per request: messages, tool calls, permission decisions, every bot-to-bot hop and refusal. Tokens and connector secrets are redacted. |

## Quick start

```bash
npm install
npm run validate                # check workspace/ (bots, connectors, skills)
npm test                        # 36 tests, no Copilot seat needed (fake engine)
npm run smoke                   # boots the bundled Copilot runtime and pings it
GITHUB_TOKEN=$(gh auth token) npm run smoke   # also runs a real turn plus a bot-to-bot hop

# Chat with a bot in your terminal, as yourself
GITHUB_TOKEN=$(gh auth token) npm run dev -- chat concierge

# Run the API
ADMINS=your-login npm run dev -- serve
```

`GITHUB_TOKEN` must belong to a user with a Copilot seat. Add the `read:org` scope if bots are shared by org.

## Defining things

A **bot** (`workspace/bots/<id>.yaml`):

```yaml
id: release-writer
name: Release Writer
description: Reads merged pull requests on GitHub and drafts release notes in the house format.
instructions: |
  Use the GitHub connector to read what you need. Load the release-notes skill before drafting.
model: claude-sonnet-4.5           # optional; DEFAULT_MODEL otherwise
builtinTools: [web_search, web_fetch]   # optional; nothing else is offered
skills: [release-notes]
connectors: [github]
canMessage: [researcher]           # bots this one may call through ask_bot
access:
  users: ["*"]                     # GitHub logins, or "*"
  orgs: [your-org]                 # members of these orgs
permissions:
  allow: [url, mcp, custom-tool]   # optional; derived from tools/connectors when omitted
internal: false                    # true = reachable only by other bots
```

A **connector** (`workspace/connectors/<id>.yaml`) is an MCP server. HTTP/SSE example:

```yaml
id: github
description: GitHub's hosted MCP server, called with the requesting user's own token.
type: http
url: https://api.githubcopilot.com/mcp/readonly
headers:
  Authorization: "Bearer ${user.githubToken}"
```

stdio example:

```yaml
id: jira
description: Jira via a local MCP server
type: stdio
command: npx
args: ["-y", "some-jira-mcp-server"]
env:
  JIRA_TOKEN: "${env:JIRA_TOKEN}"   # resolved at session start, never logged
tools: ["search_issues", "get_issue"]  # optional allowlist
```

A **skill** (`workspace/skills/<name>/SKILL.md`) uses the standard `SKILL.md` format: frontmatter
`name` and `description`, then instructions. Other files in the folder are offered to the model as
supporting files. A bot sees only the skills it lists.

## API

All `/v1` routes need `Authorization: Bearer <GitHub token>`.

| Method | Path | |
| --- | --- | --- |
| GET | `/v1/me` | login, orgs, admin flag |
| GET | `/v1/bots` | bots you can talk to |
| POST | `/v1/conversations` | `{ "botId": "concierge" }` |
| GET | `/v1/conversations` | your conversations |
| GET / DELETE | `/v1/conversations/:id` | |
| POST | `/v1/conversations/:id/messages` | `{ "text": "..." }`; send `Accept: text/event-stream` to stream `delta` / `tool.start` / `tool.complete` / `permission` events, each tagged with `botId` and `depth` |
| GET | `/v1/admin/catalog` | admins |
| PUT | `/v1/admin/bots/:id` | admins; validates, writes `bots/<id>.yaml`, hot-swaps the catalog |
| POST | `/v1/admin/reload` | admins; reloads the workspace from disk |

## Configuration

| Env | Default | |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | |
| `WORKSPACE_DIR` | `./workspace` | bots, connectors, skills |
| `STATE_DIR` | `./state` | conversations, audit logs, Copilot session state |
| `ADMINS` | | comma-separated GitHub logins |
| `ORG_NAME` | | used in bot personas |
| `DEFAULT_MODEL` | runtime default | |
| `MAX_HOPS` | `3` | bot-to-bot depth below the bot the user addressed |
| `MAX_BOT_CALLS` | `8` | bot-to-bot calls per user request |
| `TURN_TIMEOUT_MS` | `300000` | |
| `GITHUB_API_URL` | `https://api.github.com` | set for GitHub Enterprise Server |

## Layout

```
src/catalog/      schemas + loader for bots, connectors, skills
src/engine/       AgentEngine interface, Copilot SDK implementation, permission policy
src/bus/          inter-bot messaging (ask_bot / list_bots)
src/conversations platform core + conversation store
src/http/         REST + SSE API
src/identity.ts   GitHub token auth, access checks
src/audit.ts      JSONL audit log with secret redaction
workspace/        example bots, connector, skills
docs/PROMPT.md    the refined spec this was built from
```

## Not done yet

- **Chat front-ends:** web UI, Slack and Teams adapters. They sit on the same `Platform` API.
- **Horizontal scale:** conversations and Copilot session state are on local disk. Use a database store
  and the SDK's `sessionFs` provider, or sticky routing, before running more than one replica.
- **Async messaging:** bot channels and pub/sub with scheduled or event-triggered bots. Today's bus is
  request/response.
- **Per-connector OAuth** for third-party SaaS (beyond token placeholders), and a secrets-manager backend
  for `${env:...}`.
- **An eval suite** of real prompts per bot, scored against expected tool use and answers.
