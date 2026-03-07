import { useState, useEffect } from 'react';
import type { AgentNode } from '../types/index.js';

interface WorkerHeartbeat {
  ip: string;
  instanceId: number;
  label: string;
  timestamp: string;
  gloriaHealthy: boolean;
  gpu: { name: string; utilizationPct: number; memoryUsedMb: number; memoryTotalMb: number; temperatureC: number; powerW: number } | null;
  system: { ramUsedMb: number; ramTotalMb: number; diskUsedGb: number; diskTotalGb: number; uptimeSeconds: number } | null;
  pipelineJobs: { jobId: string; status: string; clientName: string }[];
  consecutiveFailures: number;
}

interface FisherStatus {
  worker: { instanceId: number | null; ip: string | null; label: string | null; state: string; currentJobId: string | null; createdAt: string | null; error: string | null };
  config: { region?: string; instanceType?: string; labelPrefix?: string };
  backups?: { jobId: string; durationMs: number; filesBackedUp: string[] }[];
  heartbeats: WorkerHeartbeat[];
}

interface Props {
  node: AgentNode;
  onClose: () => void;
  onSwitchToChat: () => void;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

const PROVISION_STAGES = [
  { key: 'provisioning', label: 'Provisioning', desc: 'Creating Linode instance' },
  { key: 'booting', label: 'Booting', desc: 'Init script running (~5min)' },
  { key: 'rebooting', label: 'Rebooting', desc: 'Loading NVIDIA drivers' },
  { key: 'processing', label: 'Online', desc: 'Gloria responding, ready for jobs' },
] as const;

interface DiscoveredWorker {
  instanceId: number;
  label: string;
  ip: string;
  linodeStatus: string;
  gloriaHealthy: boolean;
  adopted: boolean;
}

export default function FisherQueuePanel({ node, onClose, onSwitchToChat }: Props) {
  const [status, setStatus] = useState<FisherStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ discovered: DiscoveredWorker[]; adopted: DiscoveredWorker | null } | null>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      fetch('/api/agents/fisher/status')
        .then(r => r.json())
        .then(data => { if (active) { setStatus(data); setError(null); } })
        .catch(err => { if (active) setError(err.message); });
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Tick for elapsed timer
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!status?.worker?.createdAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [status?.worker?.createdAt]);

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverResult(null);
    try {
      const res = await fetch('/api/agents/fisher/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Discovery failed');
      setDiscoverResult(data);
      if (data.adopted) {
        // Refresh status to reflect adopted worker
        const sr = await fetch('/api/agents/fisher/status');
        const sd = await sr.json();
        setStatus(sd);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const w = status?.worker;
  const hb = status?.heartbeats?.[0];

  const elapsed = w?.createdAt
    ? Math.max(0, Math.floor((now - new Date(w.createdAt).getTime()) / 1000))
    : 0;

  // Determine which stage the provisioning is at
  const stageIndex = !w ? -1
    : w.state === 'provisioning' ? 0
    : w.state === 'booting' ? 1
    : w.state === 'processing' ? 3
    : -1;

  return (
    <div style={{ width: '400px', borderLeft: '1px solid #1e293b', background: '#0f172a', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '20px' }}>{node.icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: '#e2e8f0' }}>{node.label}</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>GPU Worker Orchestrator</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#94a3b8', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}>Chat</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {error && <div style={{ color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>Error: {error}</div>}

        {/* Worker State */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Worker</div>
          {!w || !w.instanceId ? (
            <div style={{ background: '#1e293b', borderRadius: '8px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>No active workers</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>Workers are provisioned on-demand when jobs are queued</div>
              <button
                onClick={handleDiscover}
                disabled={discovering}
                style={{
                  background: '#1d4ed8', border: 'none', borderRadius: '6px', color: '#fff',
                  padding: '8px 16px', cursor: discovering ? 'wait' : 'pointer', fontSize: '12px',
                  fontWeight: 600, opacity: discovering ? 0.6 : 1,
                }}
              >
                {discovering ? 'Scanning Linode...' : 'Discover Workers'}
              </button>
              {discoverResult && (
                <div style={{ marginTop: '12px', textAlign: 'left' }}>
                  {discoverResult.adopted ? (
                    <div style={{ fontSize: '12px', color: '#22c55e', padding: '8px', background: '#16a34a15', borderRadius: '6px' }}>
                      Adopted {discoverResult.adopted.label} ({discoverResult.adopted.ip})
                    </div>
                  ) : discoverResult.discovered.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#94a3b8', padding: '8px' }}>No GPU workers found on Linode</div>
                  ) : (
                    <div style={{ fontSize: '12px' }}>
                      <div style={{ color: '#f97316', marginBottom: '6px' }}>Found {discoverResult.discovered.length} worker(s), none healthy:</div>
                      {discoverResult.discovered.map(w => (
                        <div key={w.instanceId} style={{ color: '#94a3b8', padding: '4px 0', borderTop: '1px solid #334155' }}>
                          {w.label} ({w.ip}) — {w.linodeStatus} / Gloria: {w.gloriaHealthy ? 'up' : 'down'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: '#1e293b', borderRadius: '8px', padding: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '13px' }}>{w.label}</span>
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                  background: w.state === 'processing' ? '#16a34a22' : w.state === 'error' ? '#ef444422' : '#f9731622',
                  color: w.state === 'processing' ? '#22c55e' : w.state === 'error' ? '#f87171' : w.state === 'provisioning' || w.state === 'booting' ? '#f97316' : '#94a3b8',
                }}>{w.state}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                <span>IP: {w.ip || '...'}</span>
                <span>Region: {status?.config?.region}</span>
                <span>Type: {status?.config?.instanceType}</span>
                {w.currentJobId && <span>Job: {w.currentJobId.slice(0,8)}...</span>}
              </div>
              {/* Elapsed timer */}
              {w.createdAt && (
                <div style={{ marginTop: '8px', fontSize: '12px', color: w.state === 'processing' ? '#a3e635' : '#f97316', fontFamily: "'SF Mono', monospace", fontWeight: 600 }}>
                  Elapsed: {formatElapsed(elapsed)}
                </div>
              )}
              {w.error && (
                <div style={{ marginTop: '8px', fontSize: '11px', color: '#f87171', background: '#ef444410', padding: '6px 8px', borderRadius: '4px' }}>
                  {w.error}
                </div>
              )}
              {w.state === 'error' && (
                <button
                  onClick={handleDiscover}
                  disabled={discovering}
                  style={{
                    marginTop: '10px', background: '#1d4ed8', border: 'none', borderRadius: '6px', color: '#fff',
                    padding: '6px 14px', cursor: discovering ? 'wait' : 'pointer', fontSize: '11px',
                    fontWeight: 600, opacity: discovering ? 0.6 : 1, width: '100%',
                  }}
                >
                  {discovering ? 'Scanning Linode...' : 'Discover Workers'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Provisioning Progress */}
        {w && w.instanceId && stageIndex >= 0 && stageIndex < 3 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Provisioning Progress</div>
            <div style={{ background: '#1e293b', borderRadius: '8px', padding: '12px' }}>
              {PROVISION_STAGES.map((stage, i) => {
                const isDone = i < stageIndex;
                const isCurrent = i === stageIndex;
                const isPending = i > stageIndex;
                return (
                  <div key={stage.key} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: i < PROVISION_STAGES.length - 1 ? '10px' : 0 }}>
                    <div style={{
                      width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px',
                      background: isDone ? '#16a34a' : isCurrent ? '#f97316' : '#334155',
                      color: isDone || isCurrent ? '#fff' : '#64748b',
                      ...(isCurrent ? { animation: 'none', boxShadow: '0 0 8px #f97316' } : {}),
                    }}>
                      {isDone ? '\u2713' : i + 1}
                    </div>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: isDone ? '#22c55e' : isCurrent ? '#f97316' : isPending ? '#64748b' : '#94a3b8' }}>
                        {stage.label}
                      </div>
                      <div style={{ fontSize: '10px', color: '#64748b' }}>{stage.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* GPU Metrics */}
        {hb && hb.gpu && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>GPU</div>
            <div style={{ background: '#1e293b', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>{hb.gpu.name}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
                <div>
                  <div style={{ color: '#64748b', fontSize: '10px' }}>Utilization</div>
                  <div style={{ color: hb.gpu.utilizationPct > 80 ? '#22c55e' : '#e2e8f0', fontWeight: 600 }}>{hb.gpu.utilizationPct}%</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: '10px' }}>VRAM</div>
                  <div style={{ color: '#e2e8f0' }}>{hb.gpu.memoryUsedMb}MB / {hb.gpu.memoryTotalMb}MB</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: '10px' }}>Temperature</div>
                  <div style={{ color: hb.gpu.temperatureC > 80 ? '#f87171' : '#e2e8f0' }}>{hb.gpu.temperatureC}C</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: '10px' }}>Power</div>
                  <div style={{ color: '#e2e8f0' }}>{hb.gpu.powerW}W</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* System Metrics */}
        {hb && hb.system && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>System</div>
            <div style={{ background: '#1e293b', borderRadius: '8px', padding: '12px', fontSize: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div>
                <div style={{ color: '#64748b', fontSize: '10px' }}>RAM</div>
                <div style={{ color: '#e2e8f0' }}>{hb.system.ramUsedMb}MB / {hb.system.ramTotalMb}MB</div>
              </div>
              <div>
                <div style={{ color: '#64748b', fontSize: '10px' }}>Disk</div>
                <div style={{ color: '#e2e8f0' }}>{hb.system.diskUsedGb}G / {hb.system.diskTotalGb}G</div>
              </div>
              <div>
                <div style={{ color: '#64748b', fontSize: '10px' }}>Uptime</div>
                <div style={{ color: '#e2e8f0' }}>{formatUptime(hb.system.uptimeSeconds)}</div>
              </div>
              <div>
                <div style={{ color: '#64748b', fontSize: '10px' }}>Gloria</div>
                <div style={{ color: hb.gloriaHealthy ? '#22c55e' : '#f87171' }}>{hb.gloriaHealthy ? 'Healthy' : 'Down'}</div>
              </div>
            </div>
          </div>
        )}

        {/* Pipeline Jobs */}
        {hb && hb.pipelineJobs.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Jobs on Worker</div>
            {hb.pipelineJobs.map((job, i) => (
              <div key={i} style={{ background: '#1e293b', borderRadius: '8px', padding: '10px', marginBottom: '6px', fontSize: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{job.clientName || job.jobId.slice(0,8)}</span>
                  <span style={{ color: '#94a3b8' }}>{job.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Backup History */}
        {status && status.backups && status.backups.length > 0 && (
          <div>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Backup History</div>
            {status.backups.map((b, i) => (
              <div key={i} style={{ background: '#1e293b', borderRadius: '8px', padding: '10px', marginBottom: '6px', fontSize: '12px' }}>
                <span style={{ color: '#e2e8f0' }}>{b.jobId.slice(0,8)}...</span>
                <span style={{ color: '#64748b', marginLeft: '8px' }}>{(b.durationMs / 1000).toFixed(0)}s</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
