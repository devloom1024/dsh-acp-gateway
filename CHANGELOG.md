# Changelog

All notable changes to this project are documented in this file.

## [3.12.0] - 2026-09-04

### Changed
- Reference the DeepSeek Harness 0.1.2-rc.1 runtime
  (`@deepseek-ai/dsh` / `@deepseek-ai/dsh-app-boot` /
  `@deepseek-ai/dsh-tools` `^0.1.2-rc.1`). Verified against the published
  package surface: `commands.execute` now takes `readonly
  EncodedImageAttachment[]` (encoded raster images attached to a slash
  command), `llm.resolveModelInfo()` exposes the route's adapter-declared
  reasoning efforts (`reasoning.efforts` + `reasoning.defaultEffort`), and the
  `attachments` store validates image batches against the deployment's
  `imageLimits.mediaTypes` (png/jpeg/webp/gif). Session event reads, branded
  `ReasoningEffortId`, and preset mounting are unchanged from alpha.4.

### Fixed
- Image and file prompt content are no longer dropped. `session/prompt`
  previously threw away every admitted image (the prompt was reduced to its
  text before `agent.followup`), so a vision model never saw attached
  pictures; `resource_link` blocks and binary/data-bearing `resource` blocks
  were silently discarded. Prompt admission now runs through
  `acpPromptToContent()` (`src/codec.ts`): raster images persist through the
  attachment store as real `image` blocks (canonical base64, the deployment's
  media-type vocabulary), `resource_link`/`resource` file references inline
  local `file://` files as text (unreadable, binary, or oversized files keep
  an explicit textual reference), audio and unknown kinds degrade to explicit
  references, and slash commands receive the prompt's encoded images
  (0.1.2-rc.1 `commands.execute`). Nothing the client sends is silently
  dropped anymore.
- The `thought_level` session config option is now always offered once the
  session route exposes reasoning efforts, instead of only after an effort was
  already chosen — the option was missing at `session/new` on most
  deployments. Its select vocabulary and the current value now come from the
  model adapter's declared efforts (`llm.resolveModelInfo().reasoning`,
  exactly the official model-control vocabulary): the adapter's effort list,
  plus a "Provider default" entry (empty value) when the adapter configures
  no default. `session/set_config_option thought_level` validates against
  that catalog (falling back to the built-in vocabulary when no catalog is
  reachable), and the empty provider-default value clears the session's
  explicit effort instead of being rejected.
- `initialize` no longer advertises `audio` prompt capability (DSH has no
  native audio block; audio inputs were already degraded to textual
  references, so claiming the capability was misleading).
- History replay renders archived user `image` blocks as `[image]` instead of
  omitting the message.

## [3.11.1] - 2026-09-02

### Fixed
- Standalone `dsh-acp-server` mounts
  `@deepseek-ai/dsh-tool-subagent/model-selection-settings` on the Host plane.
  The shipped 0.1.2-alpha.4 `standard`/`ptc` presets enable subagent model
  selection (`tool-subagent modelSelectionSettings: true`), which requires the
  Host-owned `ctx.subagentModelSelection` service; without the row every
  preset mount failed with
  "`modelSelectionSettings` requires
  @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope"
  — observable as `mode switch failed` in clients (Zed) when the default
  `standard` mode was (re)mounted. The row registers the
  `subagent-model-selection` user-settings namespace (default off), exactly
  like the official web profile.

## [3.11.0] - 2026-09-02

### Changed
- Reference the DeepSeek Harness 0.1.2-alpha.4 runtime
  (`@deepseek-ai/dsh` / `@deepseek-ai/dsh-app-boot` /
  `@deepseek-ai/dsh-tools` `^0.1.2-alpha.4`), the latest published
  version. Verified against the official release notes:
  `Session.events` was replaced by on-demand reads (`seq`, `eventAt()`,
  `snapshotEvents()`), `AgentOptions.reasoningEffort` is now the
  `ReasoningEffortId` brand, `commands.execute` gained an `images`
  parameter, `healProfilesModuleFallback` takes an options object (and is
  async), and the shipped agent presets were republished through
  `@deepseek-ai/dsh-agent-presets/presets` (the `code` preset was renamed
  `ptc`).
