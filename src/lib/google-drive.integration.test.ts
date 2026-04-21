// src/lib/google-drive.integration.test.ts
/**
 * Testes de integração reais — SKIP em CI.
 * Para rodar manualmente com credenciais reais:
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... GOOGLE_OAUTH_REFRESH_TOKEN=... \
 *   npx jest src/lib/google-drive.integration.test.ts --no-coverage
 *
 * Pré-requisitos:
 *   1. Drive API habilitada no GCP Console
 *   2. GOOGLE_OAUTH_REFRESH_TOKEN com escopo drive.file
 */
describe.skip('Google Drive integration (real credentials)', () => {
  it('cria pasta, faz upload e retorna link acessível', async () => {
    const { _resetFolderCacheForTesting, getOrCreateFolder, uploadImageToDrive } = await import('./google-drive');
    _resetFolderCacheForTesting();

    const folderId = await getOrCreateFolder('Calendário Bot TEST');
    expect(folderId).toBeTruthy();

    const buf = Buffer.from('fake image content for integration test');
    const link = await uploadImageToDrive(buf, 'image/jpeg', `test-${Date.now()}.jpg`, folderId);
    expect(link).toMatch(/drive\.google\.com/);
    console.log('Link gerado:', link);
  });
});
