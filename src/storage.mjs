import { createClient } from '@supabase/supabase-js';
import * as signing from './signing.mjs';
import * as cache from './cache.mjs';

const { canonical } = signing;
export const FILE_BUCKET = 'board-files',
  MAX_FILE_BYTES = 50 * 1024 * 1024,
  MAX_KEEP_MINUTES = 7 * 24 * 60;
const PAGE_SIZE = 500,
  OVERLAP_MS = 120000,
  FULL_RELOAD_AFTER_MS = 7 * 24 * 3600 * 1000; // a safety net for rows an administrator removed on the server

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
      const captchaToken = await this.captchaToken();
      const created = await this.client.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
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
  // Where the incremental read stopped; saved with the browser cache so the next page open continues from there.
  exportState() {
    return { mark: this.mark || 0, fullAt: this.fullAt || 0 };
  }
  importState(state) {
    if (state && Number.isFinite(state.mark) && Number.isFinite(state.fullAt)) {
      this.mark = state.mark;
      this.fullAt = state.fullAt;
    }
  }
  forceFull() {
    this.mark = 0;
    this.fullAt = 0;
  }
  async checkMembership(user) {
    const result = await this.client.rpc('serotonin_test_connection');
    if (result.error) throw new Error('테스트 저장소 연결 실패: ' + result.error.message + ' · setup.sql 실행 여부를 확인해 주세요.');
    if (result.data?.userId !== user.id) throw new Error('저장 서비스의 계정 확인 결과가 다릅니다.');
    this.dept = result.data.dept || null;
    return result.data.member === true;
  }
  // The access code is only needed once per temporary account; the server remembers the membership. An account belongs to
  // exactly one department: the code decides which, and a code for another department cannot move an existing member.
  async connect({ code, name } = {}) {
    const user = await this.session();
    let already = false;
    if (await this.checkMembership(user)) already = !!code;
    else {
      if (!code)
        throw new Error('접속 코드를 입력해 주세요. 부서 관리자에게 받은 코드를 한 번 입력하면 이 브라우저가 그 부서에 등록됩니다.');
      const joined = await this.client.rpc('serotonin_join_test_board', { code, display_name: name || null });
      if (joined.error) throw new Error('접속 코드 확인 실패: ' + joined.error.message + ' · setup.sql 실행 여부를 확인해 주세요.');
      if (joined.data?.member !== true)
        throw new Error(
          joined.data?.error === 'locked' ? '접속 코드를 여러 번 틀렸습니다. 1시간 뒤 다시 시도해 주세요.' : '접속 코드가 맞지 않습니다.',
        );
      this.dept = joined.data.dept || null;
    }
    return { id: user.id, kind: user.is_anonymous ? 'anonymous' : 'account', dept: this.dept, already };
  }
  // Revisions never change, so after a full first read only rows saved since the last read are fetched. The window overlaps by two
  // minutes (a transaction can commit slightly out of saved_at order) and a full re-read happens weekly (or on request) as a safety net.
  async list(previous = new Map()) {
    const user = await this.session();
    if (!this.dept) await this.checkMembership(user);
    if (!this.dept) {
      const error = new Error('접속 코드 등록이 필요합니다. 연결 설정에서 부서 관리자에게 받은 접속 코드를 입력해 주세요.');
      error.code = 'NOT_MEMBER';
      throw error;
    }
    const full = !previous.size || !this.mark || Date.now() - (this.fullAt || 0) > FULL_RELOAD_AFTER_MS;
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
    if (full) this.fullAt = Date.now();
    return [...merged.values()];
  }
  // ===== Restore from a backup file, administrator functions, bot check =====
  opsMessage(error) {
    const text = String(error?.message || error || '');
    const known = [
      [/Administrator required/, '관리자 권한이 필요합니다. 관리자 코드를 입력해 주세요.'],
      [/Department id already exists/, '이미 있는 부서 ID입니다.'],
      [/Invalid department id/, '부서 ID는 영문 소문자, 숫자, -, _ 2~30자로 정해 주세요.'],
      [/Invalid department name/, '부서 이름은 1~40자로 정해 주세요.'],
      [/Quota must be/, '파일 용량은 10~1000MB 사이로 정해 주세요.'],
      [/Unknown department/, '없는 부서입니다.'],
      [/Invalid revision time/, '백업 파일의 기록 시각이 올바르지 않습니다.'],
      [/Parent revision/, '백업 파일의 이전 수정 기록이 맞지 않습니다.'],
      [/already used/, '다른 부서의 기록과 번호가 겹쳐 복원할 수 없습니다.'],
      [/requires a parent/, '같은 메모의 다른 처음 기록이 이미 있어 복원할 수 없습니다.'],
      [/revision limit/, '기록 한도(20,000건)에 도달했습니다.'],
      [/Access code required/, '접속 코드 등록이 필요합니다.'],
    ];
    for (const [pattern, message] of known) if (pattern.test(text)) return message;
    return text;
  }
  async restoreEvents(batch) {
    await this.session();
    const result = await this.client.rpc('serotonin_restore_events', { p_events: batch });
    if (result.error) throw new Error(this.opsMessage(result.error));
    return result.data;
  }
  async adminCall(name, args) {
    await this.session();
    const result = await this.client.rpc(name, args);
    if (result.error)
      throw new Error(
        this.opsMessage(result.error) +
          (/function .* does not exist|Could not find the function/.test(result.error.message)
            ? ' · setup.sql 실행 여부를 확인해 주세요.'
            : ''),
      );
    return result.data;
  }
  adminIsAdmin() {
    return this.adminCall('serotonin_is_admin');
  }
  async adminLogin(code) {
    const data = await this.adminCall('serotonin_admin_login', { p_code: code });
    if (data?.admin !== true)
      throw new Error(
        data?.error === 'locked' ? '관리자 코드를 여러 번 틀렸습니다. 1시간 뒤 다시 시도해 주세요.' : '관리자 코드가 맞지 않습니다.',
      );
    return true;
  }
  adminOverview() {
    return this.adminCall('serotonin_admin_overview');
  }
  adminCreateDept(id, name, rotating) {
    return this.adminCall('serotonin_admin_dept_create', { p_id: id, p_name: name, p_rotating: rotating });
  }
  adminSaveDept(id, name, rotating, quotaMb) {
    return this.adminCall('serotonin_admin_dept_save', { p_id: id, p_name: name, p_rotating: rotating, p_quota_mb: quotaMb });
  }
  adminNewCode(id) {
    return this.adminCall('serotonin_admin_dept_newcode', { p_id: id });
  }
  adminRemoveMember(userId) {
    return this.adminCall('serotonin_admin_member_remove', { p_user: userId });
  }
  // Cloudflare Turnstile token for anonymous sign-ins, only when the project turned the bot check on (config.turnstileSiteKey).
  async captchaToken() {
    const siteKey = this.cfg.turnstileSiteKey;
    if (!siteKey) return undefined;
    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error('봇 방지 확인 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
        document.head.append(script);
      });
    }
    return new Promise((resolve, reject) => {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:50';
      document.body.append(holder);
      const finish = (fn, value) => {
        holder.remove();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('봇 방지 확인이 끝나지 않았습니다. 다시 시도해 주세요.')), 60000);
      window.turnstile.render(holder, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        callback: token => (clearTimeout(timer), finish(resolve, token)),
        'error-callback': () => (clearTimeout(timer), finish(reject, new Error('봇 방지 확인에 실패했습니다. 다시 시도해 주세요.'))),
      });
    });
  }
  // ===== File sharing (private bucket, same department only, kept at most 7 days) =====
  fileMessage(error) {
    const text = String(error?.message || error || '');
    const known = [
      [/space is full/, '부서 파일 공간이 가득 찼습니다. 쓰지 않는 파일을 삭제해 주세요.'],
      [/Too many uploads/, '짧은 시간에 너무 많이 올렸습니다. 잠시 뒤 다시 시도해 주세요.'],
      [/50 MB/, '파일은 하나당 50MB까지 올릴 수 있습니다.'],
      [/Retention/, '보관 기간은 1분 이상 7일 이하로 정해 주세요.'],
      [/Access code required/, '접속 코드 등록이 필요합니다.'],
      [/Upload is not complete/, '업로드가 끝까지 되지 않았습니다. 다시 올려 주세요.'],
      [/still stored/, '파일이 아직 저장소에 남아 있습니다.'],
    ];
    for (const [pattern, message] of known) if (pattern.test(text)) return message;
    return text;
  }
  async fileList() {
    await this.session();
    const result = await this.client.rpc('serotonin_file_list');
    if (result.error)
      throw new Error('파일 목록을 읽지 못했습니다: ' + this.fileMessage(result.error) + ' · setup.sql 실행 여부를 확인해 주세요.');
    return result.data;
  }
  async fileBegin({ name, size, mime, minutes }) {
    await this.session();
    const result = await this.client.rpc('serotonin_file_begin', {
      p_name: name,
      p_size: size,
      p_mime: mime || null,
      p_keep_minutes: minutes,
    });
    if (result.error) throw new Error(this.fileMessage(result.error));
    return result.data;
  }
  // XMLHttpRequest instead of fetch so the page can show upload progress and cancel an upload.
  async fileUpload(path, file, { onProgress, signal } = {}) {
    await this.session();
    const session = (await this.client.auth.getSession()).data.session;
    if (!session) throw new Error('로그인 상태를 확인하지 못했습니다. 연결을 다시 확인해 주세요.');
    const base = new URL(this.options.url()).origin;
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', file);
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', base + '/storage/v1/object/' + FILE_BUCKET + '/' + path);
      xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
      xhr.setRequestHeader('apikey', this.options.key());
      xhr.setRequestHeader('x-upsert', 'false');
      if (onProgress) xhr.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let detail = '';
        try {
          detail = JSON.parse(xhr.responseText).message || '';
        } catch {
          /* not JSON */
        }
        reject(new Error('업로드에 실패했습니다 (' + xhr.status + ')' + (detail ? ': ' + detail : '')));
      };
      xhr.onerror = () => reject(new Error('네트워크 오류로 업로드가 끊겼습니다. 다시 시도해 주세요.'));
      xhr.onabort = () => reject(Object.assign(new Error('업로드를 취소했습니다.'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) return xhr.abort();
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(body);
    });
  }
  async fileFinish(id) {
    const result = await this.client.rpc('serotonin_file_finish', { p_id: id });
    if (result.error) throw new Error(this.fileMessage(result.error));
    return result.data;
  }
  // A signed address that works for one minute and forces a download (never opens the file inside this site).
  async fileDownloadUrl(file) {
    await this.session();
    const result = await this.client.storage.from(FILE_BUCKET).createSignedUrl(file.path, 60, { download: file.name });
    if (result.error || !result.data?.signedUrl) throw new Error('내려받을 주소를 만들지 못했습니다. 이미 삭제되었을 수 있습니다.');
    return result.data.signedUrl;
  }
  // The stored object is removed through the Storage API first (deleting rows with SQL would leave the bytes behind);
  // only then is its record forgotten.
  async fileRemove(file) {
    await this.session();
    const removed = await this.client.storage.from(FILE_BUCKET).remove([file.path]);
    if (removed.error) throw new Error('파일을 삭제하지 못했습니다: ' + removed.error.message);
    const forgot = await this.client.rpc('serotonin_file_forget', { p_id: file.id });
    if (forgot.error) throw new Error(this.fileMessage(forgot.error));
    return true;
  }
  // Removes expired files (and uploads that never finished) of this department; any member's browser can do it.
  async filePurge() {
    await this.session();
    const expired = await this.client.rpc('serotonin_file_expired');
    if (expired.error) throw new Error(this.fileMessage(expired.error));
    let removed = 0;
    for (const file of expired.data || []) {
      try {
        await this.fileRemove(file);
        removed++;
      } catch {
        /* retried on the next purge */
      }
    }
    return removed;
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
  window.BoardCache = cache;
}
