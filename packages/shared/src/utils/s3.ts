/**
 * S3-compatible Object Storage Client (Linode Object Storage)
 *
 * Provides upload/download utilities for job output files.
 * Agents push results to S3 after completion; the dashboard
 * reads from S3 when local files are not available.
 *
 * Client is lazy-initialized — no crash if credentials are missing.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getEnvConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('shared:s3');

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const cfg = getEnvConfig();
  if (!cfg.s3AccessKey || !cfg.s3SecretKey) {
    throw new Error('S3 credentials not configured (S3_ACCESS_KEY / S3_SECRET_KEY)');
  }
  _client = new S3Client({
    region: 'us-east-1',
    endpoint: `https://${cfg.s3Endpoint}`,
    credentials: {
      accessKeyId: cfg.s3AccessKey,
      secretAccessKey: cfg.s3SecretKey,
    },
    forcePathStyle: false, // Linode uses virtual-hosted style
  });
  logger.info(`S3 client initialized → ${cfg.s3Bucket} @ ${cfg.s3Endpoint}`);
  return _client;
}

function s3Key(subpath: string): string {
  const cfg = getEnvConfig();
  return `${cfg.s3Prefix}/jobs/${subpath}`;
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ── Public API ──────────────────────────────────────────────

/**
 * Upload all files from a local directory to S3 under jobs/<jobId>/<stage>/
 * This is the atomic unit — uploads a complete set of files for one agent stage.
 */
export async function uploadJobStage(
  jobId: string,
  stage: 'transcript' | 'sections' | 'redacted' | 'output',
  localDir: string,
): Promise<string[]> {
  const client = getClient();
  const cfg = getEnvConfig();
  const uploaded: string[] = [];

  const files = readdirSync(localDir).filter(f => {
    const fullPath = path.join(localDir, f);
    return statSync(fullPath).isFile();
  });

  for (const file of files) {
    const filePath = path.join(localDir, file);
    const key = s3Key(`${jobId}/${stage}/${file}`);
    const body = readFileSync(filePath);

    await client.send(new PutObjectCommand({
      Bucket: cfg.s3Bucket,
      Key: key,
      Body: body,
      ContentType: getMimeType(file),
    }));

    uploaded.push(key);
  }

  logger.info(`Uploaded ${uploaded.length} files to S3: jobs/${jobId}/${stage}/`);
  return uploaded;
}

/**
 * Download a single file from S3.
 * Returns null if file doesn't exist.
 */
export async function downloadJobFile(
  jobId: string,
  subpath: string,
): Promise<Buffer | null> {
  try {
    const client = getClient();
    const cfg = getEnvConfig();
    const key = s3Key(`${jobId}/${subpath}`);

    const response = await client.send(new GetObjectCommand({
      Bucket: cfg.s3Bucket,
      Key: key,
    }));

    if (!response.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * List files under a job prefix (e.g. 'redacted' or 'output').
 * Returns an array of filenames (just the basename, not full key).
 */
export async function listJobFiles(
  jobId: string,
  prefix: string,
): Promise<string[]> {
  try {
    const client = getClient();
    const cfg = getEnvConfig();
    const fullPrefix = s3Key(`${jobId}/${prefix}/`);

    const response = await client.send(new ListObjectsV2Command({
      Bucket: cfg.s3Bucket,
      Prefix: fullPrefix,
    }));

    if (!response.Contents) return [];
    return response.Contents
      .map(obj => obj.Key ? path.basename(obj.Key) : '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a stage exists in S3 for a given job.
 */
export async function jobStageExists(
  jobId: string,
  stage: string,
): Promise<boolean> {
  const files = await listJobFiles(jobId, stage);
  return files.length > 0;
}
