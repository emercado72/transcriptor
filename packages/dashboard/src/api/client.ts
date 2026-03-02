import type { AgentStatus, AgentStats, PipelineOverview } from '../types/index.js';

const BASE_URL = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<{ status: string; agent: string; timestamp: string }> {
  return fetchJson('/health');
}

export async function getAgentStatuses(): Promise<AgentStatus[]> {
  return fetchJson('/agents/status');
}

export async function getAgentStats(): Promise<AgentStats[]> {
  return fetchJson('/agents/stats');
}

export async function getPipelineOverview(): Promise<PipelineOverview> {
  return fetchJson('/pipeline/overview');
}

export async function sendChatMessage(agentId: string, message: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/agents/${agentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(err || `API error: ${res.status}`);
  }
  const data = await res.json() as { reply: string };
  return data.reply;
}
