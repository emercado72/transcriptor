import { google, type drive_v3 } from 'googleapis';
import { createLogger } from './logger.js';

const logger = createLogger('googleDrive');

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
}

export type DriveClient = drive_v3.Drive;

export function initDriveClient(credentials: GoogleCredentials): DriveClient {
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri,
  );

  if (credentials.refreshToken) {
    oauth2Client.setCredentials({ refresh_token: credentials.refreshToken });
  }

  return google.drive({ version: 'v3', auth: oauth2Client });
}

export async function listFolderContents(
  drive: DriveClient,
  folderId: string,
): Promise<DriveFile[]> {
  logger.info(`Listing folder contents: ${folderId}`);
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, createdTime)',
    orderBy: 'name',
  });

  return (response.data.files || []).map((f) => ({
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: parseInt(f.size || '0', 10),
    createdTime: f.createdTime || '',
  }));
}

export async function downloadFile(
  drive: DriveClient,
  fileId: string,
  destPath: string,
): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  logger.info(`Downloading file: ${fileId} → ${destPath}`);

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );

  return new Promise((resolve, reject) => {
    const dest = createWriteStream(destPath);
    (response.data as NodeJS.ReadableStream)
      .pipe(dest)
      .on('finish', () => {
        logger.info(`Download complete: ${destPath}`);
        resolve();
      })
      .on('error', reject);
  });
}

export async function uploadFile(
  drive: DriveClient,
  sourcePath: string,
  folderId: string,
  fileName: string,
): Promise<string> {
  const { createReadStream } = await import('node:fs');
  logger.info(`Uploading file: ${fileName} → folder ${folderId}`);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      body: createReadStream(sourcePath),
    },
    fields: 'id',
  });

  const fileId = response.data.id || '';
  logger.info(`Upload complete: ${fileId}`);
  return fileId;
}

export async function createFolder(
  drive: DriveClient,
  parentId: string,
  folderName: string,
): Promise<string> {
  logger.info(`Creating folder: ${folderName} in ${parentId}`);

  const response = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  const folderId = response.data.id || '';
  logger.info(`Folder created: ${folderId}`);
  return folderId;
}
