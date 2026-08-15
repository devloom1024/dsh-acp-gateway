/**
 * Minimal DSH agent spine for the standalone ACP server.
 *
 * The upstream `agent-spine-demo` (an examples package, not published to npm)
 * composes published platform services with `ctx.plugin()`. This module is the
 * distributable equivalent: it mounts the core services a real DSH agent needs
 * — LLM runtime, session store, tool registry, system prompt, agent registry,
 * retry, jobs, bash, and the agent loop — without depending on any
 * examples-only package and without any ACP code.
 *
 * @module dsh-acp-gateway/spine
 */
import type { Context } from '@deepseek-ai/cordis'
import { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { apply as applyLlmRetry } from '@deepseek-ai/dsh-llm-retry'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import { apply as applyToolBash } from '@deepseek-ai/dsh-tool-bash'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'

/** Overridable session-title limits (same shape as the upstream example). */
const DEFAULT_SESSION_TITLE_CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
}

/**
 * Mount the core spine on the provided context.
 * @param ctx - host context (from boot()).
 * @param config - optional overrides (`{ dshHome, persona, toolOrder, maxParallelToolCalls }`).
 */
export interface SpineConfig {
  dshHome?: string
  persona?: string
  toolOrder?: string[]
  maxParallelToolCalls?: number
  sessionTitle?: Partial<{ fallbackMaxWords: number; fallbackMaxBytes: number; maxTitleBytes: number }>
  tools?: Record<string, unknown>
  jobs?: Record<string, unknown>
  toolBash?: Record<string, unknown> | false
}

export function applySpine(ctx: Context, config: SpineConfig = {}): void {
  const dshHome = config.dshHome || process.env.DSH_HOME || undefined

  ctx.plugin(TimerService)
  ctx.plugin(LlmRuntime)
  ctx.plugin(SessionStore)
  ctx.plugin(SessionTitleService, { ...DEFAULT_SESSION_TITLE_CONFIG, ...(config.sessionTitle ?? {}) })
  ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: true,
    includeRuntimeContext: true,
    persona: config.persona || '',
    ...(config.toolOrder ? { toolOrder: config.toolOrder } : {}),
  })
  ctx.plugin(ToolRuntime, config.tools || {})
  ctx.plugin(AgentRegistry)
  ctx.plugin(applyLlmRetry)
  ctx.plugin(LocalJobRegistry, config.jobs || {})
  if (dshHome !== undefined) {
    ctx.plugin(ShellEnvRegistry, { dshHome })
  }
  if (config.toolBash !== false) {
    ctx.plugin(applyToolBash, config.toolBash || {})
  }
  ctx.plugin(AgentLoop, {
    agents: [],
    ...(config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {}),
  })
}

export default { applySpine }
