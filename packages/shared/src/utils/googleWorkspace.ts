/**
 * Google Workspace Adapter — Drive, Docs, Sheets, Calendar, Gmail
 *
 * Supports two auth modes:
 *   1. Service Account (preferred for server): set GOOGLE_SERVICE_ACCOUNT_KEY_FILE
 *   2. OAuth2 with refresh token: set GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN
 *
 * For service accounts with domain-wide delegation, also set GOOGLE_IMPERSONATE_EMAIL
 * to act as a specific user (required for Gmail and Calendar).
 */

import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { docs_v1 } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { readFileSync, existsSync } from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('googleWorkspace');

// ── Types ──

export interface GoogleWorkspaceClients {
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
  calendar: calendar_v3.Calendar;
  gmail: gmail_v1.Gmail;
}

export interface GWFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
  modifiedTime: string;
  webViewLink: string;
}

export interface GWEvent {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  location: string;
  status: string;
  htmlLink: string;
  attendees: { email: string; responseStatus: string }[];
}

export interface GWEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;
}

// ── Singleton ──

let _clients: GoogleWorkspaceClients | null = null;
let _hasOAuth2 = false;

/**
 * Initialize Google Workspace clients.
 *
 * Hybrid strategy:
 *   - If OAuth2 refresh token exists → use it for ALL services (Drive, Docs, Sheets, Calendar, Gmail).
 *     This is required for @gmail.com accounts.
 *   - If only Service Account exists → use it for Drive, Docs, Sheets (files must be shared with the SA email).
 *     Gmail/Calendar won't work unless domain-wide delegation is configured (Google Workspace only).
 *   - If both exist → OAuth2 for Gmail/Calendar, Service Account for Drive/Docs/Sheets.
 */
export function initGoogleWorkspace(): GoogleWorkspaceClients {
  if (_clients) return _clients;

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '';
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const impersonateEmail = process.env.GOOGLE_IMPERSONATE_EMAIL || '';

  // Build OAuth2 client (if credentials available)
  let oauth2Auth: InstanceType<typeof google.auth.OAuth2> | null = null;
  if (clientId && clientSecret && refreshToken) {
    logger.info('OAuth2 credentials found — using for Gmail/Calendar (and Drive/Docs/Sheets if no SA)');
    oauth2Auth = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
    oauth2Auth.setCredentials({ refresh_token: refreshToken });
  }

  // Build Service Account client (if key file available)
  // NOTE: Do NOT set subject/impersonate for regular @gmail.com accounts —
  // domain-wide delegation only works with Google Workspace domains.
  let saAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
  if (keyFile && existsSync(keyFile)) {
    logger.info(`Service Account found: ${keyFile}`);
    const keyData = JSON.parse(readFileSync(keyFile, 'utf-8'));
    const isWorkspaceDomain = impersonateEmail && !impersonateEmail.endsWith('@gmail.com');
    if (impersonateEmail && !isWorkspaceDomain) {
      logger.warn(`Impersonate email ${impersonateEmail} is a @gmail.com account — skipping domain-wide delegation`);
    }
    saAuth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        ...(isWorkspaceDomain ? [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/gmail.modify',
        ] : []),
      ],
      // Only impersonate if target is a Google Workspace domain (not @gmail.com)
      ...(isWorkspaceDomain ? { clientOptions: { subject: impersonateEmail } } : {}),
    });
  }

  // Determine which auth to use for each service
  // Priority: OAuth2 for everything if available, else SA for file-based services
  const driveDocsAuth = oauth2Auth || saAuth;
  // Gmail/Calendar with @gmail.com REQUIRE OAuth2 — SA alone won't work
  const gmailCalAuth = oauth2Auth; // null if no OAuth2 configured

  if (!driveDocsAuth) {
    logger.warn('No Google credentials configured — Google Workspace tools will return errors');
  }
  if (!gmailCalAuth) {
    logger.warn('No OAuth2 credentials — Gmail/Calendar tools will not work for @gmail.com');
  }
  _hasOAuth2 = !!gmailCalAuth;

  _clients = {
    drive: google.drive({ version: 'v3', auth: (driveDocsAuth) as any }),
    docs: google.docs({ version: 'v1', auth: (driveDocsAuth) as any }),
    sheets: google.sheets({ version: 'v4', auth: (driveDocsAuth) as any }),
    calendar: google.calendar({ version: 'v3', auth: (gmailCalAuth ?? driveDocsAuth) as any }),
    gmail: google.gmail({ version: 'v1', auth: (gmailCalAuth ?? driveDocsAuth) as any }),
  };

  logger.info('Google Workspace clients initialized (Drive, Docs, Sheets, Calendar, Gmail)');
  return _clients;
}

// ═══════════════════════════════════════════
//  DRIVE
// ═══════════════════════════════════════════

/** List files in a Drive folder */
export async function gwDriveListFiles(folderId: string, maxResults = 50): Promise<GWFile[]> {
  const { drive } = initGoogleWorkspace();
  logger.info(`Drive: listing files in folder ${folderId}`);

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: maxResults,
  });

  return (res.data.files || []).map(f => ({
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: parseInt(f.size || '0', 10),
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
    webViewLink: f.webViewLink || '',
  }));
}

