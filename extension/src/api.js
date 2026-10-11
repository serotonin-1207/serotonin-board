import './shim.js';
import { SupabaseStorage } from '../../src/storage.mjs';
import { DEFAULT_SETTINGS } from './logic.mjs';

// Injected by scripts/build-extension.mjs from supabase/public-config.json (public address and publishable key only).
export const CONFIG = __CONFIG__;
export const core = globalThis.BoardCore;

const PROFILE = 'ext:profile',
  SUMMARY = 'ext:summary',
  SETTINGS = 'ext:settings',
  MARKS = 'ext:marks';

const area = chrome.storage.local;
export async function read(key, fallback = null) {
  const found = await area.get(key);
  return found[key] ?? fallback;
}
export const write = (key, value) => area.set({ [key]: value });

// The login session lives in chrome.storage; the access code itself is never stored.
const authStorage = {
  getItem: async key => (await read(key)) ?? null,
  setItem: (key, value) => write(key, value),
  removeItem: key => area.remove(key),
};
let storage = null;
export function getStorage() {
  if (!storage) storage = new SupabaseStorage({ maxEvents: 20000 }, { url: () => CONFIG.url, key: () => CONFIG.key, authStorage });
  return storage;
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export const getProfile = () => read(PROFILE);
export const getSummary = () => read(SUMMARY);
export const getMarks = () => read(MARKS, {});
export const setMark = async (kind, day) => write(MARKS, { ...(await getMarks()), [kind]: day });
export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await read(SETTINGS, {})) };
}
export const saveSettings = settings => write(SETTINGS, settings);

export async function refreshSummary() {
  const store = getStorage();
  await store.session();
  const result = await store.client.rpc('serotonin_member_summary');
  if (result.error) {
    if (/Access code required/.test(result.error.message)) {
      const error = new Error('이 브라우저는 아직 부서에 등록되지 않았습니다. 접속 코드를 입력해 주세요.');
      error.code = 'NOT_MEMBER';
      throw error;
    }
    throw new Error('보드에서 읽지 못했습니다: ' + result.error.message);
  }
  await write(SUMMARY, { at: Date.now(), data: result.data });
  return result.data;
}

// First connection: the department's access code is checked once, then the server remembers this browser.
export async function connect(code, name) {
  const cleanName = name.trim().slice(0, 40);
  if (!cleanName) throw new Error('표시 이름을 입력해 주세요.');
  const store = getStorage();
  await store.connect({ code: code.trim(), name: cleanName });
  await write(PROFILE, { name: cleanName, clientId: randomId() });
  return refreshSummary();
}

export async function disconnect() {
  await area.clear();
  storage = null;
}

// Writes one new note (handover item or memo) exactly like the board does: a first revision with no parents.
export async function addNote(note) {
  const profile = await getProfile();
  if (!profile) throw new Error('먼저 확장 프로그램에서 접속 코드를 입력해 연결해 주세요.');
  const event = {
    schema: 1,
    id: randomId(),
    noteId: randomId(),
    parents: [],
    at: new Date().toISOString(),
    note: { content: '', status: 'todo', pinned: false, deleted: false, ...note, author: profile.name },
    actor: { id: profile.clientId, kind: 'display-only' },
  };
  if (!core.validEvent(event)) throw new Error('제목과 내용 길이를 확인해 주세요.');
  await getStorage().append(event);
  return event;
}
