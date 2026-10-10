import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStorage } from '../src/storage.mjs';

function make(client) {
  const storage = new SupabaseStorage({ maxEvents: 20000 }, {});
  storage.session = async () => ({ id: 'u' });
  storage.client = client;
  return storage;
}

test('file removal deletes the stored object first and forgets the record only afterwards; purge removes every expired file', async () => {
  const calls = [];
  const storage = make({
    storage: { from: bucket => ({ remove: async paths => (calls.push(['remove', bucket, ...paths]), { data: [], error: null }) }) },
    rpc: async (name, args) => {
      calls.push(['rpc', name, args?.p_id]);
      if (name === 'serotonin_file_expired')
        return {
          data: [
            { id: 'a', path: 'd1/a' },
            { id: 'b', path: 'd1/b' },
          ],
          error: null,
        };
      return { data: true, error: null };
    },
  });
  await storage.fileRemove({ id: 'x', path: 'd1/x' });
  assert.deepEqual(calls.splice(0), [
    ['remove', 'board-files', 'd1/x'],
    ['rpc', 'serotonin_file_forget', 'x'],
  ]);
  assert.equal(await storage.filePurge(), 2);
  assert.deepEqual(
    calls.splice(0).map(c => c.join(':')),
    [
      'rpc:serotonin_file_expired:',
      'remove:board-files:d1/a',
      'rpc:serotonin_file_forget:a',
      'remove:board-files:d1/b',
      'rpc:serotonin_file_forget:b',
    ],
  );
  // a failed object removal must not forget the record
  storage.client.storage = { from: () => ({ remove: async () => ({ error: { message: 'denied' } }) }) };
  await assert.rejects(storage.fileRemove({ id: 'y', path: 'd1/y' }), /삭제하지 못했습니다/);
  assert.ok(!calls.some(c => c[1] === 'serotonin_file_forget'));
});

test('the download address is a short-lived signed address that forces a download under the original name', async () => {
  let asked;
  const storage = make({
    storage: {
      from: () => ({
        createSignedUrl: async (path, seconds, options) => (
          (asked = { path, seconds, options }),
          { data: { signedUrl: 'https://x/y' }, error: null }
        ),
      }),
    },
  });
  assert.equal(await storage.fileDownloadUrl({ path: 'd1/a', name: '근무표.xlsx' }), 'https://x/y');
  assert.deepEqual(asked, { path: 'd1/a', seconds: 60, options: { download: '근무표.xlsx' } });
});

test('database messages become readable Korean messages', () => {
  const storage = make(null);
  assert.match(storage.fileMessage(new Error('Department file space is full')), /공간이 가득/);
  assert.match(storage.fileMessage({ message: 'File size must be between 1 byte and 50 MB' }), /50MB/);
  assert.equal(storage.fileMessage(new Error('something else')), 'something else');
});
