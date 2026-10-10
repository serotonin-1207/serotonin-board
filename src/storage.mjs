import { createClient } from '@supabase/supabase-js';
import * as signing from './signing.mjs';

const { canonical } = signing;
const PAGE_SIZE = 500,
  OVERLAP_MS = 120000,
  FULL_RELOAD_EVERY = 20;

export function publicSupabaseConfig(url, key) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Supabase 프로젝트 주소를 입력해 주세요.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('프로젝트 주소는 https://프로젝트번호.supabase.co 형식이어야 합니다.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
    throw new Error('공개 publishable 키만 입력해 주세요. secret 또는 service_role 키는 사용할 수 없습니다.');
  return { url: parsed.origin, key };
}

export { canonical };

function sessionId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function requireEvent(event) {
  if (!window.BoardCore.validEvent(event)) throw new Error('저장 서비스의 수정 기록 형식이 올바르지 않습니다.');
  return event;
}

export class RouterStorage {
  constructor(cfg, options) {
    this.cfg = cfg;
    this.options = options;
    this.label = 'SSD';
  }
  dataUrl(name = '') {
    const url = new URL(this.cfg.dataUrl + name, location.href);
    url.searchParams.set('_', Date.now().toString());
    return url;
  }
  async checked(url) {
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('SSD 공유 자료를 읽지 못했습니다 (HTTP ' + r.status + ').');
    return r;
  }
  async list(previous) {
    const html = await (await this.checked(this.dataUrl())).text();
    if (!/Index of|Directory Listing/.test(html)) throw new Error('SSD의 공유 기록 폴더를 읽지 못했습니다.');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const names = [
      ...new Set([...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(n => /^r-[a-f0-9]{32}\.json$/.test(n))),
    ];
    if (names.length > this.cfg.maxEvents) throw new Error('시험판 기록 한도에 도달했습니다.');
    const loaded = new Map(previous),
      queue = names.filter(n => !loaded.has(n.slice(2, -5)));
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const name = queue.shift();
          const value = requireEvent(await (await this.checked(this.dataUrl(name))).json());
          if (value.id !== name.slice(2, -5)) throw new Error('기록 파일 이름과 내용이 다릅니다.');
          loaded.set(value.id, value);
        }
      }),
    );
    return names.map(n => loaded.get(n.slice(2, -5)));
  }
  async upload(name, value) {
    let origin;
    try {
      origin = new URL(this.options.routerOrigin());
    } catch {
      throw new Error('공유기 로그인 주소를 입력해 주세요. 예: http://192.168.0.1');
    }
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('공유기 주소에는 경로나 계정 정보를 넣지 마세요.');
    if (origin.hostname !== location.hostname && !['localhost', '127.0.0.1'].includes(location.hostname))
      throw new Error('보드와 공유기 로그인은 같은 호스트 주소를 사용해야 합니다.');
    const payload = JSON.stringify(value),
      body = new FormData();
    body.append('file', new Blob([payload], { type: 'application/json' }), name);
    const endpoint = new URL('/cgi/upload.cgi', origin);
    endpoint.search = new URLSearchParams({
      destination: this.cfg.storagePath,
      task_id: 'upload_' + sessionId(),
      filename: name,
      relative_path: name,
    }).toString();
    await fetch(endpoint, {
      method: 'POST',
      body,
      mode: 'no-cors',
      credentials: 'include',
      referrerPolicy: 'strict-origin',
      signal: AbortSignal.timeout(10000),
    });
    for (let attempt = 0; attempt < 7; attempt++) {
      const r = await fetch(this.dataUrl(name), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        if ((await r.text()) !== payload) throw new Error('SSD에 저장된 내용이 다릅니다.');
        return value;
      }
      if (r.status !== 404) throw new Error('SSD 저장 확인에 실패했습니다 (HTTP ' + r.status + ').');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    throw new Error('SSD 저장을 확인하지 못했습니다. 게스트 로그인과 쓰기 권한을 확인해 주세요.');
  }
  // Administrator-maintained list of public keys (users.json next to the board). A missing file means nobody is registered yet.
  async registry() {
    if (!this.cfg.registryUrl) return null;
    const url = new URL(this.cfg.registryUrl, location.href);
    url.searchParams.set('_', Date.now().toString());
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return { schema: 1, users: [] };
    if (!r.ok) throw new Error('등록 목록(users.json)을 읽지 못했습니다 (HTTP ' + r.status + ').');
    try {
      return await r.json();
    } catch {
      throw new Error('등록 목록(users.json)이 올바른 JSON이 아닙니다.');
    }
  }
  async connect() {
    const id = sessionId();
    await this.upload('session-check-' + id + '.json', { type: 'connection-check', id, at: new Date().toISOString() });
    return { kind: 'display-only', id: null };
  }
  async append(event) {
    return this.upload('r-' + event.id + '.json', event);
  }
}

