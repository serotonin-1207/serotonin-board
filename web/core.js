(function (root) {
  'use strict';
  const CATEGORIES = ['인수인계', '공지사항', '업무 메모'];
  const STATUSES = ['todo', 'doing', 'done'];
  const ID = /^[a-f0-9]{32}$/;

  // Calendar schedules are stored as notes with category '일정' plus kind/date/endDate.
  const SCHEDULE_CATEGORY = '일정';
  const SCHEDULE_KINDS = ['휴가', '교육', '교대', '훈련', '기타'];
  const MAX_SCHEDULE_DAYS = 60;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  // 24-hour three-team rotation: 1 -> 2 -> 3 -> 1 ... one team per day.
  // Each shift runs from 09:00 KST to 09:00 KST the next day.
  const TEAM_COUNT = 3;
  const TEAM_ANCHOR_DAY = '2026-10-08'; // Team 1 starts its shift on this day.
  const SHIFT_START_HOUR = 9;

  const DAY_MS = 86400000;
  function dayNumber(day) {
    return Math.floor(Date.parse(day + 'T00:00:00Z') / DAY_MS);
  }
  function validDay(day) {
    return typeof day === 'string' && DAY.test(day) && Number.isFinite(Date.parse(day + 'T00:00:00Z')) && addDays(day, 0) === day;
  }
  function addDays(day, count) {
    return new Date((dayNumber(day) + count) * DAY_MS).toISOString().slice(0, 10);
  }
  function daysBetween(from, to) {
    return dayNumber(to) - dayNumber(from);
  }
  function teamOn(day) {
    return (((daysBetween(TEAM_ANCHOR_DAY, day) % TEAM_COUNT) + TEAM_COUNT) % TEAM_COUNT) + 1;
  }
  // 09:00 KST is 00:00 UTC, so the shift day is simply the UTC date of the instant.
  function dutyDay(at) {
    return new Date(at).toISOString().slice(0, 10);
  }
  // Day strings (YYYY-MM-DD) for a Sunday-first month grid; month is 1-12.
  function monthGrid(year, month) {
    const first = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-01';
    const offset = new Date(Date.parse(first + 'T00:00:00Z')).getUTCDay();
    const length = Math.ceil((offset + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7) * 7;
    const start = addDays(first, -offset);
    return Array.from({ length }, (_, index) => addDays(start, index));
  }
  function validSchedule(n) {
    if (!SCHEDULE_KINDS.includes(n.kind) || !validDay(n.date)) return false;
    if (n.endDate === undefined) return true;
    return validDay(n.endDate) && n.endDate >= n.date && daysBetween(n.date, n.endDate) <= MAX_SCHEDULE_DAYS;
  }
  function validEvent(e) {
    if (!e || e.schema !== 1 || !ID.test(e.id) || !ID.test(e.noteId)) return false;
    if (
      !Array.isArray(e.parents) ||
      e.parents.length > 100 ||
      !e.parents.every(p => ID.test(p) && p !== e.id) ||
      new Set(e.parents).size !== e.parents.length
    )
      return false;
    if (typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) return false;
    const n = e.note;
    return (
      !!n &&
      typeof n.title === 'string' &&
      n.title.trim().length > 0 &&
      n.title.length <= 120 &&
      typeof n.content === 'string' &&
      n.content.length <= 10000 &&
      typeof n.author === 'string' &&
      n.author.trim().length > 0 &&
      n.author.length <= 40 &&
      (n.category === SCHEDULE_CATEGORY
        ? validSchedule(n)
        : CATEGORIES.includes(n.category) && n.kind === undefined && n.date === undefined && n.endDate === undefined) &&
      STATUSES.includes(n.status) &&
      typeof n.pinned === 'boolean' &&
      typeof n.deleted === 'boolean'
    );
  }
  function compare(a, b) {
    return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  }
  function buildNotes(events) {
    const groups = new Map();
    for (const e of events) {
      if (!validEvent(e)) throw new Error('올바르지 않은 메모 기록입니다.');
      if (!groups.has(e.noteId)) groups.set(e.noteId, new Map());
      const group = groups.get(e.noteId);
      if (group.has(e.id) && JSON.stringify(group.get(e.id)) !== JSON.stringify(e)) throw new Error('동일한 기록 ID의 내용이 다릅니다.');
      group.set(e.id, e);
    }
    return [...groups.entries()]
      .map(([id, records]) => {
        const history = [...records.values()].sort(compare);
        const parents = new Set();
        for (const e of history)
          for (const p of e.parents) {
            if (!records.has(p)) throw new Error('이전 수정 기록을 읽지 못했습니다. 다시 새로고침해 주세요.');
            parents.add(p);
          }
        const visiting = new Set(),
          visited = new Set();
        function visit(id) {
          if (visited.has(id)) return;
          if (visiting.has(id)) throw new Error('수정 기록이 순환 연결되어 있습니다.');
          visiting.add(id);
          for (const parent of records.get(id).parents) visit(parent);
          visiting.delete(id);
          visited.add(id);
        }
        for (const e of history) visit(e.id);
        const heads = history.filter(e => !parents.has(e.id)).sort(compare);
        if (!heads.length) throw new Error('수정 기록 연결이 올바르지 않습니다.');
        const latest = heads[heads.length - 1];
        return { id, ...latest.note, at: latest.at, eventId: latest.id, heads, history, conflict: heads.length > 1 };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  }
  function headKey(note) {
    return note
      ? note.heads
          .map(e => e.id)
          .sort()
          .join(',')
      : '';
  }
  function koreanDay(at) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(at));
  }
  const api = {
    CATEGORIES,
    STATUSES,
    SCHEDULE_CATEGORY,
    SCHEDULE_KINDS,
    MAX_SCHEDULE_DAYS,
    TEAM_COUNT,
    SHIFT_START_HOUR,
    validEvent,
    buildNotes,
    headKey,
    koreanDay,
    addDays,
    daysBetween,
    teamOn,
    dutyDay,
    monthGrid,
  };
  root.BoardCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
