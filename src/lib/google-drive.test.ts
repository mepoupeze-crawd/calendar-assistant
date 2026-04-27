const mockFilesList = jest.fn();
const mockFilesCreate = jest.fn();
const mockPermissionsCreate = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn(() => ({
      files: {
        list: mockFilesList,
        create: mockFilesCreate,
      },
      permissions: {
        create: mockPermissionsCreate,
      },
    })),
  },
}));
jest.mock('./calendar/google-auth', () => ({
  getGoogleAuth: jest.fn(() => ({})),
}));

import { getOrCreateFolder, uploadImageToDrive, _resetFolderCacheForTesting } from './google-drive';

beforeEach(() => {
  jest.clearAllMocks();
  _resetFolderCacheForTesting();
  mockPermissionsCreate.mockResolvedValue({});
});

describe('getOrCreateFolder', () => {
  it('retorna folderId existente sem criar pasta', async () => {
    mockFilesList.mockResolvedValueOnce({
      data: { files: [{ id: 'existing-folder-id' }] },
    });
    const id = await getOrCreateFolder('Calendário Bot');
    expect(id).toBe('existing-folder-id');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('cria pasta quando não existe e retorna novo id', async () => {
    mockFilesList.mockResolvedValueOnce({ data: { files: [] } });
    mockFilesCreate.mockResolvedValueOnce({ data: { id: 'new-folder-id' } });
    const id = await getOrCreateFolder('Calendário Bot');
    expect(id).toBe('new-folder-id');
    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ mimeType: 'application/vnd.google-apps.folder' }),
      })
    );
  });

  it('usa cache na segunda chamada sem buscar no Drive', async () => {
    mockFilesList.mockResolvedValueOnce({ data: { files: [{ id: 'cached-id' }] } });
    const id1 = await getOrCreateFolder('Calendário Bot');
    const id2 = await getOrCreateFolder('Calendário Bot');
    expect(id1).toBe('cached-id');
    expect(id2).toBe('cached-id');
    expect(mockFilesList).toHaveBeenCalledTimes(1);
  });

  it('lança erro quando criação de pasta retorna sem id', async () => {
    mockFilesList.mockResolvedValueOnce({ data: { files: [] } });
    mockFilesCreate.mockResolvedValueOnce({ data: {} }); // no id
    await expect(getOrCreateFolder('Calendário Bot')).rejects.toThrow('Drive folder creation: missing id');
  });
});

describe('uploadImageToDrive', () => {
  it('faz upload com mimeType correto, define permissão anyone reader e retorna webViewLink', async () => {
    mockFilesCreate.mockResolvedValueOnce({
      data: { id: 'file-id', webViewLink: 'https://drive.google.com/file/d/file-id/view' },
    });
    const buf = Buffer.from('fake-image');
    const link = await uploadImageToDrive(buf, 'image/png', 'foto.png', 'folder-id');
    expect(link).toBe('https://drive.google.com/file/d/file-id/view');
    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ mimeType: 'image/png' }),
      })
    );
    expect(mockPermissionsCreate).toHaveBeenCalledWith({
      fileId: 'file-id',
      requestBody: { type: 'anyone', role: 'reader' },
    });
  });

  it('lança erro quando upload falha', async () => {
    mockFilesCreate.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(uploadImageToDrive(Buffer.from('x'), 'image/jpeg', 'f.jpg', 'folder-id')).rejects.toThrow('quota exceeded');
  });

  it('lança erro quando webViewLink está ausente na resposta', async () => {
    mockFilesCreate.mockResolvedValueOnce({ data: { id: 'file-id' } }); // no webViewLink
    await expect(uploadImageToDrive(Buffer.from('x'), 'image/jpeg', 'f.jpg', 'folder-id')).rejects.toThrow('Drive upload: missing webViewLink');
  });
});