export class SupabaseStorage {
  constructor(cfg, options) {
    this.cfg = cfg;
    this.options = options;
    this.label = 'Supabase';
    this.client = null;
    this.connecting = null;
  }
  async session() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.client) {
        const { url, key } = publicSupabaseConfig(this.options.url(), this.options.key());
        this.client = createClient(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storageKey: 'serotonin-cloud-' + new URL(url).hostname,
          },
        });
      }
      const current = await this.client.auth.getSession();
      if (current.error) throw current.error;
      if (current.data.session) return current.data.session.user;
      const created = await this.client.auth.signInAnonymously();
      if (created.error)
        throw new Error('임시 계정 연결 실패: ' + created.error.message + ' · Supabase의 Anonymous Sign-Ins 설정을 확인해 주세요.');
      return created.data.user;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  async checkMembership(user) {
    const result = await this.client.rpc('serotonin_test_connection');
    if (result.error) throw new Error('테스트 저장소 연결 실패: ' + result.error.message + ' · setup.sql 실행 여부를 확인해 주세요.');
    if (result.data?.userId !== user.id) throw new Error('저장 서비스의 계정 확인 결과가 다릅니다.');
    return result.data.member === true;
  }
  // The access code is only needed once per temporary account; the server remembers the membership.
  async connect({ code } = {}) {
    const user = await this.session();
    if (!(await this.checkMembership(user))) {
      if (!code) throw new Error('접속 코드를 입력해 주세요. 관리자에게 받은 코드를 한 번 입력하면 이 브라우저가 등록됩니다.');
      const joined = await this.client.rpc('serotonin_join_test_board', { code });
      if (joined.error) throw new Error('접속 코드 확인 실패: ' + joined.error.message + ' · setup.sql 실행 여부를 확인해 주세요.');
      if (joined.data?.member !== true)
        throw new Error(
          joined.data?.error === 'locked' ? '접속 코드를 여러 번 틀렸습니다. 1시간 뒤 다시 시도해 주세요.' : '접속 코드가 맞지 않습니다.',
        );
    }
    return { id: user.id, kind: user.is_anonymous ? 'anonymous' : 'account' };
  }
  // Revisions never change, so after a full first read only rows saved since the last read are fetched. The window overlaps by two
  // minutes (a transaction can commit slightly out of saved_at order) and every 20th read is a full re-read as a safety net.
  async list(previous = new Map()) {
    const user = await this.session();
    this.reads = (this.reads || 0) + 1;
    const full = !previous.size || !this.mark || this.reads % FULL_RELOAD_EVERY === 0;
    const merged = full ? new Map() : new Map(previous);
    const since = full ? null : new Date(this.mark - OVERLAP_MS).toISOString();
    let newest = full ? 0 : this.mark;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = this.client
        .from('serotonin_test_events')
        .select('event, saved_at')
        .order('saved_at', { ascending: true })
        .order('id', { ascending: true });
      if (since) query = query.gte('saved_at', since);
      const result = await query.range(offset, offset + PAGE_SIZE - 1);
      if (result.error) throw new Error('클라우드 기록 읽기 실패: ' + result.error.message);
      // Row-level security hides rows from non-members instead of failing, so an empty board needs a membership check.
      if (full && offset === 0 && !result.data.length && !(await this.checkMembership(user)))
        throw new Error('접속 코드 등록이 필요합니다. 연결 설정에서 관리자에게 받은 접속 코드를 입력해 주세요.');
      for (const row of result.data) {
        const event = requireEvent(row.event);
        merged.set(event.id, event);
        newest = Math.max(newest, Date.parse(row.saved_at) || 0);
      }
      if (merged.size > this.cfg.maxEvents) throw new Error('시험판 기록 한도에 도달했습니다.');
      if (result.data.length < PAGE_SIZE) break;
    }
    this.mark = newest || this.mark;
    return [...merged.values()];
  }
  async append(event) {
    await this.session();
    const result = await this.client.rpc('serotonin_append_test_event', { input: event });
    if (result.error) throw new Error('클라우드 저장 실패: ' + result.error.message);
    const stored = requireEvent(result.data);
    if (
      stored.id !== event.id ||
      stored.noteId !== event.noteId ||
      canonical(stored.note) !== canonical(event.note) ||
      canonical(stored.parents) !== canonical(event.parents)
    )
      throw new Error('저장 서비스의 기록 내용이 요청과 다릅니다.');
    const readback = await this.client.from('serotonin_test_events').select('event').eq('id', event.id).single();
    if (readback.error || canonical(readback.data?.event) !== canonical(stored))
      throw new Error('클라우드 저장 후 내용 확인에 실패했습니다.');
    return stored;
  }
}

if (typeof window !== 'undefined') {
  window.createBoardStorage = (cfg, options) =>
    cfg.backend === 'supabase' ? new SupabaseStorage(cfg, options) : new RouterStorage(cfg, options);
  window.validateSupabaseConfig = publicSupabaseConfig;
  window.BoardSigning = signing;
}
