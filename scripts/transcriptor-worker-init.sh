#!/bin/bash
# ============================================================================
# transcriptor-worker-init.sh
# Bootstrap a Linode GPU instance as a transcriptor worker.
#
# Target: Ubuntu 24.04 LTS on Linode GPU (RTX 4000 Ada / 20GB VRAM)
#
# Usage:
#   1. Create Linode with Ubuntu 24.04, GPU plan
#   2. SSH in: bash transcriptor-worker-init.sh
#   3. Reboot once for NVIDIA kernel modules
#
# Runtime: ~5-7 minutes (pre-built venv downloaded from S3)
# ============================================================================

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

LOG="/root/transcriptor-worker-init.log"
exec > >(tee -a "$LOG") 2>&1

T0=$(date +%s)
echo "============================================"
echo "  TRANSCRIPTOR WORKER INIT"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"

# -- CONFIG -------------------------------------------
TRANSCRIPTOR_REPO="https://github.com/emercado72/transcriptor.git"
TRANSCRIPTOR_BRANCH="main"

# Linode Object Storage (S3-compatible) -- assets + secrets
S3_BUCKET="t2025-registry"
S3_PREFIX="transcriptor"
S3_ENDPOINT="us-east-1.linodeobjects.com"
S3_ACCESS_KEY="VSIZ8QWACLHI0FQ48J5B"
S3_SECRET_KEY="0bU3auwvLU0TdogzZVvmNf3tZaJ7d5xddb0KlRAI"

# Public tarballs (downloaded via wget, no auth needed)
S3_PUBLIC_BASE="https://${S3_BUCKET}.${S3_ENDPOINT}/${S3_PREFIX}"
VENV_TARBALL="transcriptor-venv.tar.gz"
NODE_TARBALL="transcriptor-node_modules.tar.gz"
AUDIO_TRANSCRIBER_TARBALL="audio-transcriber.tar.gz"

# Private secrets (downloaded via s3cmd, auth required)
S3_SECRETS="s3://${S3_BUCKET}/${S3_PREFIX}"

SSH_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHWFtDduixicOHbHalb5A9XWI4x/dl2Op7l25CyD2iG+ transcriptor-pipeline"

PROJECT_ROOT="/opt/transcriptor"
TRANSCRIPTOR_DIR="$PROJECT_ROOT/transcriptor"
AUDIO_TRANSCRIBER_DIR="$PROJECT_ROOT/audio-transcriber"
VENV_DIR="$PROJECT_ROOT/venv"

# -- [1/8] System packages + NVIDIA drivers ----------
echo ""
echo "=== [1/8] System packages + NVIDIA drivers ==="
apt-get update -qq
apt-get install -y -qq \
  git curl wget ffmpeg \
  python3-pip python3-venv python3-dev \
  software-properties-common build-essential \
  redis-server ubuntu-drivers-common s3cmd

# NVIDIA GPU driver (auto-detect) + utils for nvidia-smi
ubuntu-drivers install --gpgpu || apt-get install -y nvidia-driver-570-server
apt-get install -y -qq nvidia-utils-570-server

# Configure s3cmd for private assets
cat > /root/.s3cfg << EOF
[default]
access_key = $S3_ACCESS_KEY
secret_key = $S3_SECRET_KEY
host_base = $S3_ENDPOINT
host_bucket = $S3_ENDPOINT
use_https = True
signature_v2 = False
EOF

echo "  OK System packages + NVIDIA drivers + s3cmd"

# -- [2/8] CUDA toolkit ------------------------------
echo ""
echo "=== [2/8] CUDA toolkit ==="
apt-get install -y -qq nvidia-cuda-toolkit
echo "  OK CUDA toolkit"

# -- [3/8] Node.js 20 + pnpm -------------------------
echo ""
echo "=== [3/8] Node.js 20 + pnpm ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g pnpm@10
echo "  OK Node $(node --version), pnpm $(pnpm --version)"

# -- [4/8] SSH key + swap ----------------------------
echo ""
echo "=== [4/8] SSH key + swap ==="
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -q "transcriptor-pipeline" /root/.ssh/authorized_keys 2>/dev/null || \
  echo "$SSH_PUBKEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# Add 16GB swap (prevents OOM kills during transcription)
if [ ! -f /swapfile ]; then
  fallocate -l 16G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  OK 16GB swap created"
else
  echo "  OK swap already exists"
fi
echo "  OK SSH key + swap"

# -- [5/8] Clone project + audio-transcriber ---------
echo ""
echo "=== [5/8] Clone transcriptor + audio-transcriber ==="
mkdir -p "$PROJECT_ROOT/data/jobs" "$PROJECT_ROOT/credentials"

if [ -d "$TRANSCRIPTOR_DIR/.git" ]; then
  cd "$TRANSCRIPTOR_DIR" && git pull origin "$TRANSCRIPTOR_BRANCH"