- Session event reads now go through `snapshotEvents()` in preference to the
  removed `Session.events`/`Session.log` accessors (with a compatible
  fallback for older runtimes), so log scans (preset, title, sandbox mode,
  history replay, turn counting) keep working on alpha.4.
- `reasoningEffort` is branded via `ReasoningEffortId` before it reaches
  `agents.create` / `agents.resume`, matching the new `AgentOptions` type.
- Slash-command execution passes the new required `images` argument
  (`commands.execute(agent, line, images, signal)`).
- `dsh-acp-server` locations the shipped preset roster from
  `@deepseek-ai/dsh-agent-presets/presets` (first choice), falling back to the
  legacy `<dsh>/config/agent-presets` layout and the bundle's own copy; the
  `agent-presets` row now sets `includeShippedRoot`/`includeUserRoot`.
- Shipped presets in `config/agent-presets` synced to the official
  0.1.2-alpha.4 roster (`standard`, `minimal`, `ptc`, `cordis`; the old `code`
  directory is gone — PTC mode is the `ptc` preset with `mode: ptc`).

## [3.10.3] - 2026-08-16

### Fixed
- Removed the hardcoded 10-minute `session/prompt` timeout that killed any
  turn running longer — including legitimate long work (subagent delegation,
  long research) and `ask_user_question` elicitation forms waiting on the
  user. The gateway no longer imposes its own prompt timer by default: the
  turn lifecycle is DSH-owned (its timeout/abort machinery and per-tool
  timeouts apply, and the client can `session/cancel`). Deployments that
  want a gateway-level cap can set `promptTimeoutMs` in the plugin config;
  when the timer fires it now also cancels the agent turn, so the session
  does not keep running detached from a client that was told the prompt
  failed.

## [3.10.2] - 2026-08-16

### Fixed
- Session titles no longer refresh repeatedly. DSH logs a deterministic
  fallback title (a truncation of the first user message) immediately and
  supersedes it with the LLM/provider title seconds later; the gateway
  forwarded both, so every session flashed two titles. The fallback is now
  suppressed — only user-pinned and provider titles notify, deduped per
  session — so the client receives one title that stays fixed, while a
  genuinely changing title (e.g. all-prompts re-titling) still updates.
- `session/load` and `session/resume` re-surface the session's current title
  once, so a client that connects after the title was generated (or after a
  gateway restart) still sees it.
- `session/list` now folds the latest logged title per session (session
  headers carry no title field, so the picker previously showed untitled
  entries); missing titles and snapshot failures degrade gracefully.

## [3.10.1] - 2026-08-16

### Fixed
- Session config options now actually apply. `mode`/`preset` switches
  recompose a not-yet-started session in place and record the switch in its
  log (exactly like the web GUI), and re-compose a started session at the
  next prompt; `model` and `thought_level` route through the per-agent
  `agent/request` waterfall — the web GUI's own model-selection mechanism —
  and take effect on the next prompt without disposing the session. Before:
  the chosen preset was never mounted (the setup hook read a session scratch
  value that was never set), and the reasoning effort passed in `agentOptions`
  was silently dropped by the agent loop, which only reads provider/model
  from options.
- `configOptions` and `modes` now report the session's ACTUAL current state
  instead of the ambient default: the client's pending choice, else the
  session's own logged `request/header` (model/effort), its recorded preset
  (`agent-preset/selected`, else the creation header), and the sandbox
  policy's full resolution (permission). A session loaded after a server
  restart shows the config it really runs under.
- The composed preset is persisted in the session creation header
  (`meta.agentPreset`), so a restarted server resumes every session under its
  own preset instead of the deployment default.
- Config-option rebuilds no longer loop: `needsRebuild` tracks the preset
  only, and the applied preset is recorded from the session itself.
- `reasoning-delta` chunks stream as `agent_thought_chunk` alongside the
  legacy `reasoning`/`thinking` chunk types.

### Changed
- The stdio bridge and the endpoint file honor `$DSH_ACP_HOME`/`$DSH_HOME`
  for the isolated-instance convention (endpoint resolution and write path).
- Vendor anchor regenerated from the pruned dependency closure.

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
