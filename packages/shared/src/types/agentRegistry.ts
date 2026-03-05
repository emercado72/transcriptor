/**
 * Agent Registry Protocol
 *
 * Each agent announces itself to the Supervisor via Redis on startup.
 * The manifest describes identity, capabilities, tools, and callbacks.
 * The Supervisor reads these to understand what each agent can do
 * and how to invoke it.
 */

export interface AgentManifest {
  agentId: string;
  name: string;
  description: string;
  version: string;
  status: AgentRuntimeStatus;
  registeredAt: string;
  lastHeartbeat: string;
  capabilities: AgentCapability[];
  tools: AgentTool[];
  callback: AgentCallback;
  healthCheck: AgentHealthCheck;
  metadata?: Record<string, any>;
}

export type AgentRuntimeStatus = 'online' | 'degraded' | 'offline';

export interface AgentCapability {
  name: string;
  description: string;
  pipelineStage?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  async: boolean;
}

export interface AgentCallback {
  type: 'redis-pubsub' | 'http';
  channel?: string;
  url?: string;
}

export interface AgentHealthCheck {
  endpoint: string;
  intervalMs: number;
}
