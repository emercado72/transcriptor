import type { AgentStatus, AgentStats, PipelineOverview } from '../types/index.js';
import type { ReviewItem, ReviewSession, ReviewItemStatus } from '../types/review.js';

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    const res = await fetch(`${BASE_URL}/agents/${agentId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(err || `API error: ${res.status}`);
    }
    const data = await res.json() as { reply: string };
    return data.reply;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out after 2 minutes. The agent may be processing a complex query — try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Review API ──

export async function startReview(jobId: string): Promise<{ status: string; jobId: string }> {
  const res = await fetch(`${BASE_URL}/review/start/${jobId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ status: string; jobId: string }>;
}

export async function getReviewSession(jobId: string): Promise<Omit<ReviewSession, 'markdownContent'>> {
  return fetchJson(`/review/${jobId}`);
}

export async function getReviewItems(jobId: string): Promise<{ items: ReviewItem[]; stats: ReviewSession['stats'] }> {
  return fetchJson(`/review/${jobId}/items`);
}

export async function getReviewDocument(jobId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/review/${jobId}/document`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.text();
}

export async function updateReviewItemStatus(
  jobId: string,
  itemId: string,
  status: ReviewItemStatus,
): Promise<{ item: ReviewItem }> {
  const res = await fetch(`${BASE_URL}/review/${jobId}/items/${itemId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ item: ReviewItem }>;
}

export async function applyReviewFix(
  jobId: string,
  itemId: string,
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${BASE_URL}/review/${jobId}/items/${itemId}/apply`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ success: boolean; message: string }>;
}

export async function saveReviewDocument(
  jobId: string,
  markdown: string,
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${BASE_URL}/review/${jobId}/document`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ success: boolean; message: string }>;
}

export async function exportReviewDocument(
  jobId: string,
): Promise<{ success: boolean; message: string; docxPath?: string; pdfPath?: string }> {
  const res = await fetch(`${BASE_URL}/review/${jobId}/export`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ success: boolean; message: string; docxPath?: string; pdfPath?: string }>;
}

export interface OutputFile {
  name: string;
  ext: string;
  size: number;
  url: string;
}

export async function getOutputFiles(jobId: string): Promise<{ files: OutputFile[] }> {
  return fetchJson(`/review/${jobId}/files`);
}

export function getDownloadUrl(jobId: string, filename: string): string {
  return `${BASE_URL}/review/${jobId}/download/${encodeURIComponent(filename)}`;
}

export function getAudioSegmentUrl(jobId: string, segmentFile: string): string {
  return `${BASE_URL}/review/${jobId}/audio/${segmentFile}`;
}

export function getRawAudioUrl(jobId: string, part: number = 0): string {
  return `${BASE_URL}/review/${jobId}/audio-playback?part=${part}`;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface AudioFileInfo {
  file: string;
  startSec: number;
  endSec: number;
}

export async function getTranscriptSegments(jobId: string): Promise<{
  segments: TranscriptSegment[];
  audioFiles: AudioFileInfo[];
}> {
  return fetchJson(`/review/${jobId}/transcript-segments`);
}
