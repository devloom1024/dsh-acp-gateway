# dsh-acp-gateway

A distributable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that exposes a **complete ACP v1 (Agent Client Protocol) agent over stdio**. Any ACP-compatible client — Zed, VS Code ACP, Claude Code, ... — can launch it and get a real DSH agent with the same tool access as the Web GUI.

> Registry-style entry (like [ACP Registry](https://agentclientprotocol.com/get-started/registry)):
>
> | Field | Value |
> |---|---|
> | Name | `dsh-acp-gateway` |
> | Version | 3.8.0 |
> | Transport | stdio (JSON-RPC 2.0, newline-delimited) |
> | Protocol | ACP v1 |
> | Command | `node <path>/bin/dsh-acp-agent.js` |
> | Capabilities | streaming, tool calls, sessions (list/load/delete), image/audio, slash commands, session modes, session config options (model / thought level / mode) |

## Features

Compared to the upstream automation-only [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/acp/acp), this plugin adds:

| Capability | Detail |
|---|---|
| ✅ Token-level streaming | `assistant/chunk` text deltas → `agent_message_chunk` |
| ✅ Tool-call notifications | `tool_call` (pending) → `tool_call_update` (completed/failed) |
| ✅ Full tool access | mounts the `standard` agent preset: bash, fs, web, skills, subagents, ... |
| ✅ `session/list` / `session/load` / `session/delete` | resume persisted sessions with history replay |
| ✅ `usage_update` | token usage from `assistant/message` |
| ✅ Image / audio prompt content | image → DSH attachment; audio → textual reference |
| ✅ Slash commands | `available_commands_update` + `/cmd` execution |
| ✅ Session modes | `code` / `plan` (maps DSH plan mode), `session/set_mode`, `current_mode_update` |
| ✅ `user_message_chunk` | echo accepted prompts |
| ✅ Embedded resource content | `resource` blocks expand into prompt text |
| ✅ Session config options | ACP v1 `configOptions` (select) for `mode` (code/plan), `model`, `provider`, `thought_level`, and `permission` (read-only / workspace-write / danger-full-access); `session/set_config_option` returns the full config state; `config_option_update` notifications |

## Architecture

```
ACP client (Zed / VS Code ACP / ...)
   │  stdio  (launches bin/dsh-acp-agent.js)
   ▼
bin/dsh-acp-agent.js        ← standalone Node bridge, no DSH dependency
   │  loopback JSON-RPC + SSE (internal channel)
   ▼
DSH process: acp-gateway plugin
   │  agents.create() → real DSH agent (standard preset, full tools)
   ▼
DSH agent engine (same as the Web GUI)
```

- The bridge is the **only** external transport. The loopback HTTP channel is an implementation detail, not an exposed HTTP capability.
- Each ACP session maps to a real DSH agent/session (durable, resumable via `session/load`).

## Installation

### 1. Install the plugin package

```bash
npm install dsh-acp-gateway
# or clone this repo and: npm link
```

### 2. Enable it in DSH

Add to your deployment `cordis.yml` (host plane):

```yaml
- id: acp-gateway
  name: 'dsh-acp-gateway'
  config: {}
```

Requires `@deepseek-ai/dsh-tools` (peer), plus the standard host services (`agents`, `webServer`, `fs`, `shell`, `agentDefaultModel`, `approval`, `agentPresets`, `planMode`, `commands`, `attachments`, `sessionQuery`).

On start the plugin writes the stdio bridge to `~/.dsh/acp/dsh-acp-agent.js` (endpoint embedded), or you can use the package bin directly.

### 3. Configure your editor

**Zed** — `settings.json`:

```json
{
  "agent": {
    "acp": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-acp-gateway/bin/dsh-acp-agent.js"]
    }
  }
}
```

**VS Code (vscode-acp)** — `settings.json`:

```json
{
  "acp.agent": {
    "command": "node",
    "args": ["/absolute/path/to/dsh-acp-gateway/bin/dsh-acp-agent.js"]
  }
}
```

The bridge resolves the DSH endpoint from, in order: `DSH_ACP_URL` env var → `~/.dsh/acp/endpoint` file → `http://127.0.0.1:3080`.

## One-command isolated server

Prefer a self-contained ACP agent (own home, config, credentials, sessions;
nothing in your existing DSH deployment is touched)? Launch the embedded
server directly — it boots an isolated DSH instance (official `dsh-base`
agent stack on a loopback port) and serves ACP over its own stdio:

```bash
npx dsh-acp-server            # or: node bin/dsh-acp-server.js
# --provider opencode-go --model deepseek-v4-flash (defaults, env-overridable)
# Set the provider's API key env var, e.g. OPENCODE_GO_API_KEY or DEEPSEEK_API_KEY
```

Or reuse the official CLI and attach the gateway to an isolated profile
(web UI + full agent stack, still isolated via `DSH_HOME`):

```bash
DSH_HOME=~/.dsh-acp npx @deepseek-ai/dsh --profile web \
  --patch node_modules/dsh-acp-gateway/examples/web.patch.yml
```

Either way the bridge (`dsh-acp-agent`) finds the instance through
`DSH_ACP_URL` → `~/.dsh/acp/endpoint` → `http://127.0.0.1:3080`.

## Test client

A small ACP client for driving the gateway the way an editor would — handy for
verifying behavior without an editor:

```bash
node bin/dsh-acp-client.js                        # interactive, via the bridge
node bin/dsh-acp-client.js --endpoint http://127.0.0.1:56045
echo 'init
new /tmp
prompt 运行 pwd 并报告' | node bin/dsh-acp-client.js   # scripted
```

Commands: `init`, `new [cwd]`, `prompt <text>`, `mode <code|plan>`,
`set <configId> <value>` (provider/model/thought_level/permission),
`cancel`, `list`, `load <id>`, `delete <id>`.

## Development

```bash
npm run check   # syntax-check all sources
npm test        # run unit tests
```

## Protocol coverage

Implemented methods (Agent side): `initialize`, `authenticate` (no-op), `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/delete`, `session/set_mode`, `session/set_config_option`.

Notifications: `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`.

Session config options: `mode` (code/plan — controls how the agent requests permission), `model` (catalog from the selected provider), `provider` (all registered DSH LLM providers), `thought_level` (minimal/low/medium/high/max), `permission` (sandbox file access: read-only / workspace-write / danger-full-access, applied as a `sandbox/mode` session event). Changing `provider`, `model`, or `thought_level` rebuilds the live agent from its persisted session with the new options; changing `mode` switches DSH plan mode immediately; changing `permission` applies immediately. Both `configOptions` and the legacy `modes` field are returned (transition period per the spec).

Content: `text`, `resource` (embedded context), `resource_link`, `image`, `audio`.

Not implemented (by design): client-cooperative capabilities (`fs/*`, `terminal/*`, `elicitation/*`), MCP server connection, HTTP transport.

## License

MIT
