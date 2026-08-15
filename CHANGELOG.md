# Changelog

All notable changes to this project are documented in this file.

## [3.10.0] - 2026-08-15

### Added
- Session modes now ARE the agent presets (the web GUI's modes): modes come
  from `agentPresets.list()` with localized names/descriptions, the current
  mode follows the deployment default (settings `agent-presets.default`),
  and `session/set_mode` / the `mode` config option switch the preset with a
  lazy agent rebuild at the next prompt. The invented `code`/`plan`
  vocabulary and the redundant `preset` config option are gone; plan mode is
  toggled through the `/plan` and `/plan off` slash commands, exactly like
  the web GUI's Plan chip.
- Slash-command execution relays the handler's `{kind, text}` output instead
  of a placeholder.
- Self-contained distribution: the package depends on `@deepseek-ai/dsh`
  (the whole runtime closure), ships the preset roster, and carries a
  portable vendor anchor — `npx -y dsh-acp-gateway` is a complete ACP agent
  with no global dsh app and no separate server process. New bin named after
  the package makes the npx invocation unambiguous.
- Offline archive: `scripts/package-offline.sh` assembles a self-contained
  tarball (full closure + shipped presets + vendor anchor; optional embedded
  Node runtime via `--embed-node`).

### Fixed
- `dsh-acp-server` anchor resolution: resolves `@deepseek-ai/dsh` by name
  first (npm-flat layout), then the classic three-level climb (global
  install), then the bundle's vendor anchor; the shipped preset roster is
  located beside the anchor.
- Shipped preset root resolution was off by one directory and the
  `agent-presets` row was missing its required config `default` — the row
  never mounted, so no presets were visible in the standalone server.
- `session/delete` now removes persisted session directories with direct
  node:fs (the shell service is sandbox-gated and silently refused before).
- Bridge: on total endpoint failure it re-reads the endpoint file (a
  restarted server's new port is picked up without restart) and answers with
  a JSON-RPC error instead of leaving the editor loading forever.
- Bridge: `session/update` notifications are held while `session/new` or
  `session/load` is in flight and flushed after the response, so Zed does
  not drop `available_commands_update` for the not-yet-registered session
  (zed-industries/zed#60199).
- Bridge: stdin EOF no longer exits while a request is awaiting its
  response — a client that sends a request and closes stdin immediately
  still receives the reply.

### Changed
- `dsh-acp-server` shares the real deployment home (`~/.dsh`) by default so
  presets, settings, sessions, and credentials match the web GUI;
  `DSH_ACP_HOME` keeps the isolated mode.
- `dsh-acp-server`'s generated bridge script path moved to
  `~/.dsh/acp/dsh-acp-agent.js` (same convention as the deployment plugin).

## [3.9.0] - 2026-08-15

### Added
- Approval flow: workspace-write asks the ACP client via
  `session/request_permission` for mutating tools; reject/allow outcomes map
  to tool decisions; approval policy tracks the permission level.
- Agent-to-client JSON-RPC channel (requests ride the SSE/bridge stream,
  responses route back through `/acp/rpc`).
- Elicitation: per-agent `ask_user_question` surfaces an ACP
  `elicitation/create` form; answers feed back as the tool result.
- `agent_thought_chunk` from DSH reasoning chunks; `plan` notification from
  `exit_plan_mode` markdown; `session_info_update` on title changes.
- Preset selection config option with agent rebuild; model selector as a
  single provider/model option.

## [3.8.0] - 2026-08-15

Initial release: DSH ACP gateway — token-level streaming, tool-call
notifications, session list/load/delete, usage updates, image/audio prompt
content, slash commands, session modes, config options, one-command isolated
server, and a scripted test client.
