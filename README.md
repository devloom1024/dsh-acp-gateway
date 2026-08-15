# dsh-acp-gateway

A distributable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that exposes a **complete ACP v1 (Agent Client Protocol) agent over stdio**. Any ACP-compatible client — Zed, VS Code ACP, Claude Code, ... — can launch it and get a real DSH agent with the same tool access as the Web GUI.

> Registry-style entry (like [ACP Registry](https://agentclientprotocol.com/get-started/registry)):
>
> | Field | Value |
> |---|---|
> | Name | `dsh-acp-gateway` |
> | Version | 3.9.0 |
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
| ✅ Slash commands | `available_commands_update` + `/cmd` execution (incl. `/plan`, `/plan off` — the same channel the web GUI's Plan chip uses) |
| ✅ Session modes | the **agent presets** (the web GUI's modes: Standard / Code(PTC) / Minimal / Creator / your custom presets), `session/set_mode` re-composes the agent, `current_mode_update` |
| ✅ `user_message_chunk` | echo accepted prompts |
| ✅ Embedded resource content | `resource` blocks expand into prompt text |
| ✅ Session config options | ACP v1 `configOptions` (select) for `mode` (the agent presets — same values as `session/set_mode`), `model` (`provider/model`), `thought_level`, `permission` (read-only / workspace-write / danger-full-access); `session/set_config_option` returns the full config state; `config_option_update` notifications |
| ✅ Permission approval flow | workspace-write asks the client through `session/request_permission` for mutating tools (edit/delete/move/execute); read-only and full-access never ask (sandbox gates the former). Approval policy tracks the permission level |
| ✅ Elicitation | DSH `ask_user_question` surfaces as an ACP `elicitation/create` form; answers feed back as the tool result |
| ✅ Thinking stream | `agent_thought_chunk` from DSH reasoning chunks |
| ✅ Agent plan | `exit_plan_mode` markdown → ACP `plan` notification (entries) |
| ✅ Session info | `session_info_update` on title changes |

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

## One-command server

Launch the embedded server directly — it boots a full DSH instance (official
`dsh-base` agent stack on a loopback port) and serves ACP over its own stdio:

```bash
npx dsh-acp-server            # or: node bin/dsh-acp-server.js
# --provider opencode-go --model deepseek-v4-flash (defaults, env-overridable)
# Set the provider's API key env var, e.g. OPENCODE_GO_API_KEY or DEEPSEEK_API_KEY
```

By default the server **shares your deployment home (`~/.dsh`)**: agent
presets (including locally authored ones), settings (default model, default
preset, permission), sessions, and credentials are exactly the ones the web
GUI uses, so every feature behaves identically. Set `DSH_ACP_HOME` (e.g.
`~/.dsh-acp`) for a fully isolated instance that touches nothing in the real
deployment — the preset roster then contains only the shipped presets plus
whatever you author inside the isolated home's `.agent-presets`.

You can also reuse the official CLI and attach the gateway to an isolated
profile (web UI + full agent stack, still isolated via `DSH_HOME`):

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

Commands: `init`, `new [cwd]`, `prompt <text>`, `mode <preset-id>`,
`set <configId> <value>` (mode/provider/model/thought_level/permission),
`cancel`, `list`, `load <id>`, `delete <id>`.

## Development

The package is TypeScript compiled to ESM in `dist/` (NodeNext). Logic lives
in `src/*.ts`; `bin/` artifacts are emitted to `dist/src/bin/`.

```bash
npm run check   # tsc --noEmit (type-check)
npm run build   # tsc (emit dist/)
npm test        # build + run unit tests against the build
```

The runtime depends on the dsh installation's packages (resolved through the
`@deepseek-ai/*` symlink farm in `node_modules/`). After any `npm install`,
restore the links with:

```bash
./scripts/link-deps.sh
```

## Protocol coverage

Implemented methods (Agent side): `initialize`, `authenticate` (no-op), `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/delete`, `session/set_mode`, `session/set_config_option`.

Notifications: `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`.

Session config options: `mode` (the agent presets — standard / code(PTC) / minimal / creation / your custom presets; identical values to `session/set_mode`), `model` (`provider/model` — one selector across every provider), `thought_level` (minimal/low/medium/high/max), `permission` (sandbox file access: read-only / workspace-write / danger-full-access). Changing `mode`, `model`, or `thought_level` rebuilds the live agent from its persisted session; `permission` applies immediately and sets the approval policy (workspace-write asks the client via `session/request_permission` for mutating tools). Plan mode is **not** a session mode: it is toggled through the `/plan` and `/plan off` slash commands, exactly like the web GUI's Plan chip. Both `configOptions` and the `modes` field are returned (transition period per the spec).

Notifications additionally include `agent_thought_chunk` (reasoning stream), `plan` (from `exit_plan_mode`), and `session_info_update` (title changes). DSH `ask_user_question` maps to an ACP `elicitation/create` form.

Content: `text`, `resource` (embedded context), `resource_link`, `image`, `audio`.

Not implemented (by design): client-cooperative capabilities (`fs/*`, `terminal/*`, `elicitation/*`), MCP server connection, HTTP transport.

## License

MIT
