// Pure rules of the browser extension (no browser or network access), so they can be tested on their own.
export const DEFAULT_SETTINGS = { handoverAlert: true, handoverMinutes: null, scheduleAlert: false, scheduleMinutes: 540 };
export const ALERT_WINDOW_MINUTES = 120; // an alert still goes out when the browser was busy or asleep for up to two hours
export const TEAM_COLORS = { 1: '#b8532f', 2: '#52794a', 3: '#6b5f93' };
const MAX_TITLE = 120;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// Korean time (UTC+9): the calendar day and the minute of that day.
export function kst(now) {
  const moved = new Date(now + 9 * 3600000);
  return { day: moved.toISOString().slice(0, 10), minutes: moved.getUTCHours() * 60 + moved.getUTCMinutes() };
}
export function addDays(day, count) {
  return new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
}
export function dayLabel(day) {
  const date = new Date(day + 'T00:00:00Z');
  return date.getUTCMonth() + 1 + '/' + date.getUTCDate() + '(' + WEEKDAYS[date.getUTCDay()] + ')';
}
export function timeLabel(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
export function minutesOf(text) {
  const found = /^(\d{1,2}):(\d{2})$/.exec(text || '');
  if (!found || Number(found[1]) > 23 || Number(found[2]) > 59) return null;
  return Number(found[1]) * 60 + Number(found[2]);
}
// Rotating departments change shift at 09:00, so the reminder comes at 08:00; office departments get it at 16:00.
export function handoverMinutes(settings, rotating) {
  return Number.isFinite(settings.handoverMinutes) ? settings.handoverMinutes : rotating ? 480 : 960;
}

// Toolbar badge: today's team for rotating departments, the number of open handover items for office departments.
export function badgeFor(summary, teamOnDay, now) {
  if (!summary?.dept) return { text: '', color: '#8b8f88', title: 'Serotonin 보드 · 연결이 필요합니다' };
  if (summary.dept.rotating) {
    const team = teamOnDay(now);
    return { text: String(team), color: TEAM_COLORS[team], title: summary.dept.name + ' · 오늘 ' + team + '팀 근무' };
  }
  const count = summary.handoverCount || 0;
  return { text: count ? String(count) : '', color: '#52794a', title: summary.dept.name + ' · 미완료 인수인계 ' + count + '건' };
}

// Schedules grouped for the popup: today, tomorrow, and the rest of the coming two weeks.
export function groupSchedules(summary) {
  const today = summary.today,
    tomorrow = addDays(today, 1);
  const covers = (item, day) => item.from <= day && item.to >= day;
  const groups = { today: [], tomorrow: [], later: [] };
  for (const item of summary.schedules || []) {
    if (covers(item, today)) groups.today.push(item);
    else if (covers(item, tomorrow)) groups.tomorrow.push(item);
    else if (item.from > tomorrow) groups.later.push(item);
  }
  return groups;
}
export function rangeLabel(item) {
  return item.to > item.from ? dayLabel(item.from) + ' ~ ' + dayLabel(item.to) : dayLabel(item.from);
}

// Which desktop notifications are due now. Each kind goes out once per Korean day, inside two hours after its set time.
export function dueAlerts({ summary, settings, marks, now }) {
  if (!summary?.dept) return [];
  const here = kst(now),
    alerts = [];
  const inWindow = start => Number.isFinite(start) && here.minutes >= start && here.minutes < start + ALERT_WINDOW_MINUTES;
  if (
    settings.handoverAlert &&
    summary.handoverCount > 0 &&
    marks?.handover !== here.day &&
    inWindow(handoverMinutes(settings, summary.dept.rotating))
  ) {
    const names = summary.handover.slice(0, 3).map(item => item.title);
    alerts.push({
      kind: 'handover',
      mark: here.day,
      title: '인수인계 미완료 ' + summary.handoverCount + '건',
      message: names.join('\n') + (summary.handoverCount > names.length ? '\n…' : ''),
    });
  }
  const today = groupSchedules(summary).today;
  if (settings.scheduleAlert && today.length && marks?.schedule !== here.day && inWindow(settings.scheduleMinutes)) {
    const lines = today.slice(0, 4).map(item => '[' + item.kind + '] ' + item.title);
    alerts.push({
      kind: 'schedule',
      mark: here.day,
      title: '오늘 일정 ' + today.length + '건',
      message: lines.join('\n') + (today.length > lines.length ? '\n…' : ''),
    });
  }
  return alerts;
}

// "@홍길동 펌프 점검" names the person in charge, like the quick-add box of the board.
export function parseHandoverLine(line) {
  let text = line.replace(/^\s*(?:[-*•·▪]|\d+[.)])\s+/, '').trim();
  let assignee;
  const found = /^@(\S{1,40})\s+(.+)$/.exec(text);
  if (found) {
    assignee = found[1];
    text = found[2].trim();
  }
  if (!text) return null;
  const item = { title: text.slice(0, MAX_TITLE) };
  if (assignee) item.assignee = assignee;
  return item;
}
export function parseHandoverLines(text, max = 10) {
  return String(text).split(/\r?\n/).map(parseHandoverLine).filter(Boolean).slice(0, max);
}
// A selection saved as a memo: the first line is the title, everything goes into the body together with its source page.
export function memoFrom(text, pageUrl) {
  const clean = String(text).trim();
  const first = clean.split(/\r?\n/).find(line => line.trim()) || '';
  const source = pageUrl && /^https?:\/\//.test(pageUrl) ? '\n\n출처: ' + pageUrl.slice(0, 500) : '';
  const room = 10000 - source.length;
  return { title: first.trim().slice(0, MAX_TITLE) || '메모', content: clean.slice(0, room) + source };
}
