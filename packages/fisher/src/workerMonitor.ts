/**
 * Fisher - Worker Monitor
 *
 * Heartbeat + resource monitoring for remote GPU workers.
 * Polls each worker periodically via SSH to collect:
 *   - Gloria health (HTTP)
 *   - GPU utilization, VRAM, temperature (nvidia-smi)
 *   - CPU, RAM, disk usage
 *   - Pipeline job status
 *   - Uptime
 */

import { execSync } from 'node:child_process';
import { createLogger } from '@transcriptor/shared';

const logger = createLogger('fisher:monitor');

export interface GpuMetrics {
  name: string;
  utilizationPct: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number;
  powerW: number;
}

export interface SystemMetrics {
  cpuPct: number;
  ramUsedMb: number;
  ramTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  uptimeSeconds: number;
}

export interface WorkerHeartbeat {
  ip: string;
  instanceId: number;
  label: string;
  timestamp: string;
  gloriaHealthy: boolean;
  gpu: GpuMetrics | null;
  system: SystemMetrics | null;
  pipelineJobs: PipelineJobSummary[];
  lastError: string | null;
  consecutiveFailures: number;
}

export interface PipelineJobSummary {
  jobId: string;
  status: string;
  clientName: string;
  currentStage: string;
}

const heartbeats: Map<number, WorkerHeartbeat> = new Map();
const heartbeatIntervals: Map<number, ReturnType<typeof setInterval>> = new Map();

export function getHeartbeat(instanceId: number): WorkerHeartbeat | null {
  return heartbeats.get(instanceId) || null;
}

export function getAllHeartbeats(): WorkerHeartbeat[] {
  return Array.from(heartbeats.values());
}

export function startHeartbeat(
  instanceId: number,
  ip: string,
  label: string,
  intervalMs: number = 30_000,
): void {
  if (heartbeatIntervals.has(instanceId)) return;

  logger.info('Starting heartbeat for ' + label + ' (' + ip + ')');

  // Initial heartbeat
  void collectHeartbeat(instanceId, ip, label);

  const interval = setInterval(() => {
    void collectHeartbeat(instanceId, ip, label);
  }, intervalMs);

  heartbeatIntervals.set(instanceId, interval);
}

export function stopHeartbeat(instanceId: number): void {
  const interval = heartbeatIntervals.get(instanceId);
  if (interval) {
    clearInterval(interval);
    heartbeatIntervals.delete(instanceId);
    logger.info('Heartbeat stopped for instance ' + instanceId);
  }
}

export function stopAllHeartbeats(): void {
  for (const [id] of heartbeatIntervals) stopHeartbeat(id);
}

async function collectHeartbeat(instanceId: number, ip: string, label: string): Promise<void> {
  const prev = heartbeats.get(instanceId);
  const hb: WorkerHeartbeat = {
    ip,
    instanceId,
    label,
    timestamp: new Date().toISOString(),
    gloriaHealthy: false,
    gpu: null,
    system: null,
    pipelineJobs: [],
    lastError: null,
    consecutiveFailures: prev?.consecutiveFailures || 0,
  };

  try {
    // Gloria health
    try {
      const res = await fetch('http://' + ip + ':3001/api/health', {
        signal: AbortSignal.timeout(5000),
      });
      hb.gloriaHealthy = res.ok;
    } catch {
      hb.gloriaHealthy = false;
    }

    // SSH metrics (one command, parse all)
    const metrics = execSync(
      'ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@' + ip + ' "' +
        'echo GPU_START && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null && echo GPU_END; ' +
        'echo SYS_START && free -m | grep Mem && echo DISK && df -BG / | tail -1 && echo UPTIME && cat /proc/uptime && echo SYS_END; ' +
        'echo JOBS_START && redis-cli SMEMBERS transcriptor:active_jobs 2>/dev/null && echo JOBS_END' +
      '"',
      { encoding: 'utf-8', timeout: 15_000 },
    );

    // Parse GPU
    const gpuMatch = metrics.match(/GPU_START\n(.*)\nGPU_END/);
    if (gpuMatch && gpuMatch[1]) {
      const parts = gpuMatch[1].split(',').map(s => s.trim());
      if (parts.length >= 6) {
        hb.gpu = {
          name: parts[0],
          utilizationPct: parseFloat(parts[1]) || 0,
          memoryUsedMb: parseFloat(parts[2]) || 0,
          memoryTotalMb: parseFloat(parts[3]) || 0,
          temperatureC: parseFloat(parts[4]) || 0,
          powerW: parseFloat(parts[5]) || 0,
        };
      }
    }

    // Parse system
    const sysMatch = metrics.match(/SYS_START\n([\s\S]*?)SYS_END/);
    if (sysMatch) {
      const lines = sysMatch[1].trim().split('\n');
      const memLine = lines[0]; // Mem: total used free ...
      const memParts = memLine.split(/\s+/);
      const diskLine = lines.find(l => l.includes('/dev/'));
      const uptimeLine = lines[lines.length - 1];

      hb.system = {
        ramTotalMb: parseInt(memParts[1]) || 0,
        ramUsedMb: parseInt(memParts[2]) || 0,
        cpuPct: 0, // would need top/mpstat, skip for now
        diskUsedGb: 0,
        diskTotalGb: 0,
        uptimeSeconds: parseFloat(uptimeLine?.split(' ')[0] || '0'),
      };

      if (diskLine) {
        const diskParts = diskLine.split(/\s+/);
        hb.system.diskTotalGb = parseFloat(diskParts[1]) || 0;
        hb.system.diskUsedGb = parseFloat(diskParts[2]) || 0;
      }
    }

    // Parse jobs
    const jobsMatch = metrics.match(/JOBS_START\n([\s\S]*?)JOBS_END/);
    if (jobsMatch) {
      const jobIds = jobsMatch[1].trim().split('\n').filter(Boolean);
      for (const jobId of jobIds) {
        try {
          const status = execSync(
            'ssh -o ConnectTimeout=5 root@' + ip + ' "redis-cli GET transcriptor:pipeline:' + jobId + '"',
            { encoding: 'utf-8', timeout: 10_000 },
          ).trim();
          if (status) {
            const data = JSON.parse(status);
            hb.pipelineJobs.push({
              jobId,
              status: data.status,
              clientName: data.clientName || '',
              currentStage: data.status,
            });
          }
        } catch { /* skip */ }
      }
    }

    hb.consecutiveFailures = 0;
  } catch (err) {
    hb.lastError = (err as Error).message;
    hb.consecutiveFailures++;
    if (hb.consecutiveFailures <= 3) {
      logger.warn('Heartbeat failed for ' + label + ' (' + hb.consecutiveFailures + '): ' + hb.lastError);
    }
  }

  heartbeats.set(instanceId, hb);
}
