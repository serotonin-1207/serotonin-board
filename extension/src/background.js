import { CONFIG, addNote, core, getMarks, getProfile, getSettings, getSummary, refreshSummary, setMark } from './api.js';
import { badgeFor, dueAlerts, memoFrom, parseHandoverLines } from './logic.mjs';

const ALARM = 'serotonin-refresh';
const MENU_HANDOVER = 'serotonin-add-handover',
  MENU_MEMO = 'serotonin-add-memo';
const ICON = 'icons/icon128.png';

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: ICON, title, message });
}

async function updateBadge(summary) {
  const badge = badgeFor(summary, now => core.teamOn(core.dutyDay(now)), Date.now());
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setTitle({ title: badge.title });
}

// Every ten minutes: read the board's summary, refresh the badge and send the desktop notifications that are due.
async function refresh() {
  if (!(await getProfile())) return updateBadge(null);
  let summary = null;
  try {
    summary = await refreshSummary();
  } catch (error) {
    if (error.code === 'NOT_MEMBER') await chrome.storage.local.remove('ext:profile');
    summary = (await getSummary())?.data ?? null; // offline or a server hiccup: keep showing the last known state
  }
  await updateBadge(summary);
  const alerts = dueAlerts({ summary, settings: await getSettings(), marks: await getMarks(), now: Date.now() });
  for (const alert of alerts) {
    notify('serotonin-' + alert.kind, alert.title, alert.message);
    await setMark(alert.kind, alert.mark);
  }
}

function setup() {
  chrome.alarms.create(ALARM, { periodInMinutes: 10, delayInMinutes: 1 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_HANDOVER, title: '인수인계에 추가', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_MEMO, title: '보드에 메모로 저장', contexts: ['selection'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setup();
  refresh().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  setup();
  refresh().catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) refresh().catch(() => {});
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'refresh') refresh().catch(() => {});
});
chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: CONFIG.boardUrl });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || '').trim();
  if (!text) return;
  try {
    if (info.menuItemId === MENU_HANDOVER) {
      const items = parseHandoverLines(text);
      if (!items.length) return notify('serotonin-add', '추가하지 못했습니다', '선택한 글에서 항목을 찾지 못했습니다.');
      for (const item of items) await addNote({ ...item, category: core.HANDOVER_CATEGORY });
      notify('serotonin-add', '인수인계에 추가했습니다', items.length + '건: ' + items[0].title + (items.length > 1 ? ' 외' : ''));
    } else if (info.menuItemId === MENU_MEMO) {
      const memo = memoFrom(text, tab?.url || info.pageUrl);
      await addNote({ ...memo, category: core.MEMO_CATEGORIES[1] });
      notify('serotonin-add', '메모로 저장했습니다', memo.title);
    }
    refresh().catch(() => {});
  } catch (error) {
    notify('serotonin-add', '저장하지 못했습니다', error.message);
  }
});
