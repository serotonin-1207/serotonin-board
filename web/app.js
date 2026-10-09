'use strict';
(() => {
  const core = window.BoardCore;
  const cfg = window.BOARD_CONFIG;
  const cloud = cfg.backend === 'supabase';
  const storageLabel = cloud ? 'Supabase' : 'SSD';
  const $ = id => document.getElementById(id);
  const statuses = { todo: '미처리', doing: '진행 중', done: '완료' };
  const SCHEDULE = core.SCHEDULE_CATEGORY;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const MAX_VISIBLE_CHIPS = 3;
  let calendarMonth = monthOf(core.koreanDay(Date.now())),
    selectedDay = core.koreanDay(Date.now()),
    lastToday = selectedDay;
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
        synced = true;
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
    // Calendar schedules live in the same revision store but never appear on the memo board (except in the trash).
    const memos = notes.filter(n => n.category !== SCHEDULE);
    const active = memos.filter(n => !n.deleted);
    $('stat-total').textContent = active.length;
    $('nav-total').textContent = active.length;
    $('stat-open').textContent = active.filter(n => n.status !== 'done').length;
    $('stat-done').textContent = active.filter(n => n.status === 'done').length;
    $('stat-pinned').textContent = active.filter(n => n.pinned).length;
    if (view === 'calendar') {
      renderCalendar();
      return;
    }
    const filtered = (view === 'trash' ? notes : memos).filter(n => {
      if (view === 'trash' ? !n.deleted : n.deleted) return false;
      if (core.CATEGORIES.includes(view) && n.category !== view) return false;
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
  function setEditorMode(schedule) {
    $('memo-fields').hidden = schedule;
    $('schedule-fields').hidden = !schedule;
    $('note-pinned').closest('label').hidden = schedule;
    $('schedule-date').required = schedule;
    $('note-title').placeholder = schedule ? '예: 홍길동 연차, 소방 안전 교육' : '무엇을 함께 확인할까요?';
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
    editing = {
      id: note?.id || randomId(),
      key: core.headKey(note),
      parents: note ? note.heads.map(e => e.id) : [],
      isNew: !note,
      schedule,
    };
    setEditorMode(schedule);
    $('editor-title').textContent = (schedule ? '일정 ' : '메모 ') + (note ? '수정' : '추가');
    $('note-title').value = note?.title || '';
    $('note-content').value = note?.content || '';
    if (schedule) {
      $('schedule-kind').value = note?.kind || core.SCHEDULE_KINDS[0];
      $('schedule-date').value = note?.date || options.date || selectedDay;
      $('schedule-end').value = note?.endDate || '';
      $('note-category').value = core.CATEGORIES[0];
    } else {
      $('note-category').value = note?.category || (core.CATEGORIES.includes(view) ? view : '인수인계');
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
    return {
      title: $('note-title').value.trim(),
      content: $('note-content').value,
      category: $('note-category').value,
      status: $('note-status').value,
      pinned: $('note-pinned').checked,
      deleted,
      author,
    };
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
      ['note-title', 'note-content', 'note-category', 'note-status', 'schedule-kind', 'schedule-date', 'schedule-end']
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
          ? (event.actor.kind === 'display-only'
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
              : view;
    $('breadcrumb-view').textContent = name;
    $('page-title').textContent = view === 'all' ? '오늘의 기록을, 함께.' : name;
    $('page-subtitle').textContent =
      view === 'all'
        ? '인수인계부터 작은 업무 메모까지. 한곳에 남기고 함께 확인하세요.'
        : view === 'calendar'
          ? '24시간 3팀 근무와 휴가·교육·교대·훈련 일정을 함께 확인하세요.'
          : view === 'trash'
            ? '필요한 기록은 수정 이력에서 다시 복구할 수 있어요.'
            : view === 'done'
              ? '함께 마무리한 업무와 확인한 내용을 모아 봅니다.'
              : '동료에게 전달할 내용을 남기고, 진행 상황을 함께 확인하세요.';
    $('section-title').firstChild.textContent = view === 'all' ? '함께 보는 메모 ' : name + ' ';
    const calendar = view === 'calendar';
    $('calendar-section').hidden = !calendar;
    $('board-section').hidden = calendar;
    $('stats').hidden = calendar;
    $('new-note').lastChild.textContent = calendar ? '일정 추가' : '새 메모';
    render();
  }
  function showMonth(year, month) {
    if (year < 2000 || year > 2099) return;
    calendarMonth = { year, month };
    const prefix = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
    if (!selectedDay.startsWith(prefix)) {
      const today = core.koreanDay(Date.now());
      selectedDay = today.startsWith(prefix) ? today : prefix + '-01';
    }
    renderCalendar();
  }
  function shiftMonth(delta) {
    const index = calendarMonth.year * 12 + calendarMonth.month - 1 + delta;
    showMonth(Math.floor(index / 12), (index % 12) + 1);
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
    const day = core.dutyDay(Date.now()),
      team = core.teamOn(day),
      hour = String(core.SHIFT_START_HOUR).padStart(2, '0') + ':00';
    $('duty-badge').textContent = '근무 ' + team + '팀';
    $('duty-badge').className = 'duty-badge team-' + team;
    $('duty-now').replaceChildren(
      teamBadge(day),
      document.createTextNode(' 지금 근무 중 · ' + dayLabel(day) + ' ' + hour + ' ~ ' + dayLabel(core.addDays(day, 1)) + ' ' + hour),
    );
  }
  function renderCalendar() {
    const { year, month } = calendarMonth,
      prefix = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0'),
      today = core.koreanDay(Date.now());
    $('cal-title').textContent = year + '년 ' + month + '월';
    $('cal-month').value = prefix;
    $('cal-prev').disabled = year === 2000 && month === 1;
    $('cal-next').disabled = year === 2099 && month === 12;
    $('cal-grid').replaceChildren(
      ...core.monthGrid(year, month).map(day => {
        const events = schedulesOn(day),
          weekday = new Date(day + 'T00:00:00Z').getUTCDay();
        const cell = el(
          'div',
          'cal-cell' +
            (day.startsWith(prefix) ? '' : ' outside') +
            (day === today ? ' today' : '') +
            (day === selectedDay ? ' selected' : '') +
            (weekday === 0 ? ' sun' : weekday === 6 ? ' sat' : ''),
        );
        cell.setAttribute('role', 'gridcell');
        cell.onclick = () => {
          selectedDay = day;
          if (!day.startsWith(prefix)) calendarMonth = monthOf(day);
          renderCalendar();
        };
        const head = el('div', 'cal-cell-head');
        const number = el('button', 'cal-date', String(Number(day.slice(8))));
        number.setAttribute(
          'aria-label',
          dayLabel(day, true) + ' ' + core.teamOn(day) + '팀 근무' + (events.length ? ' · 일정 ' + events.length + '개' : ''),
        );
        number.setAttribute('aria-pressed', String(day === selectedDay));
        head.append(number, teamBadge(day));
        cell.append(head);
        const chips = el('div', 'cal-chips');
        for (const note of events.slice(0, MAX_VISIBLE_CHIPS)) {
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
        if (events.length > MAX_VISIBLE_CHIPS) chips.append(el('span', 'cal-more', '+' + (events.length - MAX_VISIBLE_CHIPS) + '개'));
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
    title.append(
      el('h3', '', dayLabel(day, true)),
      el('p', '', core.teamOn(day) + '팀 근무 · ' + hour + ' ~ ' + dayLabel(core.addDays(day, 1)) + ' ' + hour),
    );
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
  $('new-note').onclick = () => (view === 'calendar' ? openEditor(undefined, { schedule: true, date: selectedDay }) : openEditor());
  $('empty-new').onclick = () => openEditor();
  $('cal-prev').onclick = () => shiftMonth(-1);
  $('cal-next').onclick = () => shiftMonth(1);
  $('cal-today').onclick = () => {
    selectedDay = core.koreanDay(Date.now());
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
      identity = await storage.connect({ code: cloud ? $('supabase-code').value.trim() : '' });
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
      showMessage(
        'settings-result',
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
  $('export-backup').onclick = async () => {
    try {
      await refresh();
      const blob = new Blob([JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), events: [...events.values()] }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      a.download = 'serotonin-board-' + core.koreanDay(Date.now()) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('메모 수정 기록을 포함한 백업 파일을 내려받았습니다.');
    } catch (error) {
      toast(error.message);
    }
  };
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
    const today = core.koreanDay(Date.now());
    if (today !== lastToday) {
      lastToday = today;
      if (view === 'calendar') renderCalendar();
    }
  }
  dateLabel();
  setInterval(dateLabel, 60000);
  updateProfile();
  refresh().catch(() => {});
  setInterval(() => {
    if (!document.hidden && !saving) refresh().catch(() => {});
  }, cfg.pollMilliseconds);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !saving) refresh().catch(() => {});
  });
  window.addEventListener('beforeunload', event => {
    if ($('editor-dialog').open) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
})();
