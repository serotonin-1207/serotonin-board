import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, createIdentity, identityFromSeed, signEvent, checkEvent, registryMap } from '../src/signing.mjs';

const id = n => n.toString(16).padStart(32, '0');
const event = (content = '내용') => ({
  schema: 1, id: id(1), noteId: id(2), parents: [], at: '2026-10-08T01:00:00.000Z',
  note: { title: '인수인계', content, author: '홍길동', category: '인수인계', status: 'todo', pinned: false, deleted: false },
  actor: { id: 'abc', kind: 'display-only' },
});

test('identities are reproducible from their private seed and never expose it in the public key', () => {
  const me = createIdentity();
  assert.match(me.seed, /^[a-f0-9]{64}$/);
  assert.match(me.publicKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(identityFromSeed(me.seed), me);
  assert.notEqual(createIdentity().publicKey, me.publicKey);
  assert.throws(() => identityFromSeed('zz'), /형식/);
});

test('a registered key verifies and yields the administrator-assigned name, regardless of the typed author', () => {
  const me = createIdentity();
  const signed = signEvent(event(), me.seed);
  const registry = registryMap({ schema: 1, users: [{ name: '홍길동 소방위', publicKey: me.publicKey }] });
  assert.deepEqual(checkEvent(signed, registry), { state: 'verified', name: '홍길동 소방위', publicKey: me.publicKey });
  assert.equal(checkEvent(signed, registry).state, 'verified');
});

test('valid signatures from unknown keys are marked unregistered, and unsigned events stay unsigned', () => {
  const stranger = createIdentity();
  assert.equal(checkEvent(signEvent(event(), stranger.seed), registryMap(null)).state, 'unregistered');
  assert.equal(checkEvent(event(), registryMap(null)).state, 'unsigned');
});

test('any change after signing — content, author, parents, time or key swap — is detected', () => {
  const me = createIdentity(), other = createIdentity();
  const registry = registryMap({ schema: 1, users: [{ name: 'A', publicKey: me.publicKey }, { name: 'B', publicKey: other.publicKey }] });
  const signed = signEvent(event(), me.seed);
  const tampered = [
    { ...signed, note: { ...signed.note, content: '바꾼 내용' } },
    { ...signed, note: { ...signed.note, author: '다른 사람' } },
    { ...signed, parents: [id(9)] },
    { ...signed, at: '2026-10-09T00:00:00.000Z' },
    { ...signed, signature: { ...signed.signature, publicKey: other.publicKey } }, // claim to be B
    { ...signed, signature: { ...signed.signature, sig: '0'.repeat(128) } },
    { ...signed, signature: { ...signed.signature, alg: 'rsa' } },
    { ...signed, signature: { alg: 'ed25519', publicKey: 'xyz', sig: 'xyz' } },
  ];
  for (const bad of tampered) assert.equal(checkEvent(bad, registry).state, 'invalid');
});

test('signatures ignore key order and survive a JSON round trip, as when stored on the SSD', () => {
  const me = createIdentity();
  const signed = signEvent(event(), me.seed);
  const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, note: signed.note, actor: signed.actor, at: signed.at, parents: signed.parents, noteId: signed.noteId, id: signed.id, schema: 1 }));
  assert.equal(checkEvent(reordered, registryMap({ schema: 1, users: [{ name: 'A', publicKey: me.publicKey }] })).state, 'verified');
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), canonical({ a: [2, { d: 1 }], b: 1 }));
});

test('schedule fields are covered by the signature too', () => {
  const me = createIdentity();
  const schedule = event();
  Object.assign(schedule.note, { category: '일정', kind: '휴가', date: '2026-10-12' });
  const signed = signEvent(schedule, me.seed);
  assert.equal(checkEvent({ ...signed, note: { ...signed.note, date: '2026-10-13' } }, registryMap(null)).state, 'invalid');
});

test('malformed registries are rejected instead of silently trusting entries', () => {
  const me = createIdentity();
  for (const bad of [{ schema: 2, users: [] }, { schema: 1 }, { schema: 1, users: [{ name: '', publicKey: me.publicKey }] }, { schema: 1, users: [{ name: 'A', publicKey: 'short' }] }, { schema: 1, users: [{ name: 'A', publicKey: me.publicKey }, { name: 'B', publicKey: me.publicKey }] }])
    assert.throws(() => registryMap(bad), /등록 목록/);
  assert.equal(registryMap({ schema: 1, users: [] }).size, 0);
});