/** Search files across Drive by name or full-text */
export async function gwDriveSearch(query: string, maxResults = 20): Promise<GWFile[]> {
  const { drive } = initGoogleWorkspace();
  logger.info(`Drive: searching for "${query}"`);

  const res = await drive.files.list({
    q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: maxResults,
  });

  return (res.data.files || []).map(f => ({
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: parseInt(f.size || '0', 10),
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
    webViewLink: f.webViewLink || '',
  }));
}

/** Get file metadata */
export async function gwDriveGetFile(fileId: string): Promise<GWFile> {
  const { drive } = initGoogleWorkspace();
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink',
  });
  const f = res.data;
  return {
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: parseInt(f.size || '0', 10),
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
    webViewLink: f.webViewLink || '',
  };
}

/** Create a folder in Drive */
export async function gwDriveCreateFolder(name: string, parentId?: string): Promise<GWFile> {
  const { drive } = initGoogleWorkspace();
  logger.info(`Drive: creating folder "${name}"`);

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink',
  });
  const f = res.data;
  return {
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: 0,
    createdTime: f.createdTime || '',
    modifiedTime: f.modifiedTime || '',
    webViewLink: f.webViewLink || '',
  };
}

// ═══════════════════════════════════════════
//  DOCS
// ═══════════════════════════════════════════

/** Get a Google Doc's content as plain text */
export async function gwDocsGetContent(documentId: string): Promise<{ title: string; body: string }> {
  const { docs } = initGoogleWorkspace();
  logger.info(`Docs: reading document ${documentId}`);

  const res = await docs.documents.get({ documentId });
  const doc = res.data;
  const title = doc.title || '';

  // Extract text from structural elements
  let body = '';
  for (const el of doc.body?.content || []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        body += pe.textRun?.content || '';
      }
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        const cells: string[] = [];
        for (const cell of row.tableCells || []) {
          let cellText = '';
          for (const ce of cell.content || []) {
            if (ce.paragraph) {
              for (const pe of ce.paragraph.elements || []) {
                cellText += pe.textRun?.content || '';
              }
            }
          }
          cells.push(cellText.trim());
        }
        body += '| ' + cells.join(' | ') + ' |\n';
      }
    }
  }

  return { title, body: body.trim() };
}

/** Create a new Google Doc */
export async function gwDocsCreate(title: string, bodyText?: string): Promise<{ documentId: string; url: string }> {
  const { docs } = initGoogleWorkspace();
  logger.info(`Docs: creating document "${title}"`);

  const res = await docs.documents.create({ requestBody: { title } });
  const documentId = res.data.documentId || '';

  if (bodyText) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: bodyText,
          },
        }],
      },
    });
  }

  return {
    documentId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

/** Append text to an existing Google Doc */
export async function gwDocsAppend(documentId: string, text: string): Promise<void> {
  const { docs } = initGoogleWorkspace();
  logger.info(`Docs: appending to document ${documentId}`);

  // Get current end index
  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body?.content?.at(-1)?.endIndex || 1;

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: endIndex - 1 },
          text,
        },
      }],
    },
  });
}

// ═══════════════════════════════════════════
//  SHEETS
// ═══════════════════════════════════════════

/** Read data from a sheet range */
export async function gwSheetsRead(
  spreadsheetId: string,
  range: string,
): Promise<{ values: string[][]; sheetTitle: string }> {
  const { sheets } = initGoogleWorkspace();
  logger.info(`Sheets: reading ${spreadsheetId} range "${range}"`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  // Get sheet title
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title',
  });

  return {
    values: (res.data.values || []) as string[][],
    sheetTitle: meta.data.properties?.title || '',
  };
}

/** Write data to a sheet range */
export async function gwSheetsWrite(
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<{ updatedCells: number }> {
  const { sheets } = initGoogleWorkspace();
  logger.info(`Sheets: writing to ${spreadsheetId} range "${range}"`);

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  return { updatedCells: res.data.updatedCells || 0 };
}

/** Append rows to a sheet */
export async function gwSheetsAppend(
  spreadsheetId: string,
  range: string,
  rows: string[][],
): Promise<{ updatedRows: number }> {
  const { sheets } = initGoogleWorkspace();
  logger.info(`Sheets: appending ${rows.length} rows to ${spreadsheetId}`);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  return { updatedRows: res.data.updates?.updatedRows || 0 };
}

/** Create a new spreadsheet */
export async function gwSheetsCreate(
  title: string,
  headers?: string[],
): Promise<{ spreadsheetId: string; url: string }> {
  const { sheets } = initGoogleWorkspace();
  logger.info(`Sheets: creating spreadsheet "${title}"`);

  const res = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
  });
  const spreadsheetId = res.data.spreadsheetId || '';

  if (headers && headers.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });
  }

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

