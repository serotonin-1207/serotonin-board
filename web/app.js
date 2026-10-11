'use strict';
(() => {
  const core = window.BoardCore;
  const cfg = window.BOARD_CONFIG;
  const cloud = cfg.backend === 'supabase';
  const storageLabel = cloud ? 'Supabase' : 'SSD';
  const $ = id => document.getElementById(id);
  const statuses = { todo: '미처리', doing: '진행 중', done: '완료' };
  const SCHEDULE = core.SCHEDULE_CATEGORY;
  const HANDOVER = core.HANDOVER_CATEGORY;
  const MEMO_CATEGORIES = core.MEMO_CATEGORIES;
  const TEMPLATE = core.TEMPLATE_CATEGORY;
  const BULLET = /^\s*(?:[-*•▢☐□☑✔]|\d+[.)])\s*/;
  // Department (Supabase backend): rotating = 24h shifts with the day changing at 09:00; office departments use plain dates.
  let rotating = true,
    deptName = '';
  function todayKey() {
    return rotating ? core.dutyDay(Date.now()) : core.koreanDay(Date.now());
  }
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const MAX_VISIBLE_CHIPS = 3;
  let calMode = getSetting('calMode') === 'week' ? 'week' : 'month';
  let calendarMonth = monthOf(todayKey()),
    selectedDay = todayKey(),
    lastToday = selectedDay,
    handoverDay = selectedDay,
    handoverBusy = false;
  let view = 'all',
    status = 'all',
    query = '',
    notes = [],
    events = new Map();
  let synced = false,
    writeConnected = false,
    syncing = null,
    editing = null,
    saving = false,
    toastTimer;
  let author = getSetting('author'),
    routerOrigin = getSetting('routerOrigin') || defaultOrigin();
  let cloudUrl = getSetting('supabaseUrl') || cfg.supabaseUrl || '',
    cloudKey = getSetting('publishableKey') || cfg.publishableKey || '';
  let clientId = getSetting('clientId') || randomId();
  setSetting('clientId', clientId);
  let identity = null;
  // Author proof (router board only): registry of public keys maintained by the administrator, and this browser's signing key.
  const signing = !!cfg.signing && !!window.BoardSigning;
  let registry = new Map(),
    registryError = '',
    signer = null;
  let storage = window.createBoardStorage(cfg, { routerOrigin: () => routerOrigin, url: () => cloudUrl, key: () => cloudKey });
  // Router login address: the board's own host when it is served by the router, otherwise the router's factory address.
  function defaultOrigin() {
    const fallback = cfg.routerOrigin || 'http://192.168.0.1';
    const local = !location.hostname || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return local || !['http:', 'https:'].includes(location.protocol) ? fallback : location.protocol + '//' + location.hostname;
  }
  function getSetting(name) {
    try {
      return localStorage.getItem('serotonin-board.' + (cfg.backend ? cfg.backend + '.' : '') + name) || '';
    } catch {
      return '';
    }
  }
  function setSetting(name, value) {
    try {
      localStorage.setItem('serotonin-board.' + (cfg.backend ? cfg.backend + '.' : '') + name, value);
    } catch {
      /* Settings are optional. */
    }
  }
  function randomId() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 4500);
  }
  function showMessage(id, message, success = false) {
    $(id).textContent = message;
    $(id).hidden = false;
    $(id).classList.toggle('success', success);
  }
  function timeLabel(at) {
    const delta = Math.max(0, Date.now() - Date.parse(at));
    if (delta < 60000) return '방금 전';
    if (delta < 3600000) return Math.floor(delta / 60000) + '분 전';
    if (core.koreanDay(at) === core.koreanDay(Date.now()))
      return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(
        new Date(at),
      );
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' }).format(new Date(at));
  }
  function absoluteTime(at) {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  }
  async function refresh() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const records = await storage.list(events);
        const next = new Map(records.map(record => [record.id, record]));
        const updated = core.buildNotes([...next.values()]);
        if (signing) await loadRegistry();
        notes = updated;
        events = next;
        applyDept(storage.dept);
        synced = true;
        scheduleCacheSave();
        $('connection-notice').hidden = true;
        $('connection-status').textContent = storageLabel + (writeConnected ? ' 공유 저장 연결됨' : ' 공유 자료 연결됨');
        $('sidebar-storage').replaceChildren(
          document.createTextNode(storageLabel + ' 연결됨'),
          el('small', '', writeConnected ? '저장 후 내용을 다시 확인합니다' : '작성하려면 저장 연결을 확인하세요'),
        );
        $('status-dot').className = 'status-dot connected';
        $('storage-dot').className = 'storage-dot connected';
        $('last-sync').textContent =
          '마지막 확인 ' +
          new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).format(new Date()) +
          ' · 15초마다 갱신';
        render();
      } catch (error) {
        if (error.code === 'NOT_MEMBER') {
          events = new Map();
          notes = [];
          const key = cacheKey();
          if (key && window.BoardCache) window.BoardCache.remove(key);
        }
        synced = false;
        $('connection-status').textContent = '공유 자료 연결 확인 필요';
        $('status-dot').className = 'status-dot error-dot';
        $('storage-dot').className = 'storage-dot error-dot';
        $('sidebar-storage').replaceChildren(
          document.createTextNode(storageLabel + ' 연결 확인 필요'),
          el('small', '', cloud ? '프로젝트 설정과 인터넷 연결을 확인하세요' : '게스트 로그인과 URL 서비스를 확인하세요'),
        );
        $('connection-notice').textContent = error.message + ' 연결이 복구되면 새로고침해 주세요. 작성 중인 내용은 닫지 않고 유지합니다.';
        $('connection-notice').hidden = false;
        render();
        throw error;
      }
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }
  function applyDept(info) {
    if (!info) return;
    const next = info.rotating !== false,
      name = info.name || '';
    const changed = next !== rotating || name !== deptName;
    rotating = next;
    deptName = name;
    if (!changed) return;
    // The day is counted differently now, so every "today" is recomputed.
    lastToday = todayKey();
    selectedDay = lastToday;
    handoverDay = lastToday;
    calendarMonth = monthOf(lastToday);
    document.querySelector('.workspace small').textContent = (deptName ? deptName + ' · ' : '') + (cloud ? 'Supabase' : '공유기 게스트');
    renderDuty();
  }
  function updateProfile() {
    $('avatar').textContent = author ? author.slice(0, 1) : '?';
    $('profile-name').replaceChildren(
      document.createTextNode(author || '작성자 연결'),
      el('small', '', writeConnected ? storageLabel + ' 공유 저장 연결됨' : '공유 저장을 연결하세요'),
    );
  }
  async function loadRegistry() {
    try {
      registry = window.BoardSigning.registryMap(await storage.registry());
      registryError = '';
    } catch (error) {
      registryError = error.message;
    }
    updateSigningUi();
  }
  function loadSigner() {
    const seed = getSetting('signingSeed');
    try {
      return seed ? window.BoardSigning.identityFromSeed(seed) : null;
    } catch {
      return null;
    }
  }
  function ensureSigner() {
    signer = signer || loadSigner();
    if (!signer) {
      signer = window.BoardSigning.createIdentity();
      setSetting('signingSeed', signer.seed);
    }
    return signer;
  }
  function signState(event) {
    return signing ? window.BoardSigning.checkEvent(event, registry) : { state: 'unsigned' };
  }
  const signLabels = {
    verified: s => '서명 확인 · 등록 이름 ' + s.name,
    unregistered: () => '서명 있음 · 등록되지 않은 열쇠',
    invalid: () => '서명이 맞지 않음 · 내용이 바뀌었을 수 있습니다',
    unsigned: () => '서명 없음 · 이름 미인증',
  };
  const signBadges = { verified: '✓ 인증', unregistered: '미등록', invalid: '⚠ 서명 오류', unsigned: '미인증' };
  function updateSigningUi() {
    $('signing-box').hidden = !signing;
    if (!signing) return;
    signer = signer || loadSigner();
    $('signing-public').value = signer ? signer.publicKey : '연결 확인 시 자동으로 만들어집니다';
    const name = signer && registry.get(signer.publicKey);
    $('signing-status').textContent = registryError
      ? '등록 목록을 읽지 못했습니다: ' + registryError
      : !signer
        ? '아직 열쇠가 없습니다. 연결 확인을 누르면 이 브라우저에 만들어집니다.'
        : name
          ? '관리자 등록 완료 · ' + name + ' 이름으로 인증됩니다.'
          : '관리자 등록 대기 · 아래 등록 정보를 관리자에게 전달하세요. 그전에는 서명이 있어도 “미등록”으로 표시됩니다.';
  }
  async function copyText(text, message) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const input = el('textarea');
        input.value = text;
        input.style.position = 'fixed';
        input.style.top = '-9999px';
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw Error();
      }
      toast(message);
    } catch {
      prompt('이 내용을 복사해 주세요.', text);
    }
  }
  function monthOf(day) {
    const [year, month] = day.split('-').map(Number);
    return { year, month };
  }
  function dayLabel(day, withYear = false) {
    const [year, month, date] = day.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
    return (withYear ? year + '년 ' : '') + month + '월 ' + date + '일 (' + weekday + ')';
  }
  function scheduleRange(note) {
    return note.endDate && note.endDate !== note.date
      ? dayLabel(note.date, true) + ' ~ ' + dayLabel(note.endDate, true)
      : dayLabel(note.date, true);
  }
  function render() {
    // Calendar schedules and handover items live in the same revision store but never appear on the memo board (except in the trash).
    const memos = notes.filter(n => n.category !== SCHEDULE && n.category !== HANDOVER && n.category !== TEMPLATE);
    const active = memos.filter(n => !n.deleted);
    $('stat-total').textContent = active.length;
    $('nav-total').textContent = active.length;
    $('stat-open').textContent = active.filter(n => n.status !== 'done').length;
    $('stat-done').textContent = active.filter(n => n.status === 'done').length;
    $('stat-pinned').textContent = active.filter(n => n.pinned).length;
    const pending = core.handoverOn(notes, todayKey(), rotating).filter(item => !item.done).length;
    $('nav-handover').textContent = pending;
    $('nav-handover').hidden = !pending;
    if (view === 'files') {
      renderFiles();
      return;
    }
    if (view === 'handover') {
      renderHandover();
      return;
    }
    if (view === 'calendar') {
      renderCalendar();
      return;
    }
    const filtered = (view === 'trash' ? notes : memos).filter(n => {
      if (view === 'trash' ? !n.deleted : n.deleted) return false;
      if (MEMO_CATEGORIES.includes(view) && n.category !== view) return false;
      if (view === 'done' && n.status !== 'done') return false;
      if (status !== 'all' && n.status !== status) return false;
      return (n.title + ' ' + n.content + ' ' + n.author).toLocaleLowerCase('ko-KR').includes(query);
    });
    $('result-count').textContent = filtered.length;
    $('note-grid').replaceChildren(...filtered.map(card));
    $('empty-state').hidden = filtered.length > 0;
    const first = active.length === 0 && view !== 'trash' && !query && status === 'all';
    $('empty-title').textContent = !synced
      ? '공유 저장 연결이 필요합니다.'
      : first
        ? '첫 번째 기록을 남겨 보세요.'
        : view === 'trash'
          ? '휴지통이 비어 있어요.'
          : '찾는 메모가 없습니다.';
    $('empty-description').textContent = !synced
      ? cloud
        ? '연결 설정에서 Supabase 프로젝트를 연결해 주세요.'
        : 'SSD 폴더와 URL 서비스를 확인한 뒤 새로고침해 주세요.'
      : first
        ? '새 메모를 작성하면 같은 보드에 접속한 동료도 볼 수 있어요.'
        : view === 'trash'
          ? '휴지통으로 옮긴 메모는 수정 기록에서 복구할 수 있어요.'
          : '검색어나 분류, 처리 상태를 바꿔 보세요.';
    $('empty-new').hidden = !first || !synced;
  }
  function card(note) {
    const article = el('article', 'note-card' + (note.pinned ? ' is-pinned' : ''));
    article.dataset.noteId = note.id;
    const top = el('div', 'note-card-top');
    top.append(
      el(
        'span',
        'category-chip' + (note.category === '공지사항' ? ' notice-chip' : note.category === '업무 메모' ? ' memo-chip' : ''),
        note.category,
      ),
    );
    if (note.pinned) {
      const pin = icon('pin');
      pin.classList.add('card-pin');
      pin.setAttribute('aria-label', '중요 메모');
      top.append(pin);
    }
    top.append(el('span', 'status-chip ' + note.status, note.deleted ? '휴지통' : statuses[note.status]));
    const title = el('button', 'note-title-button', note.title);
    title.onclick = () => (note.deleted ? showHistory(note.id) : openEditor(note.id));
    const body = el(
      'p',
      'note-body',
      note.category === SCHEDULE
        ? note.kind + ' · ' + scheduleRange(note) + (note.content ? '\n' + note.content : '')
        : note.content || '내용 없이 제목만 남긴 메모입니다.',
    );
    const bottom = el('div', 'card-footer');
    bottom.append(el('span', 'card-avatar', note.author.slice(0, 1)), el('span', 'card-author', note.author));
    if (signing) {
      const proof = signState(note.heads[note.heads.length - 1]);
      const badge = el('span', 'sign-badge ' + proof.state, signBadges[proof.state]);
      badge.title = signLabels[proof.state](proof);
      bottom.append(badge);
    }
    const time = el('time', 'card-time', timeLabel(note.at));
    time.dateTime = note.at;
    time.title = absoluteTime(note.at);
    const history = el('button', 'history-button');
    history.title = '수정 기록';
    history.setAttribute('aria-label', note.title + ' 수정 기록');
    history.append(icon('clock'));
    history.onclick = () => showHistory(note.id);
    bottom.append(time, history);
    article.append(top);
    if (note.conflict) article.append(el('p', 'conflict-label', '동시 수정 ' + note.heads.length + '개 · 수정 기록에서 모두 확인하세요.'));
    article.append(title, body, bottom);
    return article;
  }
  function settings() {
    $('author-name').value = author;
    $('router-origin').value = routerOrigin || defaultOrigin();
    $('supabase-url').value = cloudUrl;
    $('supabase-key').value = cloudKey;
    $('settings-result').hidden = true;
    updateSigningUi();
    $('settings-dialog').showModal();
  }
  function setEditorMode(schedule, handover = false) {
    $('category-field').hidden = handover;
    $('assignee-field').hidden = !handover;
    $('memo-fields').hidden = schedule;
    $('schedule-fields').hidden = !schedule;
    $('note-pinned').closest('label').hidden = schedule;
    $('schedule-date').required = schedule;
    $('note-title').placeholder = schedule
      ? '예: 홍길동 연차, 소방 안전 교육'
      : handover
        ? '넘겨줄 내용을 한 줄로 적어 주세요'
        : '무엇을 함께 확인할까요?';
  }
  async function openEditor(id, options = {}) {
    if (!author || !writeConnected) {
      settings();
      return;
    }
    if (!synced) {
      toast('공유 자료 연결을 먼저 확인해 주세요.');
      return;
    }
    const note = notes.find(n => n.id === id);
    if (note?.conflict) {
      showHistory(id);
      return;
    }
    const schedule = note ? note.category === SCHEDULE : !!options.schedule;
    const handover = note ? note.category === HANDOVER : !!options.handover;
    editing = {
      id: note?.id || randomId(),
      key: core.headKey(note),
      parents: note ? note.heads.map(e => e.id) : [],
      isNew: !note,
      schedule,
      handover,
    };
    setEditorMode(schedule, handover);
    $('editor-title').textContent = (schedule ? '일정 ' : handover ? '인수인계 ' : '메모 ') + (note ? '수정' : '추가');
    $('note-title').value = note?.title || options.title || '';
    $('note-content').value = note?.content || '';
    $('note-assignee').value = note?.assignee || options.assignee || '';
    if (schedule) {
      $('schedule-kind').value = note?.kind || core.SCHEDULE_KINDS[0];
      $('schedule-date').value = note?.date || options.date || selectedDay;
      $('schedule-end').value = note?.endDate || '';
      $('note-category').value = core.CATEGORIES[0];
    } else {
      $('note-category').value = MEMO_CATEGORIES.includes(note?.category)
        ? note.category
        : MEMO_CATEGORIES.includes(view)
          ? view
          : MEMO_CATEGORIES[1];
    }
    $('note-status').value = note?.status || 'todo';
    $('note-pinned').checked = note?.pinned || false;
    $('editor-author').textContent = '작성자 · ' + author;
    $('editor-history-label').textContent = note
      ? '최초 작성 · ' + note.history[0].note.author + ' · 수정 기록 ' + note.history.length + '개'
      : '';
    $('note-trash').hidden = !note;
    $('editor-message').hidden = true;
    $('save-note').disabled = false;
    disarm();
    editing.snapshot = editorSnapshot();
    $('editor-dialog').showModal();
    $('note-title').focus();
  }
  async function commit(noteId, expectedKey, note, parents) {
    if (!author || !writeConnected) throw new Error('작성자와 공유 저장 연결을 먼저 확인해 주세요.');
    await refresh();
    const current = notes.find(n => n.id === noteId);
    if (core.headKey(current) !== expectedKey)
      throw new Error(
        '다른 사람이 이 메모를 먼저 수정했습니다. 입력 내용은 유지됩니다. 닫기 전에 복사해 두고 최신 메모와 수정 기록을 확인해 주세요.',
      );
    const event = {
      schema: 1,
      id: randomId(),
      noteId,
      parents,
      at: new Date().toISOString(),
      note: { ...note, author },
      actor: { id: clientId, kind: 'display-only' },
    };
    if (!core.validEvent(event)) throw new Error('제목과 작성자 이름, 메모 길이를 확인해 주세요.');
    const outgoing = signing ? window.BoardSigning.signEvent(event, ensureSigner().seed) : event;
    if (events.size >= cfg.maxEvents) throw new Error('시험판 기록 한도에 도달했습니다. 백업 후 저장 구조 확장이 필요합니다.');
    let stored;
    try {
      stored = await storage.append(outgoing);
    } catch (error) {
      writeConnected = false;
      updateProfile();
      throw error;
    }
    // Only a read-back verified immutable revision is shown as saved.
    events.set(stored.id, stored);
    notes = core.buildNotes([...events.values()]);
    render();
    try {
      await refresh();
    } catch {
      /* The verified event remains saved; connection banner reports read failure. */
    }
    const result = notes.find(n => n.id === noteId);
    if (result?.conflict) toast(storageLabel + '에 저장했습니다. 동시 수정 기록이 있어 내용 확인이 필요합니다.');
    else toast(storageLabel + '에 저장하고 내용을 확인했습니다.');
  }
  function formNote(deleted = false) {
    if (editing.schedule) {
      const note = {
        title: $('note-title').value.trim(),
        content: $('note-content').value,
        category: SCHEDULE,
        status: 'todo',
        pinned: false,
        deleted,
        author,
        kind: $('schedule-kind').value,
        date: $('schedule-date').value,
      };
      // endDate stays absent for single-day schedules so the stored revision has no empty field.
      if ($('schedule-end').value && $('schedule-end').value !== note.date) note.endDate = $('schedule-end').value;
      return note;
    }
    const note = {
      title: $('note-title').value.trim(),
      content: $('note-content').value,
      category: editing.handover ? HANDOVER : $('note-category').value,
      status: $('note-status').value,
      pinned: $('note-pinned').checked,
      deleted,
      author,
    };
    // The person in charge is optional and only exists on handover items; an empty box removes it.
    if (editing.handover && $('note-assignee').value.trim()) note.assignee = $('note-assignee').value.trim();
    return note;
  }
  function scheduleError() {
    const start = $('schedule-date').value,
      end = $('schedule-end').value;
    if (!end) return '';
    if (end < start) return '종료일은 시작일과 같거나 이후여야 합니다.';
    if (core.daysBetween(start, end) > core.MAX_SCHEDULE_DAYS)
      return '일정은 최대 ' + core.MAX_SCHEDULE_DAYS + '일까지 한 번에 등록할 수 있습니다.';
    return '';
  }
  async function saveEditor(deleted = false) {
    if (saving || !editing) return;
    if (!$('editor-form').reportValidity()) return;
    const problem = editing.schedule && !deleted ? scheduleError() : '';
    if (problem) {
      showMessage('editor-message', problem);
      return;
    }
    saving = true;
    $('save-note').disabled = true;
    $('note-trash').disabled = true;
    $('editor-message').hidden = true;
    try {
      await commit(editing.id, editing.key, formNote(deleted), editing.parents);
      $('editor-dialog').close();
      editing = null;
    } catch (error) {
      showMessage('editor-message', error.message);
    } finally {
      saving = false;
      $('save-note').disabled = false;
      $('note-trash').disabled = false;
    }
  }
  // Everything the editor can change, to tell real edits from an untouched form.
  function editorSnapshot() {
    return JSON.stringify(
      ['note-title', 'note-content', 'note-category', 'note-status', 'note-assignee', 'schedule-kind', 'schedule-date', 'schedule-end']
        .map(id => $(id).value)
        .concat($('note-pinned').checked),
    );
  }
  // Two-step confirmation inside the dialog: browser confirm() boxes can be blocked (embedded browsers), which left the dialog impossible to close.
  // The first press only arms the button (its label changes and a toast explains); the same press again within 6 seconds confirms.
  let pendingConfirm = null,
    pendingTimer,
    armedButton = null;
  function disarm() {
    clearTimeout(pendingTimer);
    pendingConfirm = null;
    if (armedButton) {
      armedButton.lastChild.textContent = armedButton.dataset.label;
      armedButton.classList.remove('armed');
      armedButton = null;
    }
  }
  function confirmAgain(key, message, button, armedLabel) {
    if (pendingConfirm === key) {
      disarm();
      return true;
    }
    disarm();
    pendingConfirm = key;
    armedButton = button;
    button.dataset.label = button.lastChild.textContent;
    button.lastChild.textContent = armedLabel;
    button.classList.add('armed');
    showMessage('editor-message', message);
    toast(message + ' 같은 버튼을 한 번 더 누르면 진행합니다.');
    pendingTimer = setTimeout(() => {
      if (pendingConfirm === key) {
        disarm();
        $('editor-message').hidden = true;
      }
    }, 6000);
    return false;
  }
  function closeEditor() {
    if (saving) return;
    if (
      editing &&
      editorSnapshot() !== editing.snapshot &&
      !confirmAgain('close', '저장하지 않은 변경이 있습니다. 닫으면 사라집니다.', $('editor-cancel'), '변경 버리고 닫기')
    )
      return;
    disarm();
    $('editor-dialog').close();
    editing = null;
  }
  function showHistory(id) {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    $('history-intro').textContent = note.conflict
      ? '동시에 수정한 내용이 모두 보관되어 있습니다. 아래 내용을 확인하고 사용할 기록을 선택하거나 복구 후 다시 수정하세요.'
      : '수정할 때마다 이전 내용을 남깁니다. 복구하면 선택한 내용으로 새로운 수정 기록을 만듭니다.';
    $('history-list').replaceChildren(
      ...[...note.history].reverse().map(event => {
        const item = el('article', 'history-item');
        const header = el('header');
        header.append(el('span', '', event.note.author), el('time', '', absoluteTime(event.at)));
        const actorLabel = event.actor
          ? (event.actor.kind === 'restored'
              ? '백업에서 복원됨 · 복원한 계정'
              : event.actor.kind === 'display-only'
                ? '브라우저 표식 · 이름 미인증'
                : event.actor.kind === 'anonymous'
                  ? '임시 계정 · 이름 미인증'
                  : '인증 계정 · 등록 이름 확인 필요') +
            ' · ' +
            event.actor.id.slice(0, 8)
          : '이전 기록 · 계정 정보 없음';
        item.append(el('p', 'identity-label', actorLabel));
        if (signing) {
          const proof = signState(event);
          const line = el('p', 'identity-label sign-line ' + proof.state, signLabels[proof.state](proof));
          if (proof.state === 'verified' && proof.name !== event.note.author)
            line.textContent += ' (입력한 이름: ' + event.note.author + ')';
          item.append(line);
        }
        item.append(header, el('h3', '', event.note.title + (event.note.deleted ? ' · 휴지통' : '')));
        if (event.note.category === SCHEDULE) item.append(el('p', 'schedule-detail', event.note.kind + ' · ' + scheduleRange(event.note)));
        item.append(el('p', '', event.note.content || '내용 없음'));
        const isHead = note.heads.some(e => e.id === event.id);
        const button = el(
          'button',
          'secondary',
          note.conflict && isHead ? '이 내용으로 정리' : note.deleted ? '이 내용으로 복구' : '이 내용으로 복원',
        );
        button.disabled = !writeConnected || (!note.deleted && !note.conflict && event.id === note.eventId);
        button.onclick = async () => {
          button.disabled = true;
          try {
            await commit(
              id,
              core.headKey(note),
              { ...event.note, deleted: false },
              note.heads.map(e => e.id),
            );
            $('history-dialog').close();
          } catch (error) {
            toast(error.message);
            button.disabled = false;
          }
        };
        item.append(button);
        return item;
      }),
    );
    $('history-dialog').showModal();
  }

  // ===== 인수인계 =====
  function handoverWritable() {
    if (!author || !writeConnected) {
      settings();
      return false;
    }
    if (!synced) {
      toast('공유 자료 연결을 먼저 확인해 주세요.');
      return false;
    }
    return true;
  }
  function plainNote(note) {
    return {
      title: note.title,
      content: note.content,
      category: note.category,
      status: note.status,
      pinned: note.pinned,
      deleted: note.deleted,
      assignee: note.assignee,
    };
  }
  // A quick change (check, star) is applied on top of the freshest revision, so it never fails because someone else saved first.
  async function quickChange(noteId, patch) {
    if (!handoverWritable()) return false;
    try {
      await refresh();
      const current = notes.find(n => n.id === noteId);
      if (!current) throw new Error('항목을 찾지 못했습니다. 새로고침해 주세요.');
      if (current.conflict) {
        showHistory(noteId);
        return false;
      }
      await commit(
        noteId,
        core.headKey(current),
        { ...plainNote(current), ...patch },
        current.heads.map(e => e.id),
      );
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }
  async function toggleDone(item, checkbox) {
    if (handoverBusy) {
      checkbox.checked = !checkbox.checked;
      return;
    }
    handoverBusy = true;
    checkbox.disabled = true;
    const wanted = checkbox.checked;
    const ok = await quickChange(item.note.id, { status: wanted ? 'done' : 'todo' });
    handoverBusy = false;
    if (!ok) renderHandover();
  }
  // "@홍길동 펌프 점검" puts the person in charge in front of the text; bullets and numbers are removed.
  function parseHandoverLine(line) {
    if (typeof line !== 'string') return { title: String(line.title || '').trim(), assignee: line.assignee || '' };
    let title = line.replace(BULLET, '').trim(),
      assignee = '';
    const match = /^@(\S{1,40})\s+(.+)$/.exec(title);
    if (match) {
      assignee = match[1];
      title = match[2].trim();
    }
    return { title, assignee };
  }
  async function addHandover(lines, { max = 20, clearInput = true } = {}) {
    if (!handoverWritable()) return 0;
    const clean = lines.map(parseHandoverLine).filter(item => item.title);
    if (!clean.length) return 0;
    if (clean.length > max) {
      toast('한 번에 ' + max + '개까지 추가할 수 있습니다.');
      return 0;
    }
    if (clean.some(item => item.title.length > 120)) {
      toast('항목은 120자까지 쓸 수 있습니다. 긴 내용은 "자세히"에 적어 주세요.');
      return 0;
    }
    handoverBusy = true;
    $('ho-submit').disabled = true;
    $('ho-input').disabled = true;
    let added = 0;
    try {
      for (const item of clean) {
        const note = { title: item.title, content: '', category: HANDOVER, status: 'todo', pinned: false, deleted: false };
        if (item.assignee) note.assignee = item.assignee;
        await commit(randomId(), '', note, []);
        added++;
      }
      if (clearInput) $('ho-input').value = '';
    } catch (error) {
      const next = clean[added];
      if (clearInput && next) $('ho-input').value = (next.assignee ? '@' + next.assignee + ' ' : '') + next.title;
      toast(error.message + (added ? ' (' + added + '개는 추가했습니다)' : ''));
    } finally {
      handoverBusy = false;
      $('ho-submit').disabled = false;
      $('ho-input').disabled = false;
      if (clearInput) $('ho-input').focus();
    }
    return added;
  }
  function carryLabel(item) {
    return item.carriedDays > 0 ? '이월 ' + (item.carriedDays + 1) + '일째' : '오늘 작성';
  }
  function handoverRow(item, editable) {
    const note = item.note;
    const li = el('li', 'ho-item' + (item.done ? ' is-done' : '') + (item.pinned ? ' is-pinned' : ''));
    const box = el('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.disabled = !editable;
    box.setAttribute('aria-label', note.title + (item.done ? ' 완료 해제' : ' 완료'));
    box.onchange = () => toggleDone(item, box);
    const text = el('div', 'ho-text');
    const title = el('button', 'ho-title', note.title);
    title.type = 'button';
    title.title = '눌러서 내용 수정';
    title.disabled = !editable;
    title.onclick = () => openEditor(note.id);
    text.append(title);
    if (note.content) text.append(el('p', 'ho-content', note.content));
    const meta = el('p', 'ho-meta');
    if (item.carriedDays > 0 && !item.done) meta.append(el('span', 'ho-carry', carryLabel(item)));
    else if (item.carriedDays > 0) meta.append(el('span', '', '이월 ' + (item.carriedDays + 1) + '일 만에 완료'));
    if (item.state.note.status === 'doing' && !item.done) meta.append(el('span', 'ho-doing', '진행 중'));
    const owner = item.state.note.assignee;
    if (owner) meta.append(el('span', 'ho-assignee' + (author && owner === author ? ' mine' : ''), '담당 ' + owner));
    const who = item.done ? item.state.note.author + ' 완료' : item.state.note.author;
    const when = el('time', '', timeLabel(item.state.at));
    when.dateTime = item.state.at;
    when.title = absoluteTime(item.state.at);
    meta.append(el('span', '', who), when);
    text.append(meta);
    const star = el('button', 'ho-icon' + (item.pinned ? ' on' : ''));
    star.type = 'button';
    star.append(icon('pin'));
    star.title = item.pinned ? '중요 표시 해제' : '중요 표시';
    star.setAttribute('aria-label', note.title + ' ' + star.title);
    star.setAttribute('aria-pressed', String(item.pinned));
    star.disabled = !editable;
    star.onclick = async () => {
      star.disabled = true;
      if (!(await quickChange(note.id, { pinned: !item.pinned }))) renderHandover();
    };
    const take = el('button', 'ho-icon' + (owner && owner === author ? ' on' : ''));
    take.type = 'button';
    take.append(icon('user'));
    take.title = owner && owner === author ? '담당 해제' : '내가 맡기';
    take.setAttribute('aria-label', note.title + ' ' + take.title);
    take.disabled = !editable || !author;
    take.onclick = async () => {
      take.disabled = true;
      if (!(await quickChange(note.id, { assignee: owner && owner === author ? undefined : author }))) renderHandover();
    };
    const history = el('button', 'ho-icon');
    history.type = 'button';
    history.append(icon('clock'));
    history.title = '수정 기록';
    history.setAttribute('aria-label', note.title + ' 수정 기록');
    history.onclick = () => showHistory(note.id);
    li.append(box, text, take, star, history);
    return li;
  }
  function renderHandover() {
    const today = todayKey();
    if (handoverDay > today) handoverDay = today;
    const day = handoverDay,
      isToday = day === today,
      editable = isToday,
      mineOnly = $('ho-mine').checked && !!author,
      items = core.handoverOn(notes, day, rotating).filter(item => !mineOnly || item.state.note.assignee === author),
      open = items.filter(item => !item.done),
      done = items.filter(item => item.done);
    $('ho-title').textContent = dayLabel(day, true) + (isToday ? ' · 오늘' : '');
    $('ho-date').value = day;
    $('ho-date').max = today;
    $('ho-next').disabled = isToday;
    $('ho-prev').disabled = day <= '2000-01-01';
    const carried = open.filter(item => item.carriedDays > 0).length;
    const carriedText = carried ? ' · 어제까지 끝나지 않은 ' + carried + '건을 가져왔습니다' : '';
    $('ho-sub').textContent = isToday
      ? rotating
        ? core.teamOn(day) + '팀 근무일 · ' + dayLabel(day) + ' 09:00 ~ ' + dayLabel(core.addDays(day, 1)) + ' 09:00' + carriedText
        : dayLabel(day) + (carriedText ? carriedText : '')
      : '지난 날짜의 기록입니다 (읽기 전용). 그날 체크한 상태 그대로 보여 줍니다.';
    const percent = items.length ? Math.round((done.length / items.length) * 100) : 0;
    $('ho-bar-fill').style.width = percent + '%';
    $('ho-bar').setAttribute('aria-valuenow', String(percent));
    $('ho-count').textContent = items.length ? done.length + ' / ' + items.length + ' 완료' : '항목 없음';
    $('ho-add').hidden = !isToday;
    $('ho-open-count').textContent = open.length;
    $('ho-done-count').textContent = done.length;
    const empty = text => el('li', 'ho-empty', text);
    $('ho-open').replaceChildren(
      ...(open.length
        ? open.map(item => handoverRow(item, editable))
        : [empty(synced ? (isToday ? '남은 일이 없습니다.' : '이날 남은 일이 없었습니다.') : '공유 저장 연결 후 표시됩니다.')]),
    );
    $('ho-done').replaceChildren(
      ...(done.length ? done.map(item => handoverRow(item, editable)) : [empty('완료한 항목이 여기에 쌓입니다.')]),
    );
    const days = el('div', 'ho-day-list');
    for (let back = 0; back < 14; back++) {
      const d = core.addDays(today, -back),
        list = core.handoverOn(notes, d, rotating),
        finished = list.filter(item => item.done).length;
      const chip = el('button', 'ho-day' + (d === day ? ' active' : '') + (list.length ? '' : ' empty'));
      chip.type = 'button';
      chip.append(
        el('strong', '', Number(d.slice(5, 7)) + '/' + Number(d.slice(8)) + (back === 0 ? ' 오늘' : '')),
        el('span', '', list.length ? finished + '/' + list.length + ' 완료' : '기록 없음'),
      );
      chip.setAttribute('aria-label', dayLabel(d, true) + (list.length ? ' ' + finished + '/' + list.length + ' 완료' : ' 기록 없음'));
      chip.onclick = () => {
        handoverDay = d;
        renderHandover();
      };
      days.append(chip);
    }
    $('ho-days').replaceChildren(days);
  }
  function moveHandoverDay(delta) {
    const next = core.addDays(handoverDay, delta);
    if (next > todayKey() || next < '2000-01-01') return;
    handoverDay = next;
    renderHandover();
  }
  $('ho-mine').checked = getSetting('hoMine') === '1';
  $('ho-mine').onchange = () => {
    setSetting('hoMine', $('ho-mine').checked ? '1' : '');
    renderHandover();
  };
  $('ho-prev').onclick = () => moveHandoverDay(-1);
  $('ho-next').onclick = () => moveHandoverDay(1);
  $('ho-today').onclick = () => {
    handoverDay = todayKey();
    renderHandover();
  };
  $('ho-date').onchange = event => {
    const value = event.target.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01') handoverDay = value > todayKey() ? todayKey() : value;
    renderHandover();
  };
  $('ho-add').onsubmit = event => {
    event.preventDefault();
    addHandover($('ho-input').value.split(/\r?\n/));
  };
  $('ho-input').addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text') || '';
    if (/\r?\n/.test(text.trim())) {
      event.preventDefault();
      addHandover(text.split(/\r?\n/));
    }
  });
  $('ho-detail').onclick = () => {
    const title = $('ho-input').value.trim();
    $('ho-input').value = '';
    openEditor(undefined, { handover: true, title });
  };
  $('ho-copy').onclick = () => {
    const items = core.handoverOn(notes, handoverDay, rotating),
      line = item =>
        (item.done ? '☑ ' : '☐ ') +
        item.note.title +
        (item.state.note.assignee ? ' [담당 ' + item.state.note.assignee + ']' : '') +
        (item.carriedDays > 0 && !item.done ? ' (' + carryLabel(item) + ')' : '') +
        (item.note.content ? '\n    ' + item.note.content.replace(/\n/g, '\n    ') : '');
    const open = items.filter(item => !item.done),
      done = items.filter(item => item.done);
    const text = [
      '[인수인계] ' + dayLabel(handoverDay, true) + (rotating ? ' ' + core.teamOn(handoverDay) + '팀 근무' : ''),
      '',
      '■ 해야 할 일 (' + open.length + ')',
      ...(open.length ? open.map(line) : ['없음']),
      '',
      '■ 완료 (' + done.length + ')',
      ...(done.length ? done.map(line) : ['없음']),
    ].join('\n');
    copyText(text, '인수인계 목록을 복사했습니다.');
  };

  // ===== 자주 쓰는 목록 (템플릿) =====
  // A template is a saved note (category 템플릿): the name is the title, one handover item per line is the content.
  let editingTemplate = null;
  const normalizeTitle = text => text.toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
  // One item per line; bullets are removed and a line that repeats an earlier one (ignoring case and spacing) is dropped.
  const templateLines = content => {
    const seen = new Set();
    return content
      .split(/\r?\n/)
      .map(line => line.replace(BULLET, '').trim())
      .filter(line => line && !seen.has(normalizeTitle(line)) && seen.add(normalizeTitle(line)));
  };
  function templateList() {
    return notes.filter(n => n.category === TEMPLATE && !n.deleted).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  }
  function renderTemplates() {
    const list = templateList();
    $('tpl-list').replaceChildren(
      ...(list.length
        ? list.map(note => {
            const lines = templateLines(note.content);
            const card = el('div', 'tpl-card');
            const info = el('div', 'tpl-info');
            info.append(
              el('strong', '', note.title),
              el('small', '', lines.length + '개 항목 · ' + lines.slice(0, 3).join(', ') + (lines.length > 3 ? ' …' : '')),
            );
            const load = el('button', 'primary', '오늘 목록에 불러오기');
            load.type = 'button';
            load.onclick = () => loadTemplate(note, load);
            const edit = el('button', 'secondary', '수정');
            edit.type = 'button';
            edit.onclick = () => showTemplateForm(note);
            card.append(info, load, edit);
            return card;
          })
        : [el('p', 'ho-empty', synced ? '저장한 목록이 없습니다. “새 목록 만들기”로 시작하세요.' : '공유 저장 연결 후 표시됩니다.')]),
    );
  }
  function showTemplateForm(note) {
    editingTemplate = note ? note.id : null;
    $('tpl-name').value = note?.title || '';
    $('tpl-lines').value = note ? templateLines(note.content).join('\n') : '';
    $('tpl-delete').hidden = !note;
    $('tpl-message').hidden = true;
    $('tpl-list-view').hidden = true;
    $('tpl-edit').hidden = false;
    $('tpl-name').focus();
  }
  function showTemplateList() {
    editingTemplate = null;
    $('tpl-edit').hidden = true;
    $('tpl-list-view').hidden = false;
    $('tpl-message').hidden = true;
    renderTemplates();
  }
  async function loadTemplate(note, button) {
    if (!handoverWritable()) return;
    const have = new Set(core.handoverOn(notes, todayKey(), rotating).map(item => normalizeTitle(item.state.note.title)));
    const lines = templateLines(note.content);
    const fresh = lines.filter(line => !have.has(normalizeTitle(line)));
    if (!fresh.length)
      return showMessage('tpl-message', '“' + note.title + '”의 항목이 오늘 목록에 모두 있어 새로 추가할 것이 없습니다.', true);
    button.disabled = true;
    showMessage('tpl-message', '불러오는 중… (' + fresh.length + '개)', true);
    const added = await addHandover(fresh, { max: 25, clearInput: false });
    button.disabled = false;
    if (!added) return showMessage('tpl-message', '항목을 추가하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    $('tpl-dialog').close();
    handoverDay = todayKey();
    if (view !== 'handover') setView('handover');
    else renderHandover();
    toast(
      '“' +
        note.title +
        '”에서 ' +
        added +
        '개를 불러왔습니다' +
        (lines.length - fresh.length ? ' (이미 있는 ' + (lines.length - fresh.length) + '개는 건너뜀)' : '') +
        '.',
    );
  }
  $('ho-templates').onclick = () => {
    showTemplateList();
    $('tpl-dialog').showModal();
  };
  $('tpl-close').onclick = () => $('tpl-dialog').close();
  $('tpl-new').onclick = () => showTemplateForm(null);
  $('tpl-cancel').onclick = showTemplateList;
  $('tpl-edit').onsubmit = async event => {
    event.preventDefault();
    if (!handoverWritable()) return;
    const name = $('tpl-name').value.trim(),
      lines = templateLines($('tpl-lines').value);
    if (!name) return showMessage('tpl-message', '목록 이름을 입력해 주세요.');
    if (!lines.length) return showMessage('tpl-message', '항목을 한 줄 이상 적어 주세요.');
    if (lines.length > 25) return showMessage('tpl-message', '한 목록에는 항목을 25개까지 넣을 수 있습니다.');
    if (lines.some(line => line.length > 120)) return showMessage('tpl-message', '항목은 한 줄에 120자까지 쓸 수 있습니다.');
    const button = $('tpl-save');
    button.disabled = true;
    try {
      const content = lines.join('\n');
      if (editingTemplate) {
        if (!(await quickChange(editingTemplate, { title: name, content }))) throw new Error('저장하지 못했습니다. 다시 시도해 주세요.');
      } else {
        await commit(randomId(), '', { title: name, content, category: TEMPLATE, status: 'todo', pinned: false, deleted: false }, []);
      }
      showTemplateList();
      showMessage('tpl-message', '“' + name + '” 목록을 저장했습니다.', true);
    } catch (error) {
      showMessage('tpl-message', error.message);
    }
    button.disabled = false;
  };
  twoStep($('tpl-delete'), '정말 삭제', async () => {
    if (editingTemplate && (await quickChange(editingTemplate, { deleted: true }))) {
      showTemplateList();
      showMessage('tpl-message', '목록을 삭제했습니다. 휴지통의 수정 기록에서 복구할 수 있습니다.', true);
    }
  });

  // ===== 파일 주고받기 =====
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  let fileData = { files: [], used: 0, quota: 0 },
    filesLoaded = false,
    filesBusy = false,
    lastPurge = 0,
    uploadSeq = 0;
  const uploads = new Map();
  function sizeLabel(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + 'MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + 'KB';
    return bytes + 'B';
  }
  function remainingLabel(expiresAt) {
    const minutes = Math.floor((Date.parse(expiresAt) - Date.now()) / 60000);
    if (minutes < 1) return '곧 삭제';
    if (minutes < 60) return minutes + '분 남음';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + '시간 ' + (minutes % 60) + '분 남음';
    return Math.floor(hours / 24) + '일 ' + (hours % 24) + '시간 남음';
  }
  // Anyone's browser removes this department's expired files; at most once every 10 minutes.
  async function purgeFiles(force = false) {
    if (!cloud || !storage.filePurge || (!force && Date.now() - lastPurge < 600000)) return;
    lastPurge = Date.now();
    try {
      await storage.filePurge();
    } catch {
      /* retried later */
    }
  }
  async function refreshFiles() {
    if (!cloud || !storage.fileList || !synced) return renderFiles();
    try {
      await purgeFiles();
      fileData = await storage.fileList();
      filesLoaded = true;
    } catch (error) {
      toast(error.message);
    }
    renderFiles();
  }
  function renderFiles() {
    const meter = fileData.quota ? Math.min(100, Math.round((fileData.used / fileData.quota) * 100)) : 0;
    $('file-meter-fill').style.width = meter + '%';
    $('file-meter').setAttribute('aria-valuenow', String(meter));
    $('file-meter-text').textContent = fileData.quota ? '부서 파일함 ' + sizeLabel(fileData.used) + ' / ' + sizeLabel(fileData.quota) : '';
    const list = fileData.files;
    if (!list.length) {
      $('file-list').replaceChildren(
        el('li', 'ho-empty', !synced ? '연결 후 파일이 표시됩니다.' : filesLoaded ? '아직 올린 파일이 없습니다.' : '불러오는 중…'),
      );
      return;
    }
    $('file-list').replaceChildren(
      ...list.map(file => {
        const li = el('li', 'file-item');
        const name = el('button', 'file-name', file.name);
        name.type = 'button';
        name.title = '눌러서 내려받기';
        name.onclick = () => downloadFile(file, name);
        const soon = Date.parse(file.expiresAt) - Date.now() < 3600000;
        const meta = el('p', 'ho-meta');
        meta.append(
          el('span', '', sizeLabel(file.size)),
          el('span', '', (file.by || '이름 없음') + ' 올림'),
          el('time', '', timeLabel(file.createdAt)),
        );
        meta.append(el('span', 'file-left' + (soon ? ' soon' : ''), remainingLabel(file.expiresAt)));
        const text = el('div', 'ho-text');
        text.append(name, meta);
        const get = el('button', 'secondary file-btn');
        get.type = 'button';
        get.append(icon('download'), document.createTextNode('내려받기'));
        get.onclick = () => downloadFile(file, get);
        const del = el('button', 'file-del');
        del.type = 'button';
        del.append(icon('trash'), document.createTextNode('삭제'));
        del.setAttribute('aria-label', file.name + ' 삭제');
        del.onclick = () => deleteFile(file, del);
        li.append(el('span', 'file-icon', (file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()), text, get, del);
        return li;
      }),
    );
  }
  async function downloadFile(file, button) {
    button.disabled = true;
    try {
      const url = await storage.fileDownloadUrl(file);
      const a = el('a');
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
    } catch (error) {
      toast(error.message);
      refreshFiles();
    } finally {
      setTimeout(() => (button.disabled = false), 1500);
    }
  }
  let deleteArmed = null,
    deleteTimer;
  async function deleteFile(file, button) {
    if (deleteArmed !== file.id) {
      deleteArmed = file.id;
      button.classList.add('armed');
      button.lastChild.textContent = '정말 삭제';
      toast('"' + file.name + '"을(를) 지웁니다. 같은 버튼을 한 번 더 누르면 바로 삭제되며 되돌릴 수 없습니다.');
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => {
        deleteArmed = null;
        renderFiles();
      }, 5000);
      return;
    }
    deleteArmed = null;
    button.disabled = true;
    try {
      await storage.fileRemove(file);
      toast('삭제했습니다.');
    } catch (error) {
      toast(error.message);
    }
    refreshFiles();
  }
  function keepMinutes() {
    const choice = $('file-keep').value;
    if (choice !== 'custom') return Number(choice);
    const at = Date.parse($('file-custom').value);
    if (!Number.isFinite(at)) throw new Error('삭제할 날짜와 시각을 정해 주세요.');
    const minutes = Math.ceil((at - Date.now()) / 60000);
    if (minutes < 1 || minutes > 7 * 24 * 60) throw new Error('삭제 시각은 지금부터 7일 이내여야 합니다.');
    return minutes;
  }
  function uploadRow(file) {
    const id = ++uploadSeq;
    const li = el('li', 'file-upload');
    const label = el('span', 'file-upload-name', file.name + ' · ' + sizeLabel(file.size));
    const bar = el('div', 'ho-bar');
    const fill = el('span');
    bar.append(fill);
    const state = el('span', 'file-upload-state', '준비 중…');
    const cancel = el('button', 'text-button', '취소');
    cancel.type = 'button';
    li.append(label, bar, state, cancel);
    $('file-uploads').append(li);
    const controller = new AbortController();
    cancel.onclick = () => controller.abort();
    uploads.set(id, controller);
    return {
      signal: controller.signal,
      progress: ratio => {
        fill.style.width = Math.round(ratio * 100) + '%';
        state.textContent = Math.round(ratio * 100) + '%';
      },
      status: text => (state.textContent = text),
      done: () => {
        uploads.delete(id);
        li.remove();
      },
      fail: message => {
        uploads.delete(id);
        li.classList.add('failed');
        state.textContent = message;
        cancel.textContent = '닫기';
        cancel.onclick = () => li.remove();
      },
    };
  }
  async function uploadFiles(fileList) {
    const picked = [...fileList];
    if (!picked.length || !handoverWritable()) return;
    let minutes;
    try {
      minutes = keepMinutes();
    } catch (error) {
      return toast(error.message);
    }
    await purgeFiles(true);
    for (const file of picked) {
      const row = uploadRow(file);
      try {
        if (!file.size) throw new Error('빈 파일은 올릴 수 없습니다.');
        if (file.size > MAX_FILE_BYTES)
          throw new Error('파일이 50MB 한도를 넘었습니다 (' + file.size.toLocaleString('ko-KR') + '바이트). 나누거나 줄여서 올려 주세요.');
        row.status('공간 확인 중…');
        const reserved = await storage.fileBegin({ name: file.name, size: file.size, mime: file.type, minutes });
        row.status('0%');
        try {
          await storage.fileUpload(reserved.path, file, { onProgress: row.progress, signal: row.signal });
          row.status('확인 중…');
          await storage.fileFinish(reserved.id);
        } catch (error) {
          // Give the reserved space back right away instead of waiting for the hourly cleanup.
          storage.fileRemove({ id: reserved.id, path: reserved.path }).catch(() => {});
          throw error;
        }
        row.done();
        toast('"' + file.name + '"을(를) 올렸습니다. ' + remainingLabel(reserved.expiresAt) + '.');
      } catch (error) {
        row.fail(error.name === 'AbortError' ? '취소했습니다.' : error.message);
      }
      await refreshFiles();
    }
  }
  $('file-pick').onclick = () => $('file-input').click();
  $('file-camera-button').onclick = () => $('file-camera').click();
  // Phones and tablets get a "take a photo" button that opens the camera directly.
  $('file-camera-button').hidden = !window.matchMedia('(pointer: coarse)').matches;
  for (const input of [$('file-input'), $('file-camera')])
    input.onchange = () => {
      const chosen = [...input.files];
      input.value = '';
      uploadFiles(chosen);
    };
  $('file-keep').onchange = () => {
    $('file-custom-wrap').hidden = $('file-keep').value !== 'custom';
    if (!$('file-custom-wrap').hidden) {
      const soon = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000);
      $('file-custom').value = soon.toISOString().slice(0, 16);
    }
  };
  for (const type of ['dragenter', 'dragover'])
    $('file-drop').addEventListener(type, event => (event.preventDefault(), $('file-drop').classList.add('over')));
  for (const type of ['dragleave', 'drop'])
    $('file-drop').addEventListener(type, event => (event.preventDefault(), $('file-drop').classList.remove('over')));
  $('file-drop').addEventListener('drop', event => uploadFiles(event.dataTransfer?.files || []));
  function setView(next) {
    view = next;
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const name =
      view === 'all'
        ? '전체 메모'
        : view === 'done'
          ? '완료한 메모'
          : view === 'trash'
            ? '휴지통'
            : view === 'calendar'
              ? '근무 달력'
              : view === 'handover'
                ? '인수인계'
                : view === 'files'
                  ? '파일'
                  : view;
    $('breadcrumb-view').textContent = name;
    $('page-title').textContent = view === 'all' ? '오늘의 기록을, 함께.' : name;
    $('page-subtitle').textContent =
      view === 'all'
        ? '인수인계부터 작은 업무 메모까지. 한곳에 남기고 함께 확인하세요.'
        : view === 'files'
          ? '같은 부서원끼리 주고받는 임시 파일함입니다. 올린 파일은 최대 7일 뒤 자동으로 삭제됩니다.'
          : view === 'handover'
            ? '체크해서 마무리하고, 끝나지 않은 일은 다음 근무일로 자동으로 넘어갑니다.'
            : view === 'calendar'
              ? '24시간 3팀 근무와 휴가·교육·교대·훈련 일정을 함께 확인하세요.'
              : view === 'trash'
                ? '필요한 기록은 수정 이력에서 다시 복구할 수 있어요.'
                : view === 'done'
                  ? '함께 마무리한 업무와 확인한 내용을 모아 봅니다.'
                  : '동료에게 전달할 내용을 남기고, 진행 상황을 함께 확인하세요.';
    $('section-title').firstChild.textContent = view === 'all' ? '함께 보는 메모 ' : name + ' ';
    const calendar = view === 'calendar',
      handover = view === 'handover',
      files = view === 'files';
    $('calendar-section').hidden = !calendar;
    $('handover-section').hidden = !handover;
    $('files-section').hidden = !files;
    $('board-section').hidden = calendar || handover || files;
    $('stats').hidden = calendar || handover || files;
    $('new-note').lastChild.textContent = calendar ? '일정 추가' : handover ? '항목 추가' : files ? '파일 선택' : '새 메모';
    render();
    if (handover) $('ho-input').focus({ preventScroll: true });
    if (files) refreshFiles();
  }
  function showMonth(year, month) {
    if (year < 2000 || year > 2099) return;
    calendarMonth = { year, month };
    const prefix = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
    if (!selectedDay.startsWith(prefix)) {
      const today = todayKey();
      selectedDay = today.startsWith(prefix) ? today : prefix + '-01';
    }
    renderCalendar();
  }
  function shiftMonth(delta) {
    if (calMode === 'week') {
      const next = core.addDays(selectedDay, delta * 7);
      if (next < '2000-01-01' || next > '2099-12-31') return;
      selectedDay = next;
      calendarMonth = monthOf(next);
      return renderCalendar();
    }
    const index = calendarMonth.year * 12 + calendarMonth.month - 1 + delta;
    showMonth(Math.floor(index / 12), (index % 12) + 1);
  }
  // The seven days (Sunday first) of the week that contains the given day.
  function weekDays(day) {
    const start = core.addDays(day, -new Date(day + 'T00:00:00Z').getUTCDay());
    return Array.from({ length: 7 }, (_, i) => core.addDays(start, i));
  }
  function setCalMode(mode) {
    calMode = mode;
    setSetting('calMode', mode);
    if (mode === 'month') calendarMonth = monthOf(selectedDay);
    renderCalendar();
  }
  function schedulesOn(day) {
    return notes
      .filter(n => n.category === SCHEDULE && !n.deleted && n.date <= day && day <= (n.endDate || n.date))
      .sort((a, b) => core.SCHEDULE_KINDS.indexOf(a.kind) - core.SCHEDULE_KINDS.indexOf(b.kind) || a.title.localeCompare(b.title, 'ko'));
  }
  function teamBadge(day) {
    const team = core.teamOn(day);
    return el('span', 'team-badge team-' + team, team + '팀');
  }
  function openSchedule(note) {
    openEditor(note.id);
  }
  function renderDuty() {
    $('duty-badge').hidden = !rotating;
    if (!rotating) return;
    const day = core.dutyDay(Date.now()),
      team = core.teamOn(day);
    $('duty-badge').textContent = '근무 ' + team + '팀';
    $('duty-badge').className = 'duty-badge team-' + team;
  }
  function renderCalendar() {
    const { year, month } = calendarMonth,
      week = calMode === 'week',
      prefix = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0'),
      today = todayKey(),
      days = week ? weekDays(selectedDay) : core.monthGrid(year, month);
    if (week) {
      const first = days[0],
        last = days[6];
      $('cal-title').textContent =
        Number(first.slice(0, 4)) +
        '년 ' +
        Number(first.slice(5, 7)) +
        '월 ' +
        Number(first.slice(8)) +
        '일 ~ ' +
        (first.slice(5, 7) === last.slice(5, 7) ? '' : Number(last.slice(5, 7)) + '월 ') +
        Number(last.slice(8)) +
        '일';
      $('cal-prev').disabled = first <= '2000-01-07';
      $('cal-next').disabled = last >= '2099-12-24';
    } else {
      $('cal-title').textContent = year + '년 ' + month + '월';
      $('cal-prev').disabled = year === 2000 && month === 1;
      $('cal-next').disabled = year === 2099 && month === 12;
    }
    $('cal-month').value = prefix;
    document.querySelector('.cal-jump').hidden = week;
    document.querySelectorAll('[data-calmode]').forEach(b => b.classList.toggle('active', b.dataset.calmode === calMode));
    $('cal-grid').className = 'calendar-grid' + (week ? ' week' : '');
    document.querySelector('.calendar-scroll').classList.toggle('week', week);
    $('cal-grid').replaceChildren(
      ...days.map(day => {
        const events = schedulesOn(day),
          weekday = new Date(day + 'T00:00:00Z').getUTCDay();
        const cell = el(
          'div',
          'cal-cell' +
            (week || day.startsWith(prefix) ? '' : ' outside') +
            (day === today ? ' today' : '') +
            (day === selectedDay ? ' selected' : '') +
            (weekday === 0 ? ' sun' : weekday === 6 ? ' sat' : ''),
        );
        cell.setAttribute('role', 'gridcell');
        cell.onclick = () => {
          selectedDay = day;
          if (!week && !day.startsWith(prefix)) calendarMonth = monthOf(day);
          renderCalendar();
        };
        const head = el('div', 'cal-cell-head');
        const number = el('button', 'cal-date', week ? Number(day.slice(5, 7)) + '/' + Number(day.slice(8)) : String(Number(day.slice(8))));
        number.setAttribute(
          'aria-label',
          dayLabel(day, true) +
            (rotating ? ' ' + core.teamOn(day) + '팀 근무' : '') +
            (events.length ? ' · 일정 ' + events.length + '개' : ''),
        );
        number.setAttribute('aria-pressed', String(day === selectedDay));
        head.append(number);
        if (week) head.append(el('span', 'cal-wd', WEEKDAYS[weekday] + '요일'));
        if (rotating) head.append(teamBadge(day));
        cell.append(head);
        const chips = el('div', 'cal-chips');
        for (const note of events.slice(0, week ? events.length : MAX_VISIBLE_CHIPS)) {
          const chip = el('button', 'cal-chip', note.title);
          chip.dataset.kind = note.kind;
          chip.title = note.kind + ' · ' + note.title + ' · ' + note.author;
          chip.onclick = event => {
            event.stopPropagation();
            selectedDay = day;
            openSchedule(note);
          };
          chips.append(chip);
        }
        if (!week && events.length > MAX_VISIBLE_CHIPS)
          chips.append(el('span', 'cal-more', '+' + (events.length - MAX_VISIBLE_CHIPS) + '개'));
        const dots = el('div', 'cal-dots');
        for (const note of events.slice(0, 4)) {
          const dot = el('span', 'cal-dot');
          dot.dataset.kind = note.kind;
          dots.append(dot);
        }
        cell.append(chips, dots);
        return cell;
      }),
    );
    renderDayPanel();
    renderDuty();
  }
  function renderDayPanel() {
    const day = selectedDay,
      events = schedulesOn(day),
      hour = String(core.SHIFT_START_HOUR).padStart(2, '0') + ':00';
    const head = el('div', 'day-panel-head');
    const title = el('div');
    title.append(el('h3', '', dayLabel(day, true)));
    if (rotating) title.append(el('p', '', core.teamOn(day) + '팀 근무 · ' + hour + ' ~ ' + dayLabel(core.addDays(day, 1)) + ' ' + hour));
    const add = el('button', 'secondary');
    add.append(icon('plus'), document.createTextNode('이 날 일정 추가'));
    add.onclick = () => openEditor(undefined, { schedule: true, date: day });
    head.append(title, add);
    const list = el('div', 'day-list');
    if (!events.length) list.append(el('p', 'day-empty', synced ? '등록된 일정이 없습니다.' : '공유 저장 연결 후 일정이 표시됩니다.'));
    for (const note of events) {
      const item = el('article', 'day-item');
      const kind = el('span', 'cal-kind', note.kind);
      kind.dataset.kind = note.kind;
      const text = el('div', 'day-item-text');
      text.append(el('strong', '', note.title), el('small', '', scheduleRange(note) + ' · ' + note.author));
      if (note.content) text.append(el('p', '', note.content));
      if (note.conflict) text.append(el('p', 'conflict-label', '동시 수정 ' + note.heads.length + '개 · 수정 기록에서 모두 확인하세요.'));
      const edit = el('button', 'secondary', note.conflict ? '기록 확인' : '수정');
      edit.onclick = () => openSchedule(note);
      const history = el('button', 'history-button');
      history.title = '수정 기록';
      history.setAttribute('aria-label', note.title + ' 수정 기록');
      history.append(icon('clock'));
      history.onclick = () => showHistory(note.id);
      item.append(kind, text, edit, history);
      list.append(item);
    }
    $('day-panel').replaceChildren(head, list);
  }
  document.querySelectorAll('[data-view]').forEach(b => (b.onclick = () => setView(b.dataset.view)));
  document.querySelectorAll('[data-status]').forEach(
    b =>
      (b.onclick = () => {
        status = b.dataset.status;
        document.querySelectorAll('[data-status]').forEach(x => x.classList.toggle('active', x === b));
        render();
      }),
  );
  $('search').oninput = event => {
    query = event.target.value.trim().toLocaleLowerCase('ko-KR');
    render();
  };
  $('new-note').onclick = () =>
    view === 'calendar'
      ? openEditor(undefined, { schedule: true, date: selectedDay })
      : view === 'handover'
        ? $('ho-input').focus()
        : view === 'files'
          ? $('file-pick').click()
          : openEditor();
  $('empty-new').onclick = () => openEditor();
  document.querySelectorAll('[data-calmode]').forEach(b => (b.onclick = () => setCalMode(b.dataset.calmode)));
  $('cal-prev').onclick = () => shiftMonth(-1);
  $('cal-next').onclick = () => shiftMonth(1);
  $('cal-today').onclick = () => {
    selectedDay = todayKey();
    calendarMonth = monthOf(selectedDay);
    renderCalendar();
  };
  $('cal-month').onchange = event => {
    const match = /^(\d{4})-(\d{2})$/.exec(event.target.value);
    if (match) showMonth(Number(match[1]), Number(match[2]));
    else renderCalendar();
  };
  $('refresh').onclick = async () => {
    const b = $('refresh');
    b.disabled = true;
    try {
      await refresh();
      toast('공유 기록을 새로 확인했습니다.');
    } catch (error) {
      toast(error.message);
    } finally {
      b.disabled = false;
    }
  };
  $('profile-button').onclick = $('settings-button').onclick = settings;
  $('settings-close').onclick = () => $('settings-dialog').close();
  $('router-login').onclick = () => {
    try {
      const url = new URL($('router-origin').value.trim() || defaultOrigin());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      window.open(url.href, 'serotonin-router-login', 'noopener');
    } catch {
      showMessage('settings-result', '공유기 로그인 주소를 확인해 주세요.');
    }
  };
  $('connect-storage').onclick = async () => {
    const name = $('author-name').value.trim();
    if (!name) {
      showMessage('settings-result', '메모에 표시할 이름을 입력해 주세요.');
      $('author-name').focus();
      return;
    }
    const b = $('connect-storage');
    b.disabled = true;
    showMessage(
      'settings-result',
      cloud ? '임시 계정과 클라우드 저장소를 확인하고 있습니다…' : '게스트 세션으로 SSD 저장을 확인하고 있습니다…',
    );
    try {
      if (cloud) {
        const next = window.validateSupabaseConfig($('supabase-url').value.trim(), $('supabase-key').value.trim());
        if (syncing) await syncing.catch(() => {});
        if (next.url !== cloudUrl || next.key !== cloudKey) {
          storage.client?.auth.stopAutoRefresh();
          events = new Map();
          notes = [];
          synced = false;
          writeConnected = false;
          cloudUrl = next.url;
          cloudKey = next.key;
          storage = window.createBoardStorage(cfg, { routerOrigin: () => routerOrigin, url: () => cloudUrl, key: () => cloudKey });
        }
        setSetting('supabaseUrl', cloudUrl);
        setSetting('publishableKey', cloudKey);
      } else {
        routerOrigin = $('router-origin').value.trim() || defaultOrigin();
        $('router-origin').value = routerOrigin;
        setSetting('routerOrigin', routerOrigin);
      }
      identity = await storage.connect({ code: cloud ? $('supabase-code').value.trim() : '', name });
      applyDept(identity.dept);
      if (signing) {
        ensureSigner();
        updateSigningUi();
      }
      await refresh();
      author = name;
      setSetting('author', author);
      writeConnected = true;
      updateProfile();
      await refresh();
      $('supabase-code').value = '';
      const typedCode = cloud && identity.already;
      showMessage(
        'settings-result',
        (deptName ? '[' + deptName + '] ' : '') +
          (typedCode ? '이 브라우저는 이미 이 부서에 등록되어 있어 코드는 다시 쓰지 않았습니다. ' : '') +
          '연결했습니다. 메모는 ' +
          storageLabel +
          '에서 공유됩니다.' +
          (identity.id
            ? ' 임시 계정: ' + identity.id.slice(0, 8)
            : signing
              ? ' 서명 열쇠가 준비되었습니다. 관리자가 등록하기 전에는 “미등록”으로 표시됩니다.'
              : ' 이름은 본인 인증이 아닙니다.'),
        true,
      );
    } catch (error) {
      writeConnected = false;
      updateProfile();
      showMessage('settings-result', error.message);
    } finally {
      b.disabled = false;
    }
  };
  $('editor-form').onsubmit = event => {
    event.preventDefault();
    saveEditor();
  };
  $('editor-close').onclick = $('editor-cancel').onclick = closeEditor;
  $('editor-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    closeEditor();
  });
  $('editor-dialog').addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      saveEditor();
    }
  });
  $('note-trash').onclick = () => {
    if (confirmAgain('trash', '휴지통으로 옮깁니다. 수정 기록에서 복구할 수 있습니다.', $('note-trash'), '정말 휴지통으로 이동'))
      saveEditor(true);
  };
  $('history-close').onclick = () => $('history-dialog').close();
  $('share-link').onclick = () => copyText(new URL('./index.html', location.href).href, '보드 링크를 복사했습니다.');
  $('signing-copy').onclick = () => {
    if (!signer) return showMessage('settings-result', '먼저 연결 확인을 눌러 서명 열쇠를 만들어 주세요.');
    const name = $('author-name').value.trim() || author;
    if (!name) return showMessage('settings-result', '표시 이름을 먼저 입력해 주세요.');
    copyText(JSON.stringify({ name, publicKey: signer.publicKey }), '등록 정보를 복사했습니다. 관리자에게 전달하세요.');
  };
  $('signing-backup').onclick = () => {
    if (!signer) return showMessage('settings-result', '아직 만들어진 열쇠가 없습니다.');
    prompt(
      '개인 열쇠입니다. 비밀번호처럼 보관하고 다른 사람에게 알려 주지 마세요. 분실하면 같은 이름으로 서명할 수 없습니다.',
      signer.seed,
    );
  };
  $('signing-restore').onclick = () => {
    const seed = (prompt('백업해 둔 개인 열쇠(64자리)를 입력해 주세요. 현재 열쇠는 교체됩니다.') || '').trim().toLowerCase();
    if (!seed) return;
    try {
      signer = window.BoardSigning.identityFromSeed(seed);
      setSetting('signingSeed', signer.seed);
      updateSigningUi();
      showMessage('settings-result', '개인 열쇠를 복원했습니다.', true);
    } catch (error) {
      showMessage('settings-result', error.message);
    }
  };
  // ===== 이 기기에 기록 저장 (브라우저 캐시) =====
  // Revisions never change, so what was received once is kept in this browser and only newer rows are fetched next time.
  let cacheTimer,
    cacheSaved = -1;
  function cacheKey() {
    try {
      if (cloud) return cloudUrl ? 'supabase|' + new URL(cloudUrl).hostname : '';
      return 'router|' + cfg.storagePath + '|' + location.origin;
    } catch {
      return '';
    }
  }
  // The temporary account the browser is signed in with: a cache is only reused by the account that created it.
  function currentUserId() {
    if (!cloud) return 'router';
    try {
      return JSON.parse(localStorage.getItem('serotonin-cloud-' + new URL(cloudUrl).hostname) || '{}')?.user?.id || '';
    } catch {
      return '';
    }
  }
  async function restoreCache() {
    const key = cacheKey();
    if (!key || !window.BoardCache) return;
    const saved = await window.BoardCache.load(key);
    const userId = currentUserId();
    if (!saved) return;
    if (saved.v !== 1 || !userId || saved.userId !== userId || !Array.isArray(saved.events)) {
      await window.BoardCache.remove(key); // another account used this browser before: never show its data
      return;
    }
    try {
      if (!saved.events.every(core.validEvent)) throw new Error('invalid');
      const restored = new Map(saved.events.map(e => [e.id, e]));
      notes = core.buildNotes([...restored.values()]);
      events = restored;
    } catch {
      events = new Map();
      notes = [];
      await window.BoardCache.remove(key);
      return;
    }
    storage.importState?.(saved.state);
    applyDept(saved.dept);
    cacheSaved = events.size;
    $('last-sync').textContent = '이 기기에 저장된 기록을 먼저 보여 주고 새 내용을 확인하는 중입니다…';
    render();
  }
  function scheduleCacheSave() {
    const key = cacheKey();
    if (!key || !window.BoardCache || events.size === cacheSaved) return;
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(async () => {
      const userId = currentUserId();
      if (!userId) return;
      const ok = await window.BoardCache.save(key, {
        v: 1,
        userId,
        dept: storage.dept || null,
        savedAt: Date.now(),
        state: storage.exportState?.() || null,
        events: [...events.values()],
      });
      if (ok) cacheSaved = events.size;
    }, 1500);
  }
  $('cache-clear').onclick = async () => {
    const key = cacheKey();
    if (key && window.BoardCache) await window.BoardCache.remove(key);
    cacheSaved = -1;
    showMessage('settings-result', '이 기기에 저장된 기록을 지웠습니다. 서버의 기록은 그대로입니다.', true);
  };
  $('cache-refull').onclick = async () => {
    const button = $('cache-refull');
    button.disabled = true;
    try {
      storage.forceFull?.();
      events = new Map();
      cacheSaved = -1;
      await refresh();
      showMessage('settings-result', '서버에서 모든 기록을 다시 받았습니다 (' + events.size + '건).', true);
    } catch (error) {
      showMessage('settings-result', error.message);
    } finally {
      button.disabled = false;
    }
  };

  // ===== 백업 복원 =====
  let restorePlan = null;
  $('restore-pick').onclick = () => $('restore-input').click();
  $('restore-input').onchange = async () => {
    const file = $('restore-input').files[0];
    $('restore-input').value = '';
    restorePlan = null;
    $('restore-run').hidden = true;
    if (!file) return;
    try {
      if (file.size > 60 * 1048576) throw new Error('백업 파일이 너무 큽니다.');
      const data = window.BoardExport.parseBackup(await file.text(), core.validEvent);
      const ordered = window.BoardExport.orderForRestore(data.events, [...events.keys()]);
      const same = data.department?.name && deptName && data.department.name !== deptName;
      restorePlan = ordered;
      showMessage(
        'restore-info',
        '백업 파일 ' +
          data.events.length.toLocaleString('ko-KR') +
          '건 중 이 보드에 없는 ' +
          ordered.length.toLocaleString('ko-KR') +
          '건을 복원합니다.' +
          (same ? ' ⚠ 이 백업은 “' + data.department.name + '” 부서의 것입니다. 지금 부서는 “' + deptName + '”입니다.' : '') +
          (ordered.length ? '' : ' 복원할 기록이 없습니다.'),
        !same,
      );
      $('restore-run').hidden = !ordered.length;
    } catch (error) {
      showMessage('restore-info', error.message);
    }
  };
  $('restore-run').onclick = async () => {
    if (!restorePlan?.length) return;
    const plan = restorePlan,
      button = $('restore-run');
    button.disabled = true;
    let added = 0,
      done = 0;
    try {
      for (let i = 0; i < plan.length; i += 200) {
        const result = await storage.restoreEvents(plan.slice(i, i + 200));
        added += result.added;
        done = Math.min(plan.length, i + 200);
        showMessage('restore-info', '복원 중… ' + done.toLocaleString('ko-KR') + ' / ' + plan.length.toLocaleString('ko-KR'), true);
      }
      restorePlan = null;
      button.hidden = true;
      storage.forceFull?.();
      events = new Map();
      cacheSaved = -1;
      await refresh();
      showMessage('restore-info', '복원했습니다. ' + added.toLocaleString('ko-KR') + '건을 다시 채웠습니다.', true);
    } catch (error) {
      showMessage(
        'restore-info',
        error.message + ' (' + done.toLocaleString('ko-KR') + '건까지 복원했습니다. 같은 파일로 다시 시도하면 이어서 복원됩니다.)',
      );
    } finally {
      button.disabled = false;
    }
  };

  // ===== 부서 관리(관리자) =====
  function twoStep(button, armedLabel, action) {
    const original = button.textContent;
    let timer;
    button.onclick = () => {
      if (button.classList.contains('armed')) {
        clearTimeout(timer);
        button.classList.remove('armed');
        button.textContent = original;
        return action();
      }
      button.classList.add('armed');
      button.textContent = armedLabel;
      timer = setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = original;
      }, 5000);
    };
  }
  function showNewCode(title, code) {
    const box = $('admin-code-box');
    box.hidden = false;
    const value = el('code', '', code);
    const copy = el('button', 'secondary', '복사');
    copy.type = 'button';
    copy.onclick = () => copyText(code, '접속 코드를 복사했습니다.');
    box.replaceChildren(
      el('strong', '', title),
      value,
      copy,
      el(
        'p',
        '',
        '이 코드는 지금만 볼 수 있습니다. 부서원에게만 따로 알려 주세요. 창을 닫으면 다시 볼 수 없고, 필요하면 새로 만들 수 있습니다.',
      ),
    );
    box.scrollIntoView({ block: 'nearest' });
  }
  let adminData = null;
  async function adminRefresh() {
    adminData = await storage.adminOverview();
    const depts = adminData.depts;
    $('admin-depts').replaceChildren(
      ...depts.map(d => {
        const card = el('div', 'admin-dept');
        const name = el('input');
        name.value = d.name;
        name.maxLength = 40;
        name.setAttribute('aria-label', d.id + ' 이름');
        const rot = el('input');
        rot.type = 'checkbox';
        rot.checked = d.rotating;
        const rotLabel = el('label', 'checkbox-label');
        rotLabel.append(rot, document.createTextNode('순환 근무'));
        const quota = el('input');
        quota.type = 'number';
        quota.min = 10;
        quota.max = 1000;
        quota.value = d.quotaMb;
        quota.setAttribute('aria-label', d.id + ' 파일 용량(MB)');
        const quotaLabel = el('label', '', '파일 용량(MB)');
        quotaLabel.append(quota);
        const save = el('button', 'secondary', '저장');
        save.type = 'button';
        save.onclick = async () => {
          save.disabled = true;
          try {
            await storage.adminSaveDept(d.id, name.value.trim(), rot.checked, Number(quota.value));
            showMessage('admin-message', '“' + name.value.trim() + '” 설정을 저장했습니다.', true);
            await adminRefresh();
          } catch (error) {
            showMessage('admin-message', error.message);
          }
          save.disabled = false;
        };
        const fresh = el('button', 'secondary', '새 접속 코드');
        fresh.type = 'button';
        twoStep(fresh, '정말 새 코드 발급', async () => {
          try {
            const made = await storage.adminNewCode(d.id);
            showNewCode('“' + d.name + '” 새 접속 코드 (이전 코드는 바로 쓸 수 없습니다)', made.code);
          } catch (error) {
            showMessage('admin-message', error.message);
          }
        });
        const info = el(
          'p',
          'admin-info',
          d.id + ' · 가입 ' + d.members + '명 · 기록 ' + d.events.toLocaleString('ko-KR') + '건 · 파일 ' + sizeLabel(d.filesBytes),
        );
        const fields = el('div', 'admin-fields');
        fields.append(name, rotLabel, quotaLabel);
        const actions = el('div', 'admin-actions');
        actions.append(save, fresh);
        card.append(info, fields, actions);
        return card;
      }),
    );
    const filter = $('admin-member-filter'),
      kept = filter.value;
    filter.replaceChildren(new Option('모든 부서', ''), ...depts.map(d => new Option(d.name, d.id)));
    filter.value = depts.some(d => d.id === kept) ? kept : '';
    renderAdminMembers();
    renderTelegram().catch(error => showMessage('admin-message', error.message));
  }
  function renderAdminMembers() {
    const names = new Map(adminData.depts.map(d => [d.id, d.name])),
      only = $('admin-member-filter').value;
    const rows = adminData.members.filter(m => !only || m.dept === only);
    if (!rows.length) return $('admin-members').replaceChildren(el('p', 'ho-empty', '가입자가 없습니다.'));
    $('admin-members').replaceChildren(
      ...rows.map(m => {
        const row = el('div', 'admin-member');
        const text = el('div');
        text.append(
          el('strong', '', m.name || '(이름 없음)'),
          el('small', '', (names.get(m.dept) || m.dept) + ' · ' + absoluteTime(m.joinedAt) + ' · 계정 ' + m.short),
        );
        const remove = el('button', 'file-del', '제거');
        remove.type = 'button';
        twoStep(remove, '정말 제거', async () => {
          try {
            await storage.adminRemoveMember(m.userId);
            showMessage('admin-message', '가입자를 제거했습니다. 이 계정은 다른 부서에 다시 가입할 수 있습니다.', true);
            await adminRefresh();
          } catch (error) {
            showMessage('admin-message', error.message);
          }
        });
        row.append(text, remove);
        return row;
      }),
    );
  }
  // ===== 텔레그램 일정 알림 (관리) =====
  let tgBotName = '';
  const tgCodes = new Map(); // one-time link codes, shown only until the screen is closed
  const minText = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const minValue = text => {
    const [h, m] = text.split(':').map(Number);
    return h * 60 + m;
  };
  async function checkBot() {
    const info = await storage.telegramCall('info');
    tgBotName = info?.ok ? info.username : '';
    $('tg-bot').textContent = info?.ok
      ? '봇 @' + info.username + ' 이(가) 연결되어 있습니다.'
      : info?.configured === false
        ? '봇 토큰이 아직 등록되지 않았습니다. 안내문의 토큰 등록 단계를 확인해 주세요.'
        : '봇을 확인하지 못했습니다: ' + (info?.message || '알 수 없는 오류');
  }
  async function renderTelegram() {
    const list = await storage.adminTelegramList();
    $('tg-depts').replaceChildren(
      ...list.map(d => {
        const card = el('div', 'admin-dept');
        const state = d.error
          ? '최근 오류: ' + d.error
          : !d.linked
            ? '대화방이 연결되지 않았습니다.'
            : d.enabled
              ? '알림을 보내는 중입니다.'
              : '대화방은 연결되었고 알림은 꺼져 있습니다.';
        card.append(el('strong', '', d.name), el('p', 'admin-info', state));
        const actions = el('div', 'admin-actions');
        const button = (label, onClick, two) => {
          const b = el('button', 'secondary', label);
          b.type = 'button';
          const safe = async () => {
            b.disabled = true;
            try {
              await onClick();
            } catch (error) {
              showMessage('admin-message', error.message);
            }
            b.disabled = false;
          };
          if (two) twoStep(b, two, safe);
          else b.onclick = safe;
          return b;
        };
        if (!d.linked) {
          const code = tgCodes.get(d.id);
          if (code) {
            const command = '/link' + (tgBotName ? '@' + tgBotName : '') + ' ' + code;
            card.append(
              el('p', 'admin-info', '텔레그램 대화방에서 아래 문장을 그대로 보낸 뒤 “연결 확인”을 누르세요. (15분 안에)'),
              el('code', 'tg-code', command),
            );
          }
          actions.append(
            button(code ? '새 코드 받기' : '대화방 연결', async () => {
              tgCodes.set(d.id, (await storage.adminTelegramLinkStart(d.id)).code);
              await renderTelegram();
            }),
          );
          if (code)
            actions.append(
              button('연결 확인', async () => {
                const result = await storage.telegramCall('link-check');
                if (!result?.ok) throw new Error(result?.message || '확인하지 못했습니다.');
                if (result.linked.includes(d.id)) {
                  tgCodes.delete(d.id);
                  showMessage('admin-message', '“' + d.name + '” 대화방이 연결되었습니다. 이제 알림을 켜 주세요.', true);
                } else
                  showMessage('admin-message', '아직 연결 문장을 찾지 못했습니다. 대화방에 보냈는지, 봇이 그 방에 있는지 확인해 주세요.');
                await renderTelegram();
              }),
            );
        } else {
          const on = el('input');
          on.type = 'checkbox';
          on.checked = d.enabled;
          const box = (label, checked) => {
            const input = el('input');
            input.type = 'checkbox';
            input.checked = checked;
            const wrap = el('label', 'checkbox-label');
            wrap.append(input, document.createTextNode(label));
            return [input, wrap];
          };
          const onLabel = el('label', 'checkbox-label');
          onLabel.append(on, document.createTextNode('알림 켜기'));
          const [morning, morningLabel] = box('아침 요약', d.morning);
          const [evening, eveningLabel] = box('저녁 예고', d.evening);
          const [changes, changesLabel] = box('일정 변경 알림', d.changes);
          const time = (label, value) => {
            const input = el('input');
            input.type = 'time';
            input.value = minText(value);
            const wrap = el('label', '', label);
            wrap.append(input);
            return [input, wrap];
          };
          const [morningAt, morningAtLabel] = time('아침 시각', d.morningMin);
          const [eveningAt, eveningAtLabel] = time('저녁 시각', d.eveningMin);
          const fields = el('div', 'tg-fields');
          fields.append(onLabel, morningLabel, morningAtLabel, eveningLabel, eveningAtLabel, changesLabel);
          card.append(fields);
          actions.append(
            button('저장', async () => {
              if (!morningAt.value || !eveningAt.value) throw new Error('알림 시각을 입력해 주세요.');
              await storage.adminTelegramSave(d.id, {
                enabled: on.checked,
                morning: morning.checked,
                evening: evening.checked,
                changes: changes.checked,
                morningMin: minValue(morningAt.value),
                eveningMin: minValue(eveningAt.value),
              });
              showMessage('admin-message', '“' + d.name + '” 알림 설정을 저장했습니다.', true);
              await renderTelegram();
            }),
            button('시험 메시지', async () => {
              const result = await storage.telegramCall('test', d.id);
              showMessage(
                'admin-message',
                result?.ok ? '시험 메시지를 보냈습니다. 대화방을 확인해 주세요.' : result?.message || '보내지 못했습니다.',
                result?.ok === true,
              );
            }),
            button(
              '연결 해제',
              async () => {
                await storage.adminTelegramUnlink(d.id);
                await renderTelegram();
              },
              '정말 연결 해제',
            ),
          );
        }
        card.append(actions);
        return card;
      }),
    );
  }
  $('tg-refresh').onclick = async () => {
    try {
      await checkBot();
    } catch (error) {
      showMessage('admin-message', error.message);
    }
  };
  async function openAdmin() {
    $('admin-message').hidden = true;
    $('admin-code-box').hidden = true;
    $('admin-code').value = '';
    $('admin-dialog').showModal();
    try {
      const admin = await storage.adminIsAdmin();
      $('admin-login').hidden = admin;
      $('admin-panel').hidden = !admin;
      if (admin) await adminRefresh();
    } catch (error) {
      $('admin-login').hidden = false;
      $('admin-panel').hidden = true;
      showMessage('admin-message', error.message);
    }
  }
  $('admin-open').onclick = openAdmin;
  $('admin-close').onclick = () => $('admin-dialog').close();
  $('admin-enter').onclick = async () => {
    const button = $('admin-enter');
    button.disabled = true;
    try {
      await storage.adminLogin($('admin-code').value.trim());
      $('admin-code').value = '';
      $('admin-message').hidden = true;
      $('admin-login').hidden = true;
      $('admin-panel').hidden = false;
      await adminRefresh();
    } catch (error) {
      showMessage('admin-message', error.message);
    }
    button.disabled = false;
  };
  $('admin-code').addEventListener('keydown', event => event.key === 'Enter' && $('admin-enter').click());
  $('admin-member-filter').onchange = renderAdminMembers;
  $('admin-create').onclick = async () => {
    const button = $('admin-create');
    button.disabled = true;
    try {
      const made = await storage.adminCreateDept(
        $('admin-new-id').value.trim(),
        $('admin-new-name').value.trim(),
        $('admin-new-rotating').checked,
      );
      showNewCode('“' + $('admin-new-name').value.trim() + '” 부서가 만들어졌습니다. 접속 코드', made.code);
      $('admin-new-id').value = '';
      $('admin-new-name').value = '';
      await adminRefresh();
    } catch (error) {
      showMessage('admin-message', error.message);
    }
    button.disabled = false;
  };

  // ===== 기록 내려받기 =====
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function exportKind(kind) {
    const ex = window.BoardExport;
    $('export-message').hidden = true;
    try {
      await refresh();
    } catch {
      /* Export what is already loaded when the server cannot be reached. */
    }
    if (!events.size) return showMessage('export-message', '내려받을 기록이 아직 없습니다.');
    const base = 'serotonin-' + (deptName.replace(/[\\/:*?"<>|\s]+/g, '-') || 'board') + '-' + todayKey() + '-';
    const csv = 'text/csv;charset=utf-8';
    if (kind === 'logbook') download(base + '인수인계일지.csv', ex.logbookCsv(core, notes, todayKey(), rotating, core.teamOn), csv);
    else if (kind === 'items') download(base + '항목목록.csv', ex.itemsCsv(notes), csv);
    else if (kind === 'revisions') download(base + '수정이력.csv', ex.revisionsCsv(events.values()), csv);
    else
      download(
        base + '백업.json',
        ex.backupJson(events.values(), { version: cfg.version, department: { name: deptName || null, rotating } }),
        'application/json',
      );
    showMessage('export-message', '파일을 내려받았습니다 (기록 ' + events.size + '건).', true);
  }
  document.querySelectorAll('[data-export]').forEach(b => (b.onclick = () => exportKind(b.dataset.export)));
  $('export-open').onclick = $('export-backup').onclick = () => {
    $('export-message').hidden = true;
    if ($('settings-dialog').open) $('settings-dialog').close();
    $('export-dialog').showModal();
  };
  $('export-close').onclick = () => $('export-dialog').close();
  function applyMode() {
    document.querySelectorAll('[data-router]').forEach(n => (n.hidden = cloud));
    document.querySelectorAll('[data-cloud]').forEach(n => (n.hidden = !cloud));
    if (cfg.backend) document.getElementById('comparison-link').hidden = false;
    document.title = (cloud ? 'Supabase' : '공유기 게스트') + ' 메모 보드 · Serotonin';
    document.querySelector('.workspace small').textContent = cloud ? 'Supabase · 별도 시험 저장소' : '공유기 게스트 · SSD 시험 폴더';
    document.querySelector('.pilot-badge').textContent = cloud ? 'Supabase 시험' : '게스트 시험';
    document.querySelector('.version').textContent = 'SEROTONIN BOARD · ' + cfg.version;
    document.querySelector('footer>span').lastChild.textContent = cloud
      ? '메모 원본은 Supabase에 보관합니다.'
      : '메모는 SSD의 게스트 시험 폴더에 보관합니다.';
    document.querySelector('.settings-intro').textContent = cloud
      ? '표시 이름과 자동 임시 계정으로 시험합니다. 공유기 로그인은 필요하지 않습니다.'
      : '게스트 계정으로 SSD에 저장하는 시험판입니다.';
    const step = document.getElementById('connect-storage').closest('.setup-step');
    step.firstElementChild.textContent = cloud ? '1' : '2';
    step.querySelector('strong').textContent = cloud ? '클라우드 저장 연결 확인' : '게스트 SSD 저장 연결 확인';
    step.querySelector('p').textContent = cloud
      ? '프로젝트 연결과 임시 계정을 확인합니다.'
      : '시험 파일을 저장하고 다시 읽어 쓰기 권한을 확인합니다.';
    document.querySelector('.pilot-notice strong').textContent = '공개 시험용입니다. 실제 업무자료는 입력하지 마세요.';
    document.querySelector('.pilot-notice p').textContent = cloud
      ? '표시 이름은 본인 인증이 아닙니다. 임시 계정은 브라우저 데이터 삭제나 기기 변경으로 이어지지 않을 수 있습니다.'
      : '표시 이름과 브라우저 표식은 본인 인증이 아닙니다. 게스트 계정은 관리자 계정과 구분해 사용하세요. 현재 읽기 인증은 꺼져 있습니다.';
    document.getElementById('save-note').firstChild.textContent = cloud ? 'Supabase에 저장' : 'SSD에 저장';
  }
  applyMode();
  function dateLabel() {
    $('today-date').textContent = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(new Date());
    renderDuty();
    if (view === 'files') renderFiles();
    const today = todayKey();
    if (today !== lastToday) {
      // The shift changed at 09:00: a handover list that was showing "today" rolls over to the new shift day.
      if (handoverDay === lastToday) handoverDay = today;
      lastToday = today;
      if (view === 'calendar' || view === 'handover') render();
    }
  }
  dateLabel();
  setInterval(dateLabel, 60000);
  updateProfile();
  // A returning member (saved name, existing temporary account) is connected again without pressing "연결 확인",
  // so a phone can open the board and upload right away.
  async function autoConnect() {
    if (!cloud || !author || !cloudUrl || !cloudKey || !currentUserId()) return;
    try {
      identity = await storage.connect({ name: author });
      applyDept(identity.dept);
      writeConnected = true;
      updateProfile();
    } catch {
      /* not a member (any more) or offline: the settings dialog explains what to do when writing is attempted */
    }
  }
  restoreCache()
    .catch(() => {})
    .then(autoConnect)
    .then(() => refresh().catch(() => {}));
  setInterval(() => {
    if (document.hidden || saving) return;
    refresh().catch(() => {});
    if (view === 'files' && !uploads.size) refreshFiles();
    else if (synced) purgeFiles();
  }, cfg.pollMilliseconds);
  // Coming back to the tab refreshes at once, but never more often than every 5 seconds (tab switching must not flood the server).
  let lastVisibleRefresh = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || saving || Date.now() - lastVisibleRefresh < 5000) return;
    lastVisibleRefresh = Date.now();
    refresh().catch(() => {});
  });
  window.addEventListener('beforeunload', event => {
    if ($('editor-dialog').open || uploads.size) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
})();
