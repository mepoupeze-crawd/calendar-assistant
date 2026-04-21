import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { getGoogleAuth } from './calendar/google-auth';

function driveClient(): drive_v3.Drive {
  return google.drive({ version: 'v3', auth: getGoogleAuth() });
}

let cachedFolderId: string | null = null;

export function _resetFolderCacheForTesting(): void {
  cachedFolderId = null;
}

export async function getOrCreateFolder(name: string): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const drive = driveClient();
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (res.data.files && res.data.files.length > 0) {
    cachedFolderId = res.data.files[0].id!;
    return cachedFolderId;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  if (!created.data.id) throw new Error('Drive folder creation: missing id in response');
  cachedFolderId = created.data.id;
  return cachedFolderId;
}

export async function uploadImageToDrive(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  folderId: string
): Promise<string> {
  const drive = driveClient();
  const stream = Readable.from(buffer);

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id,webViewLink',
  });

  const fileId = res.data.id;
  const webViewLink = res.data.webViewLink;

  if (!fileId) throw new Error('Drive upload: missing file id in response');
  if (!webViewLink) throw new Error('Drive upload: missing webViewLink in response');

  await drive.permissions.create({
    fileId,
    requestBody: { type: 'anyone', role: 'reader' },
  });

  return webViewLink;
}
