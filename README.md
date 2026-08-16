# dsh-acp-gateway

An **independent, third-party DeepSeek Harness agent over the Agent Client
Protocol (ACP v1)** — a complete ACP agent over stdio that any ACP-compatible
client (Zed, VS Code ACP, Claude Code, ...) can launch directly. It is a
superset of the official automation-only
[`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/acp/acp):
every ACP session is a real DSH agent with the same tool access, presets,
sessions, and settings as the Web GUI.

> **Registry-style entry** (see the [ACP Registry](https://agentclientprotocol.com/get-started/registry)):
>
> | Field | Value |
> |---|---|
> | Name | `dsh-acp-gateway` |
> | Version | 3.10.0 |
> | Transport | stdio (JSON-RPC 2.0, newline-delimited) |
> | Protocol | ACP v1 |
> | Command | `npx -y dsh-acp-gateway` |
> | Registry JSON | https://raw.githubusercontent.com/devloom1024/dsh-acp-gateway/main/registry.json |
> | Capabilities | streaming, tool calls, sessions (list/load/delete), image/audio, slash commands, session modes (agent presets), config options (model / thought level / permission) |

## Quick Start

```bash
# One command — the package brings the full @deepseek-ai/dsh runtime, so no
# separate server, no global install. First launch downloads ~330 MB once.
npx -y dsh-acp-gateway
```

**Zed** — `settings.json`:

```json
{
  "agent": {
    "acp": {
      "command": "npx",
      "args": ["-y", "dsh-acp-gateway"]
    }
  }
}
```

First boot takes ~15-20s (a full DSH instance boots); each agent window is its
own process that exits with the window. Sessions persist in `~/.dsh`
(`DSH_ACP_HOME` isolates), so `session/load` resumes them later. Set the model
provider's API key env var (e.g. `OPENCODE_GO_API_KEY` or `DEEPSEEK_API_KEY`).

## Self-hosted ACP Registry

This repository also publishes a self-hosted ACP registry entry:

```text
https://raw.githubusercontent.com/devloom1024/dsh-acp-gateway/main/registry.json
```

It is a standard ACP registry JSON with an `npx` distribution:

```json
{
  "distribution": {
    "npx": {
      "package": "dsh-acp-gateway@3.10.0"
    }
  }
}
```

Clients that support a custom ACP registry URL can use the Raw GitHub URL
above. The icon is stored at [`assets/dsh-acp-icon.svg`](assets/dsh-acp-icon.svg).
CI runs `npm run check:registry` to keep `registry.json` and `package.json`
versions in sync.

## Features

| Capability | Detail |
|---|---|
| ✅ Token-level streaming | `assistant/chunk` text deltas → `agent_message_chunk` |
| ✅ Tool-call notifications | `tool_call` (pending) → `tool_call_update` (completed/failed) |
| ✅ Full tool access | mounts the selected agent preset: bash, fs, web, skills, subagents, ... |
| ✅ `session/list` / `session/load` / `session/delete` | resume persisted sessions with history replay |
| ✅ `usage_update` | token usage from `assistant/message` |
| ✅ Image / audio prompt content | image → DSH attachment; audio → textual reference |
| ✅ Slash commands | `available_commands_update` + `/cmd` execution (incl. `/plan`, `/plan off` — the same channel the web GUI's Plan chip uses) |
| ✅ Session modes | the **agent presets** (the web GUI's modes: Standard / Code(PTC) / Minimal / Creator / your custom presets), `session/set_mode` re-composes the agent, `current_mode_update` |
| ✅ `user_message_chunk` | echo accepted prompts |
| ✅ Embedded resource content | `resource` blocks expand into prompt text |
| ✅ Session config options | ACP v1 `configOptions` (select) for `mode` (the agent presets), `model` (`provider/model`), `thought_level`, `permission` (read-only / workspace-write / danger-full-access) |
| ✅ Permission approval flow | workspace-write asks the client through `session/request_permission` for mutating tools (edit/delete/move/execute) |
| ✅ Elicitation | DSH `ask_user_question` surfaces as an ACP `elicitation/create` form; answers feed back as the tool result |
| ✅ Thinking stream | `agent_thought_chunk` from DSH reasoning chunks |
| ✅ Agent plan | `exit_plan_mode` markdown → ACP `plan` notification (entries) |
| ✅ Session info | `session_info_update` on title changes — the deterministic fallback placeholder is suppressed, so a session's title notifies once (or on real change) and stays fixed |

## Architecture

```
ACP client (Zed / VS Code ACP / ...)
   │  stdio  (launches `dsh-acp-gateway` / `dsh-acp-agent` / `dsh-acp-server`)
   ▼
dsh-acp-gateway process (full DSH instance)
   │  agents.create() → real DSH agent (selected preset, full tools)
   ▼
DSH agent engine (same as the Web GUI)
```

- **Direct mode (default for editors)**: the client launches the server itself
  over stdio — stdio is the ACP channel, and the process exits when the client
  closes (1:1 lifecycle, no orphans).
- **Bridge mode**: `dsh-acp-agent` is a thin stdio bridge to a long-running
  `dsh-acp-server` (endpoint discovery: `DSH_ACP_URL` → `~/.dsh/acp/endpoint`
  → `http://127.0.0.1:3080`); one server can serve many clients/sessions.
- Each ACP session maps to a real DSH agent/session (durable, resumable via
  `session/load`).

## Installation

### 1. Zero-install: `npx` (recommended for editors)

See [Quick Start](#quick-start). The package depends on the full
`@deepseek-ai/dsh` runtime, so it is self-contained — no globally installed
dsh app, no separate server process, no manual lifecycle.

### 2. Offline archive (no npm, no network)

Build a self-contained tarball with the full dependency closure, the shipped
presets, and a portable vendor anchor. It expects a system `node >= 20`
(`--embed-node` bundles a Node binary instead):

```bash
bash scripts/package-offline.sh               # → dist-offline/dsh-acp-gateway-<ver>.tar.gz
bash scripts/package-offline.sh out --embed-node   # embed a Node runtime (~156 MB)
```

Extract anywhere and point an ACP client at the bundled launcher:

```json
{
  "agent": { "acp": { "command": "/path/to/extracted/dsh-acp", "args": [] } }
}
```

> The closure contains platform-specific native prebuilds (node-pty etc.), so
> build the archive on each target platform.

### 3. Deploy as a plugin inside a DSH deployment

```bash
npm install dsh-acp-gateway
# or clone this repo and: npm link
```

Add to your deployment `cordis.yml` (host plane):

```yaml
- id: acp-gateway
  name: 'dsh-acp-gateway'
  config: {}
```

Requires the standard host services (`agents`, `webServer`, `fs`, `shell`,
`agentDefaultModel`, `approval`, `agentPresets`, `commands`, `attachments`,
`sessionQuery`). On start the plugin writes the stdio bridge to
`~/.dsh/acp/dsh-acp-agent.js` (endpoint embedded).

## Client setup

**Zed** — `settings.json`:

```json
{
  "agent": {
    "acp": {
      "command": "npx",
      "args": ["-y", "dsh-acp-gateway"]
    }
  }
}
```

**VS Code (vscode-acp)** — `settings.json`:

```json
{
  "acp.agent": {
    "command": "npx",
    "args": ["-y", "dsh-acp-gateway"]
  }
}
```

**Any other ACP client** — point it at `npx -y dsh-acp-gateway`, or at a
local install (`npm i -g ./dsh-acp-gateway-<ver>.tgz` then
`dsh-acp-gateway`), or at the extracted offline launcher
(`/path/to/dsh-acp`).

## Usage

### Commands

| Command | Purpose |
|---|---|
| `dsh-acp-gateway` | the ACP agent itself (stdio direct mode) |
| `dsh-acp-server` | alias of the above |
| `dsh-acp-agent` | stdio bridge to a long-running server (bridge mode) |
| `dsh-acp-client` | a scripted test client |

```bash
npx dsh-acp-gateway
# --provider opencode-go --model deepseek-v4-flash (defaults, env-overridable)
```

By default the server **shares your deployment home (`~/.dsh`)**: presets
(including locally authored ones like `anchored-standard`), settings (default
model, default preset, permission), sessions, and credentials are exactly the
ones the web GUI uses. Set `DSH_ACP_HOME` (e.g. `~/.dsh-acp`) for a fully
isolated instance.

### Session modes = agent presets

ACP session modes are the **agent presets** — the same "modes" the web GUI
offers (Standard / Code / Minimal / Creator, plus your custom presets). The
current mode follows the deployment default (`agent-presets.default` in
settings); `session/set_mode` or the `mode` config option switches the preset:
a session that has not started yet is recomposed in place (and the switch is
recorded in its log), a started session re-composes at the next prompt. Plan
mode is **not** a mode: it is toggled through the `/plan` and `/plan off`
slash commands, exactly like the web GUI's Plan chip.

### Test client

```bash
npx dsh-acp-client                        # interactive, via the bridge
npx dsh-acp-client --endpoint http://127.0.0.1:56045
echo 'init
new /tmp
prompt 运行 pwd 并报告' | npx dsh-acp-client   # scripted
```

Commands: `init`, `new [cwd]`, `prompt <text>`, `mode <preset-id>`,
`set <configId> <value>` (mode/provider/model/thought_level/permission),
`cancel`, `list`, `load <id>`, `delete <id>`.

## Protocol coverage

Implemented methods (Agent side): `initialize`, `authenticate` (no-op), `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/delete`, `session/set_mode`, `session/set_config_option`.

Notifications: `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`.

Session config options: `mode` (the agent presets — standard / code(PTC) / minimal / creation / your custom presets), `model` (`provider/model` — one selector across every provider), `thought_level` (minimal/low/medium/high/max), `permission` (sandbox file access: read-only / workspace-write / danger-full-access). `model` and `thought_level` route through the per-agent request waterfall (like the web GUI's model selector) and take effect on the next prompt without disposing the session; `mode` recomposes a not-yet-started session immediately and re-composes a started one at the next prompt; `permission` applies immediately and sets the approval policy (workspace-write asks the client via `session/request_permission` for mutating tools). `configOptions` report the session's **actual** current state — the client's pending choice, else the session's own logged request header / recorded preset / sandbox policy resolution — so a session loaded after a server restart shows the config it really runs, not the ambient default. Both `configOptions` and the `modes` field are returned (transition period per the spec).

Notifications additionally include `agent_thought_chunk` (reasoning stream), `plan` (from `exit_plan_mode`), and `session_info_update` (title changes). Titles are stable by design: DSH first logs a deterministic fallback title (a truncation of the first message) and supersedes it with the LLM/provider title seconds later — the gateway suppresses the fallback and notifies only user-pinned and provider titles, deduped per session, so the client sees one title that stays fixed (a genuinely changing title still updates). `session/load` / `session/resume` re-surface the session's current title once (for clients that connect after it was set), and `session/list` folds the latest logged title per session. DSH `ask_user_question` maps to an ACP `elicitation/create` form.

Content: `text`, `resource` (embedded context), `resource_link`, `image`, `audio`.

Not implemented (by design): client-cooperative capabilities (`fs/*`, `terminal/*`, `elicitation/*`), MCP server connection, HTTP transport.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Editor stuck on "loading" | The bridge could not reach any endpoint. Check `~/.dsh/acp/endpoint` points at a live server (`DSH_ACP_URL` overrides), or use direct mode (`npx -y dsh-acp-gateway`). The bridge now answers with a JSON-RPC error and re-reads the endpoint file instead of hanging |
| Typing `/` shows no slash commands | Zed drops `available_commands_update` sent before the `session/new` response ([zed#60199](https://github.com/zed-industries/zed/issues/60199)); this gateway holds notifications until after the response — restart the agent and create a fresh session |
| `session/delete` leaves sessions behind | Fixed: persisted session dirs are removed with direct fs |
| Multiple ACP instances | Multiple clients can share one server (bridge mode); each direct-mode process is its own full DSH instance (~30-60 MB RSS each, 15-20s boot) |
| Plan mode does nothing | Plan is toggled via `/plan` / `/plan off` slash commands, not a session mode |

## Development

The package is TypeScript compiled to ESM in `dist/` (NodeNext). Logic lives
in `src/*.ts`; `bin/` artifacts are emitted to `dist/src/bin/`.

```bash
npm run check   # tsc --noEmit (type-check)
npm run build   # tsc (emit dist/)
npm test        # build + run unit tests against the build
```

### Publishing

The package is self-contained for `npx`: it depends on `@deepseek-ai/dsh`
(which brings the whole runtime closure), ships the preset roster in
`config/agent-presets`, and carries the portable vendor anchor in `vendor/`
(regenerate after any dependency change):

```bash
npm install     # fetch the closure
npm run vendor  # regenerate vendor/dsh-app/package.json
npm run build
npm test
npm publish
```

Offline archive (for machines without npm/Node):

```bash
npm run pack-offline   # → dist-offline/dsh-acp-gateway-<ver>.tar.gz (~119 MB)
```

The runtime depends on the dsh installation's packages (resolved through the
`@deepseek-ai/*` symlink farm in `node_modules/`). After any `npm install`,
restore the links with:

```bash
./scripts/link-deps.sh
```

## License

MIT
