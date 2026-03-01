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
