import {
  createLogger,
  getEnvConfig,
  initDriveClient,
  listFolderContents,
  type DriveClient,
  type DriveFile,
} from '@transcriptor/shared';
import type { EventFolder } from '@transcriptor/shared';

const logger = createLogger('yulieth:driveWatcher');

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'];
const VOTING_EXTENSIONS = ['.xlsx', '.csv', '.json'];
const POLL_INTERVAL_MS = 60_000; // 1 minute

let pollTimer: ReturnType<typeof setInterval> | null = null;
let driveClient: DriveClient | null = null;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function getDriveClient(): DriveClient {
  if (!driveClient) {
    const env = getEnvConfig();
    driveClient = initDriveClient({
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
      redirectUri: env.googleRedirectUri,
    });
  }
  return driveClient;
}

export function startWatching(rootFolderId: string): void {
  logger.info(`Starting Drive watcher on folder: ${rootFolderId}`);

  // Initial check
  void checkForNewEvents(rootFolderId);

  pollTimer = setInterval(() => {
    void checkForNewEvents(rootFolderId);
  }, POLL_INTERVAL_MS);
}

export function stopWatching(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Drive watcher stopped');
  }
}

export async function checkForNewEvents(rootFolderId: string): Promise<EventFolder[]> {
  logger.info('Checking for new event folders...');
  const drive = getDriveClient();
  const folders = await listFolderContents(drive, rootFolderId);

  const eventFolders: EventFolder[] = [];

  for (const folder of folders) {
    if (folder.mimeType === 'application/vnd.google-apps.folder') {
      const contents = await listFolderContents(drive, folder.id);

      const audioFiles = contents
        .filter((f) => AUDIO_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
        .map((f) => f.id);

      const votingFiles = contents
        .filter((f) => VOTING_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
        .map((f) => f.id);

      eventFolders.push({
        folderId: folder.id,
        folderName: folder.name,
        audioFiles,
        votingFiles,
        path: `/${folder.name}`,
      });
    }
  }

  logger.info(`Found ${eventFolders.length} event folders`);
  return eventFolders;
}

export function validateEventFolder(folder: EventFolder): ValidationResult {
  const errors: string[] = [];

  if (folder.audioFiles.length === 0) {
    errors.push('No audio files found in event folder');
  }

  try {
    extractEventInfo(folder.folderName);
  } catch (err) {
    errors.push(`Invalid folder name format: ${(err as Error).message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function extractEventInfo(folderName: string): { date: Date; buildingName: string } {
  // Expected format: "YYYY-MM-DD_BuildingName" or "BuildingName_YYYY-MM-DD"
  const datePattern = /(\d{4}-\d{2}-\d{2})/;
  const dateMatch = folderName.match(datePattern);

  if (!dateMatch) {
    throw new Error(`Could not extract date from folder name: ${folderName}`);
  }

  const date = new Date(dateMatch[1]);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date in folder name: ${dateMatch[1]}`);
  }

  const buildingName = folderName
    .replace(datePattern, '')
    .replace(/^[_\-\s]+|[_\-\s]+$/g, '')
    .trim();

  if (!buildingName) {
    throw new Error(`Could not extract building name from folder name: ${folderName}`);
  }

  return { date, buildingName };
}
