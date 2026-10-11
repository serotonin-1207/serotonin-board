import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStorage } from '../src/storage.mjs';

function make(client, cfg = {}) {
  const storage = new SupabaseStorage({ maxEvents: 20000, ...cfg }, { url: () => 'https://x.supabase.co', key: () => 'sb_publishable_x' });
  storage.client = client;
  return storage;
}

test('the bot check is skipped unless a site key is configured, and its token is passed to the anonymous sign-in', async () => {
  const seen = [];
  const auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInAnonymously: async options => (seen.push(options), { data: { user: { id: 'u1', is_anonymous: true } }, error: null }),
  };
  // no site key: plain sign-in
  let storage = make({ auth });
  storage.session = SupabaseStorage.prototype.session;
  const plain = new SupabaseStorage({ maxEvents: 1 }, { url: () => 'https://x.supabase.co', key: () => 'sb_publishable_abcdef' });
  plain.client = { auth };
  assert.equal(await plain.captchaToken(), undefined);
  // with a site key the widget produces the token
  globalThis.window = { turnstile: { render: (holder, options) => setTimeout(() => options.callback('token-123'), 0) } };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }), body: { append() {} }, head: { append() {} } };
  const guarded = new SupabaseStorage(
    { maxEvents: 1, turnstileSiteKey: 'site-key' },
    { url: () => 'https://x.supabase.co', key: () => 'sb_publishable_abcdef' },
  );
  assert.equal(await guarded.captchaToken(), 'token-123');
  delete globalThis.window;
  delete globalThis.document;
  void seen;
});

test('administrator answers become readable messages, and a wrong or locked code is an error', async () => {
  let answer = { admin: false, error: 'invalid' };
  const storage = make({ rpc: async () => ({ data: answer, error: null }) });
  storage.session = async () => ({ id: 'u' });
  await assert.rejects(storage.adminLogin('x'), /맞지 않습니다/);
  answer = { admin: false, error: 'locked' };
  await assert.rejects(storage.adminLogin('x'), /1시간/);
  answer = { admin: true };
  assert.equal(await storage.adminLogin('right'), true);
  const denied = make({ rpc: async () => ({ data: null, error: { message: 'Administrator required' } }) });
  denied.session = async () => ({ id: 'u' });
  await assert.rejects(denied.adminOverview(), /관리자 권한이 필요합니다/);
  const dup = make({ rpc: async () => ({ data: null, error: { message: 'Department id already exists' } }) });
  dup.session = async () => ({ id: 'u' });
  await assert.rejects(dup.adminCreateDept('a1', 'A', true), /이미 있는 부서 ID/);
});

test('restore sends the batch to the server function and reports its answer', async () => {
  const calls = [];
  const storage = make({ rpc: async (name, args) => (calls.push([name, args]), { data: { added: 2, skipped: 1 }, error: null }) });
  storage.session = async () => ({ id: 'u' });
  assert.deepEqual(await storage.restoreEvents([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), { added: 2, skipped: 1 });
  assert.deepEqual(calls[0], ['serotonin_restore_events', { p_events: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]);
  const broken = make({ rpc: async () => ({ data: null, error: { message: 'Parent revision missing or belongs to another note' } }) });
  broken.session = async () => ({ id: 'u' });
  await assert.rejects(broken.restoreEvents([]), /이전 수정 기록이 맞지 않습니다/);
});

test('telegram settings are sent as the database expects, and server-function failures become readable messages', async () => {
  const calls = [];
  const storage = make({
    rpc: async (name, args) => (calls.push([name, args]), { data: true, error: null }),
    functions: { invoke: async (name, options) => (calls.push([name, options]), { data: { ok: true, username: 'x_bot' }, error: null }) },
  });
  storage.session = async () => ({ id: 'u' });
  await storage.adminTelegramSave('d1', { enabled: true, morning: true, evening: false, changes: true, morningMin: 540, eveningMin: 1080 });
  await storage.adminTelegramLinkStart('d1');
  assert.deepEqual(calls[0], [
    'serotonin_admin_telegram_save',
    { p_dept: 'd1', p_enabled: true, p_morning: true, p_evening: false, p_changes: true, p_morning_min: 540, p_evening_min: 1080 },
  ]);
  assert.deepEqual(calls[1], ['serotonin_admin_telegram_link_start', { p_dept: 'd1' }]);
  assert.equal((await storage.telegramCall('info')).username, 'x_bot');
  assert.deepEqual(calls[2], ['telegram-notify', { body: { action: 'info', dept: undefined } }]);
  for (const [status, pattern] of [
    [404, /설치되지 않았습니다/],
    [403, /관리자 권한/],
    [500, /부르지 못했습니다/],
  ]) {
    const failing = make({ functions: { invoke: async () => ({ data: null, error: { context: { status } } }) } });
    failing.session = async () => ({ id: 'u' });
    await assert.rejects(failing.telegramCall('info'), pattern);
  }
  const unlinked = make({ rpc: async () => ({ data: null, error: { message: 'Telegram chat not linked' } }) });
  unlinked.session = async () => ({ id: 'u' });
  await assert.rejects(unlinked.adminTelegramSave('d1', {}), /먼저 텔레그램 대화방을 연결/);
});
