import {
  CONFIG,
  addNote,
  connect,
  core,
  disconnect,
  getProfile,
  getSettings,
  getSummary,
  refreshSummary,
  saveSettings,
  setHandoverDone,
  uploadFile,
} from './api.js';
import { dayLabel, groupSchedules, handoverMinutes, minutesOf, parseHandoverLines, rangeLabel, timeLabel } from './logic.mjs';

const app = document.getElementById('app');
const manifest = chrome.runtime.getManifest();
// The same page runs as the toolbar popup and as the side panel (panel.html); the panel stays open and takes dropped files.
const inPanel = document.body.classList.contains('panel');
let windowId = null;
chrome.windows
  ?.getCurrent?.()
  .then(w => (windowId = w.id))
  .catch(() => {});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function message(text, ok) {
  const old = app.querySelector('.msg');
  if (old) old.remove();
  const box = el('p', 'msg' + (ok ? ' ok' : ''), text);
  box.setAttribute('role', ok ? 'status' : 'alert');
  app.append(box);
  return box;
}
function openBoard() {
  chrome.tabs.create({ url: CONFIG.boardUrl });
}
function stamp(at) {
  const date = new Date(at);
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
// A button that needs a second press within five seconds (nothing is deleted without it).
function twoStep(button, armedLabel, action) {
  const original = button.textContent;
  let timer;
  button.onclick = () => {
    if (button.classList.contains('armed')) {
      clearTimeout(timer);
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

function renderConnect(note) {
  const code = el('input');
  code.type = 'password';
  code.autocomplete = 'off';
  code.placeholder = '부서 관리자에게 받은 접속 코드';
  code.setAttribute('aria-label', '접속 코드');
  const name = el('input');
  name.type = 'text';
  name.maxLength = 40;
  name.placeholder = '표시 이름 (예: 홍길동)';
  name.setAttribute('aria-label', '표시 이름');
  const go = el('button', 'primary', '연결');
  const codeLabel = el('label', '', '접속 코드');
  codeLabel.append(code);
  const nameLabel = el('label', '', '표시 이름');
  nameLabel.append(name);
  go.onclick = async () => {
    go.disabled = true;
    try {
      await connect(code.value, name.value);
      await render();
      chrome.runtime.sendMessage({ type: 'refresh' });
    } catch (error) {
      go.disabled = false;
      message(error.message);
    }
  };
  code.addEventListener('keydown', event => event.key === 'Enter' && go.click());
  name.addEventListener('keydown', event => event.key === 'Enter' && go.click());
  app.replaceChildren(
    el('h1', '', 'Serotonin 보드'),
    el(
      'p',
      'intro',
      '부서 보드에 연결하면 오늘 근무팀, 일정, 인수인계를 이 브라우저에서 바로 볼 수 있습니다. 접속 코드는 처음 한 번만 확인하고 저장하지 않습니다.',
    ),
    codeLabel,
    nameLabel,
    go,
  );
  go.style.marginTop = '12px';
  if (note) message(note);
}

// File box: pick or drop files to send them to the department's file box (kept for the chosen time, 7 days at most).
function fileBox() {
  const heading = el('h2', '', '파일 보내기');
  const keep = el('select', 'keep');
  keep.setAttribute('aria-label', '보관 기간');
  for (const [minutes, label] of [
    [10080, '7일 보관'],
    [4320, '3일 보관'],
    [1440, '1일 보관'],
    [360, '6시간 보관'],
    [60, '1시간 보관'],
  ])
    keep.append(new Option(label, String(minutes)));
  heading.append(keep);
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const zone = el(
    'button',
    'drop',
    inPanel ? '여기에 파일을 끌어다 놓거나 눌러서 고르세요' : '눌러서 파일 고르기 (끌어다 놓기는 “옆에 띄우기”에서)',
  );
  zone.type = 'button';
  zone.onclick = () => input.click();
  const progress = el('ul', 'uploads');
  const send = async files => {
    for (const file of files) {
      const line = el('li', '', file.name + ' · 준비 중');
      progress.append(line);
      try {
        await uploadFile(file, Number(keep.value), share => (line.textContent = file.name + ' · ' + Math.round(share * 100) + '%'));
        line.textContent = file.name + ' · 보냈습니다';
        line.className = 'ok';
      } catch (error) {
        line.textContent = file.name + ' · ' + error.message;
        line.className = 'bad';
      }
    }
  };
  input.onchange = () => {
    const chosen = [...input.files];
    input.value = '';
    send(chosen);
  };
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => (event.preventDefault(), zone.classList.add('over')));
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, event => (event.preventDefault(), zone.classList.remove('over')));
  zone.addEventListener('drop', event => send([...(event.dataTransfer?.files || [])]));
  const note = el('p', 'stamp', '같은 부서원만 보드의 “파일”에서 받을 수 있습니다. 파일 하나 50MB까지.');
  return [heading, zone, input, progress, note];
}

function scheduleList(items) {
  if (!items.length) return null;
  const list = el('ul', 'list');
  for (const item of items) {
    const row = el('li');
    row.append(el('span', 'kind', item.kind), el('span', '', item.title), el('span', 'when', rangeLabel(item)));
    list.append(row);
  }
  return list;
}
function section(title, items, emptyText) {
  const heading = el('h2', '', title);
  const body = scheduleList(items) || el('p', 'empty', emptyText);
  return [heading, body];
}

async function renderBoard(summary, fresh) {
  const profile = await getProfile();
  const settings = await getSettings();
  const rotating = summary.dept.rotating;
  const head = el('div', 'head');
  const title = el('div');
  title.append(el('h1', '', summary.dept.name), el('small', '', '오늘 ' + dayLabel(summary.today) + ' · ' + profile.name));
  head.append(title);
  if (rotating) {
    const team = core.teamOn(core.dutyDay(Date.now()));
    head.append(el('span', 'team team-' + team, '오늘 ' + team + '팀 근무'));
  }
  const groups = groupSchedules(summary);
  const parts = [
    head,
    ...section('오늘 일정', groups.today, '오늘 일정이 없습니다.'),
    ...section('내일 일정', groups.tomorrow, '내일 일정이 없습니다.'),
  ];
  if (groups.later.length) parts.push(...section('이후 2주', groups.later));

  const open = el('h2', '', '미완료 인수인계 ' + summary.handoverCount + '건');
  parts.push(open);
  if (summary.handover.length) {
    const list = el('ul', 'list');
    const shownCount = inPanel ? 50 : 8;
    for (const item of summary.handover.slice(0, shownCount)) {
      const row = el('li', 'ho');
      const box = el('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', item.title + ' 완료');
      box.disabled = !item.id; // an older server does not send what is needed to check items
      box.onchange = async () => {
        box.disabled = true;
        row.classList.add('busy');
        try {
          await setHandoverDone(item, box.checked);
          row.classList.add('done');
          message('“' + item.title + '” 완료로 표시했습니다.', true);
          setTimeout(() => render(), 900);
        } catch (error) {
          box.checked = false;
          box.disabled = false;
          row.classList.remove('busy');
          message(error.message);
        }
      };
      const label = el('label', 'ho-label');
      label.append(box, el('span', '', (item.pinned ? '📌 ' : '') + item.title));
      row.append(label);
      if (item.assignee) row.append(el('span', 'who', '@' + item.assignee));
      list.append(row);
    }
    parts.push(list);
    if (summary.handoverCount > shownCount)
      parts.push(el('p', 'stamp', '나머지 ' + (summary.handoverCount - shownCount) + '건은 보드에서 확인하세요.'));
  } else parts.push(el('p', 'empty', '남은 항목이 없습니다.'));

  const input = el('input');
  input.type = 'text';
  input.maxLength = 400;
  input.placeholder = '인수인계 빠르게 추가 (@이름 으로 담당자)';
  input.setAttribute('aria-label', '인수인계 추가');
  const add = el('button', 'primary', '추가');
  const adding = async () => {
    const items = parseHandoverLines(input.value);
    if (!items.length) return;
    add.disabled = true;
    try {
      for (const item of items) await addNote({ ...item, category: core.HANDOVER_CATEGORY });
      input.value = '';
      await render();
      message(items.length + '건을 추가했습니다.', true);
    } catch (error) {
      add.disabled = false;
      message(error.message);
    }
  };
  add.onclick = adding;
  input.addEventListener('keydown', event => event.key === 'Enter' && adding());
  const row = el('div', 'row');
  row.append(input, add);
  parts.push(row);

  parts.push(...fileBox());

  // notification settings
  const details = el('details');
  details.append(el('summary', '', '알림 설정'));
  const check = (label, checked, onChange) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.onchange = () => onChange(box.checked);
    const wrap = el('label', 'setting');
    wrap.style.margin = '8px 0 0';
    wrap.append(box, document.createTextNode(label));
    return wrap;
  };
  const timeInput = (value, onChange) => {
    const input = el('input');
    input.type = 'time';
    input.value = timeLabel(value);
    input.onchange = () => {
      const minutes = minutesOf(input.value);
      if (minutes !== null) onChange(minutes);
    };
    return input;
  };
  const change = async patch => saveSettings({ ...(await getSettings()), ...patch });
  const handoverRow = check('인수인계 미완료 알림', settings.handoverAlert, value => change({ handoverAlert: value }));
  handoverRow.append(timeInput(handoverMinutes(settings, rotating), minutes => change({ handoverMinutes: minutes })));
  const scheduleRow = check('오늘 일정 알림', settings.scheduleAlert, value => change({ scheduleAlert: value }));
  scheduleRow.append(timeInput(settings.scheduleMinutes, minutes => change({ scheduleMinutes: minutes })));
  details.append(handoverRow, scheduleRow, el('p', 'stamp', '알림은 10분마다 확인하며, 정해진 시각 뒤 2시간 안에 하루 한 번 나옵니다.'));
  parts.push(details);

  const foot = el('div', 'foot');
  const boardButton = el('button', '', '보드 열기');
  boardButton.onclick = openBoard;
  const panelButton = el('button', '', '옆에 띄우기');
  panelButton.title = '사이드 패널로 열어 두고 체크하거나 파일을 끌어다 놓습니다.';
  panelButton.hidden = inPanel || !chrome.sidePanel;
  panelButton.onclick = () => {
    if (windowId === null) return message('창 정보를 아직 읽지 못했습니다. 한 번 더 눌러 주세요.');
    chrome.sidePanel
      .open({ windowId })
      .then(() => window.close())
      .catch(error => message('사이드 패널을 열지 못했습니다: ' + error.message));
  };
  const leave = el('button', 'link', '연결 해제');
  twoStep(leave, '한 번 더 누르면 해제', async () => {
    await disconnect();
    chrome.runtime.sendMessage({ type: 'refresh' });
    await render();
  });
  foot.append(
    boardButton,
    panelButton,
    el('span', 'stamp', (fresh ? '갱신 ' : '저장된 내용 ') + stamp(fresh || 0) + ' · v' + manifest.version),
    leave,
  );
  parts.push(foot);
  app.replaceChildren(...parts);
}

async function render() {
  const profile = await getProfile();
  if (!profile) return renderConnect();
  const cached = await getSummary();
  if (cached) await renderBoard(cached.data, cached.at);
  else app.replaceChildren(el('p', 'intro', '불러오는 중…'));
  try {
    const summary = await refreshSummary();
    await renderBoard(summary, Date.now());
  } catch (error) {
    if (error.code === 'NOT_MEMBER') {
      await chrome.storage.local.remove('ext:profile');
      return renderConnect(error.message);
    }
    if (!cached) app.replaceChildren(el('h1', '', 'Serotonin 보드'));
    message('최신 내용을 가져오지 못했습니다. ' + error.message);
  }
}

render();
