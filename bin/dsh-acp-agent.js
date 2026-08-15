#!/usr/bin/env node
/**
 * DSH ACP stdio bridge — standalone executable.
 *
 * Launch this file as an ACP agent from your editor (Zed, VS Code ACP, ...).
 * It reads newline-delimited JSON-RPC from stdin, forwards each request to
 * the DSH ACP gateway loopback endpoint, and writes responses plus
 * `session/update` notifications (single-line JSON) to stdout. Logs go to
 * stderr only.
 *
 * Endpoint resolution order (first reachable wins, stale entries fail over):
 *   1. `DSH_ACP_URL` environment variable
 *   2. `~/.dsh/acp/endpoint` file (written by the plugin when it can)
 *   3. `http://127.0.0.1:3080` (default DSH web port)
 */
import { attachBridge, resolveEndpoints } from '../src/bridge.js'

attachBridge(process.stdin, process.stdout, resolveEndpoints())