else
  git clone --branch "$TRANSCRIPTOR_BRANCH" "$TRANSCRIPTOR_REPO" "$TRANSCRIPTOR_DIR"
fi

# Audio-transcriber: download from S3 (not in git)
if [ ! -f "$AUDIO_TRANSCRIBER_DIR/main.py" ]; then
  echo "  Downloading audio-transcriber..."
  cd "$PROJECT_ROOT"
  wget -q --show-progress -O "$AUDIO_TRANSCRIBER_TARBALL" "$S3_PUBLIC_BASE/$AUDIO_TRANSCRIBER_TARBALL"
  tar xzf "$AUDIO_TRANSCRIBER_TARBALL"
  rm -f "$AUDIO_TRANSCRIBER_TARBALL"
  echo "  OK audio-transcriber downloaded"
else
  echo "  OK audio-transcriber already exists"
fi
echo "  OK Project cloned"

# -- [6/8] Download pre-built venv -------------------
echo ""
echo "=== [6/8] Download pre-built Python venv (3.3 GB) ==="
if [ -d "$VENV_DIR/lib" ]; then
  echo "  Venv already exists, skipping download"
else
  cd "$PROJECT_ROOT"
  echo "  Downloading venv tarball..."
  wget -q --show-progress -O "$VENV_TARBALL" "$S3_PUBLIC_BASE/$VENV_TARBALL"
  echo "  Extracting..."
  tar xzf "$VENV_TARBALL"
  rm -f "$VENV_TARBALL"
  echo "  OK Python venv ready ($(du -sh $VENV_DIR | awk '{print $1}'))"
fi

# -- [7/8] Download pre-built node_modules -----------
echo ""
echo "=== [7/8] Download pre-built node_modules + dist (60 MB) ==="
cd "$TRANSCRIPTOR_DIR"
if [ -d "node_modules/.pnpm" ]; then
  echo "  node_modules already exists, skipping"
else
  echo "  Downloading..."
  wget -q --show-progress -O "$NODE_TARBALL" "$S3_PUBLIC_BASE/$NODE_TARBALL"
  echo "  Extracting..."
  tar xzf "$NODE_TARBALL"
  rm -f "$NODE_TARBALL"
  echo "  OK node_modules + dist ready"
fi

# -- [8/8] Secrets + systemd service -----------------
echo ""
echo "=== [8/8] Secrets + Gloria service ==="

# Redis
systemctl enable redis-server
systemctl start redis-server

# Download secrets from S3 (private, requires s3cmd auth)
echo "  Downloading secrets from S3..."
s3cmd get "$S3_SECRETS/env.local" "$TRANSCRIPTOR_DIR/.env.local" --force 2>/dev/null && \
  echo "  OK .env.local downloaded" || \
  echo "  WARN .env.local not found in S3 -- create manually"

s3cmd get "$S3_SECRETS/google-credentials.json" "$PROJECT_ROOT/google-credentials.json" --force 2>/dev/null && \
  echo "  OK google-credentials.json downloaded" || \
  echo "  WARN google-credentials.json not found in S3"

# Gloria systemd service (auto-restart on crash, survives SSH disconnect)
cat > /etc/systemd/system/gloria.service << EOF
[Unit]
Description=Gloria Review Server - Transcriptor Pipeline
After=redis-server.service network.target

[Service]
Type=simple
WorkingDirectory=$TRANSCRIPTOR_DIR
ExecStart=/usr/bin/node packages/gloria/dist/reviewServer.js
Restart=on-failure
RestartSec=5
StandardOutput=file:/tmp/gloria.log
StandardError=file:/tmp/gloria.log
Environment=NODE_ENV=production
Environment=RUNTIME_MODE=gpu-worker

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gloria
echo "  OK Gloria systemd service installed (starts after reboot)"

# Cleanup
apt-get clean && rm -rf /var/lib/apt/lists/* /root/.cache/pip /tmp/*.tar.gz

# -- Summary ------------------------------------------
T1=$(date +%s)
ELAPSED=$(( T1 - T0 ))
echo ""
echo "============================================"
echo "  SETUP COMPLETE in ${ELAPSED}s (~$(( ELAPSED / 60 ))m)"
echo "============================================"
echo "  OS:     $(lsb_release -ds)"
echo "  Node:   $(node --version)  pnpm: $(pnpm --version)"
echo "  Python: $($VENV_DIR/bin/python3 --version 2>/dev/null || python3 --version)"
echo "  Redis:  $(redis-cli --version 2>/dev/null | awk '{print $2}')"
echo "  Swap:   $(free -h | grep Swap | awk '{print $2}')"
echo "  Disk:   $(df -h / | tail -1 | awk '{print $3 " / " $2}')"
echo ""
echo "  NEXT STEPS:"
echo "  1. reboot"
echo "  2. nvidia-smi  (verify GPU)"
echo "  3. systemctl start gloria"
echo "  4. Dashboard at http://<IP>:3001"
echo "============================================"
