import type { AppToolDefinition } from './types.js';
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; }
export interface McpConnection { id: string; agentId: string; name: string; url: string; hasToken: boolean; toolCount: number; status: 'needs_refresh' | 'ready' | 'error'; error?: string; updatedAt: string; }
export interface McpInput { agentId: string; name: string; url: string; token?: string; }
export type McpToolDefinition = AppToolDefinition;