// ═══════════════════════════════════════════
//  CALENDAR
// ═══════════════════════════════════════════

/** List upcoming events */
export async function gwCalendarListEvents(
  calendarId = 'primary',
  maxResults = 20,
  timeMinISO?: string,
  timeMaxISO?: string,
): Promise<GWEvent[]> {
  const { calendar } = initGoogleWorkspace();
  if (!_hasOAuth2) throw new Error('Calendar requires OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Service Account cannot access @gmail.com calendars.');
  logger.info(`Calendar: listing events from ${calendarId}`);

  const now = new Date().toISOString();
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMinISO || now,
    ...(timeMaxISO ? { timeMax: timeMaxISO } : {}),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map(e => ({
    id: e.id || '',
    summary: e.summary || '(sin título)',
    description: e.description || '',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location || '',
    status: e.status || '',
    htmlLink: e.htmlLink || '',
    attendees: (e.attendees || []).map(a => ({
      email: a.email || '',
      responseStatus: a.responseStatus || '',
    })),
  }));
}

/** Create a calendar event */
export async function gwCalendarCreateEvent(
  summary: string,
  startISO: string,
  endISO: string,
  opts?: {
    description?: string;
    location?: string;
    attendees?: string[];
    calendarId?: string;
  },
): Promise<GWEvent> {
  const { calendar } = initGoogleWorkspace();
  if (!_hasOAuth2) throw new Error('Calendar requires OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Service Account cannot access @gmail.com calendars.');
  const calendarId = opts?.calendarId || 'primary';
  logger.info(`Calendar: creating event "${summary}" on ${calendarId}`);

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description: opts?.description || '',
      location: opts?.location || '',
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: (opts?.attendees || []).map(email => ({ email })),
    },
  });
  const e = res.data;
  return {
    id: e.id || '',
    summary: e.summary || '',
    description: e.description || '',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location || '',
    status: e.status || '',
    htmlLink: e.htmlLink || '',
    attendees: (e.attendees || []).map(a => ({
      email: a.email || '',
      responseStatus: a.responseStatus || '',
    })),
  };
}

// ═══════════════════════════════════════════
//  GMAIL
// ═══════════════════════════════════════════

/** List recent emails (default: inbox) */
export async function gwGmailListMessages(
  query = 'in:inbox',
  maxResults = 20,
): Promise<GWEmail[]> {
  const { gmail } = initGoogleWorkspace();
  if (!_hasOAuth2) throw new Error('Gmail requires OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Service Account cannot access @gmail.com mailboxes.');
  logger.info(`Gmail: listing messages with query "${query}"`);

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messages: GWEmail[] = [];
  for (const msg of list.data.messages || []) {
    if (!msg.id) continue;
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const headers = detail.data.payload?.headers || [];
    const hdr = (name: string) => headers.find(h => h.name === name)?.value || '';

    messages.push({
      id: msg.id,
      threadId: detail.data.threadId || '',
      from: hdr('From'),
      to: hdr('To'),
      subject: hdr('Subject'),
      date: hdr('Date'),
      snippet: detail.data.snippet || '',
    });
  }

  return messages;
}

/** Read a full email body */
export async function gwGmailReadMessage(messageId: string): Promise<GWEmail> {
  const { gmail } = initGoogleWorkspace();
  if (!_hasOAuth2) throw new Error('Gmail requires OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Service Account cannot access @gmail.com mailboxes.');
  logger.info(`Gmail: reading message ${messageId}`);

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = res.data.payload?.headers || [];
  const hdr = (name: string) => headers.find(h => h.name === name)?.value || '';

  // Extract body text
  let body = '';
  const payload = res.data.payload;
  if (payload?.body?.data) {
    body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  } else if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
        break;
      }
    }
    // Fallback to HTML if no plain text
    if (!body) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64url').toString('utf-8')
            .replace(/<[^>]+>/g, ''); // Strip HTML tags
          break;
        }
      }
    }
  }

  return {
    id: messageId,
    threadId: res.data.threadId || '',
    from: hdr('From'),
    to: hdr('To'),
    subject: hdr('Subject'),
    date: hdr('Date'),
    snippet: res.data.snippet || '',
    body: body.substring(0, 8000), // Limit to avoid token overflow
  };
}

/** Send an email */
export async function gwGmailSend(
  to: string,
  subject: string,
  bodyText: string,
  opts?: { cc?: string; bcc?: string },
): Promise<{ messageId: string; threadId: string }> {
  const { gmail } = initGoogleWorkspace();
  if (!_hasOAuth2) throw new Error('Gmail requires OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Service Account cannot access @gmail.com mailboxes.');
  logger.info(`Gmail: sending email to ${to}`);

  const rawHeaders = [
    `To: ${to}`,
    opts?.cc ? `Cc: ${opts.cc}` : '',
    opts?.bcc ? `Bcc: ${opts.bcc}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
  ].filter(Boolean).join('\r\n');

  const raw = Buffer.from(rawHeaders).toString('base64url');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    messageId: res.data.id || '',
    threadId: res.data.threadId || '',
  };
}
