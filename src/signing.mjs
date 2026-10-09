import nacl from 'tweetnacl';

// Author proof for the router (SSD) board. Every revision can carry an Ed25519 signature made in the writer's
// browser. A registry file (users.json), which only the administrator edits, maps public keys to real names.
// Pure JavaScript, so it works on the router's plain-HTTP page where crypto.subtle is unavailable.

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

const HEX = /^[a-f0-9]+$/;
const PREFIX = 'serotonin-board-event-v1\n';
const encoder = new TextEncoder();

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(text, length, label) {
  if (typeof text !== 'string' || text.length !== length * 2 || !HEX.test(text)) throw new Error(label + ' 형식이 올바르지 않습니다.');
  return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
}

export function identityFromSeed(seed) {
  const pair = nacl.sign.keyPair.fromSeed(fromHex(seed, 32, '개인 열쇠'));
  return { seed, publicKey: toHex(pair.publicKey) };
}
export function createIdentity() {
  return identityFromSeed(toHex(nacl.randomBytes(32)));
}

function payload(event) {
  const { signature, ...unsigned } = event;
  return encoder.encode(PREFIX + canonical(unsigned));
}

export function signEvent(event, seed) {
  const pair = nacl.sign.keyPair.fromSeed(fromHex(seed, 32, '개인 열쇠'));
  const sig = nacl.sign.detached(payload(event), pair.secretKey);
  return { ...event, signature: { alg: 'ed25519', publicKey: toHex(pair.publicKey), sig: toHex(sig) } };
}

// users.json: { "schema": 1, "users": [ { "name": "홍길동", "publicKey": "<64 hex>" } ] }
export function registryMap(file) {
  const map = new Map();
  if (!file) return map;
  if (file.schema !== 1 || !Array.isArray(file.users)) throw new Error('등록 목록(users.json) 형식이 올바르지 않습니다.');
  for (const user of file.users) {
    if (
      !user ||
      typeof user.name !== 'string' ||
      !user.name.trim() ||
      user.name.length > 40 ||
      typeof user.publicKey !== 'string' ||
      user.publicKey.length !== 64 ||
      !HEX.test(user.publicKey)
    )
      throw new Error('등록 목록(users.json)에 올바르지 않은 항목이 있습니다.');
    if (map.has(user.publicKey)) throw new Error('등록 목록(users.json)에 같은 열쇠가 두 번 있습니다.');
    map.set(user.publicKey, user.name.trim());
  }
  return map;
}

// state: 'verified' (valid signature, key registered) | 'unregistered' (valid, key unknown) |
//        'invalid' (signature present but wrong) | 'unsigned'
export function checkEvent(event, registry) {
  const signature = event?.signature;
  if (!signature) return { state: 'unsigned' };
  try {
    if (signature.alg !== 'ed25519') throw new Error();
    const ok = nacl.sign.detached.verify(payload(event), fromHex(signature.sig, 64, '서명'), fromHex(signature.publicKey, 32, '공개 열쇠'));
    if (!ok) return { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
  const name = registry?.get(signature.publicKey);
  return name ? { state: 'verified', name, publicKey: signature.publicKey } : { state: 'unregistered', publicKey: signature.publicKey };
}
