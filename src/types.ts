/**
 * ACP v1 wire types used by the gateway. These mirror the stable schema
 * (`schema/v1/schema.json`) for the parts the gateway speaks; fields not
 * referenced here stay untyped (`any`) on purpose.
 *
 * @module dsh-acp-gateway/types
 */

/** ACP stop reasons (schema StopReason). */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

/** ACP tool kinds (schema ToolKind). */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

/** A tool-call status. */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** A file location a tool accesses (schema ToolCallLocation). */
export interface ToolCallLocation {
  path: string
  line?: number
}

/** A diff content block (schema ToolCallContent diff variant). */
export interface DiffContent {
  type: 'diff'
  path: string
  oldText?: string | null
  newText: string
}

/** A standard content wrapper (schema Content). */
export interface ContentWrapper {
  type: 'content'
  content: { type: 'text' | 'image'; text?: string }
}

/** One config option value (schema ConfigOptionValue). */
export interface ConfigOptionValue {
  value: string
  name: string
  description?: string
}

/** One session config option (schema ConfigOption). */
export interface ConfigOption {
  id: string
  name: string
  description?: string
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | (string & {})
  type: 'select' | 'boolean'
  currentValue: string | boolean
  options?: ConfigOptionValue[]
}

/** A plan entry (schema PlanEntry). */
export interface PlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/** The union of session updates the gateway emits. */
export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content?: { type: 'text'; text: string }; stopReason?: StopReason }
  | { sessionUpdate: 'agent_thought_chunk'; messageId: string; content?: { type: 'text'; text: string } }
  | { sessionUpdate: 'user_message_chunk'; messageId: string; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: ToolKind; status: ToolCallStatus; rawInput?: any; locations?: ToolCallLocation[]; _meta?: any }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; title?: string; kind?: ToolKind; status?: ToolCallStatus; content?: (ContentWrapper | DiffContent)[]; rawInput?: any; rawOutput?: any; locations?: ToolCallLocation[]; _meta?: any }
  | { sessionUpdate: 'usage_update'; used?: number; size?: number }
  | { sessionUpdate: 'available_commands_update'; availableCommands: { name: string; description: string; input?: { hint?: string } }[] }
  | { sessionUpdate: 'current_mode_update'; modeId: string }
  | { sessionUpdate: 'config_option_update'; configOptions: ConfigOption[] }
  | { sessionUpdate: 'session_info_update'; title?: string; updatedAt?: string }

/** A session/update notification. */
export interface SessionUpdateNotification {
  jsonrpc: '2.0'
  method: 'session/update'
  params: { sessionId: string; update: SessionUpdate }
}
