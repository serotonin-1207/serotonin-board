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
  // Handover checklist: one note per item (category '인수인계'). An item is listed on every shift day from the day it
  // was written until the day after it was completed, so unfinished items carry over automatically and finished ones
  // drop off. Past days are rebuilt from the revision history, so nothing is ever lost.
  const HANDOVER_CATEGORY = '인수인계';
  const MEMO_CATEGORIES = ['공지사항', '업무 메모'];
  // Saved lists of handover items (name = title, one item per line = content). Shown only in the template dialog.
  const TEMPLATE_CATEGORY = '템플릿';
  // Fire equipment inspection board: equipment items (category '장비') and inspection sheets (category '점검').
  // One sheet records the results of many items on one day, so a daily round costs one revision instead of one per item.
  const EQUIPMENT_CATEGORY = '장비';
  const INSPECTION_CATEGORY = '점검';
  const INSPECTION_RESULTS = ['정상', '이상', '수리', '교체'];
  const MAX_SHEET_ITEMS = 300;
  const EQUIPMENT_KEYS = ['group', 'code', 'location', 'cycle'];
  const EXTRA_KEYS = [...EQUIPMENT_KEYS, 'results'];
  // Rotating (24h shift) departments change day at 09:00 KST = 00:00 UTC; office departments change day at midnight KST.
  const KST_OFFSET_MS = 9 * 3600000;
  function dayOffsetMs(rotating) {
    return rotating ? 0 : KST_OFFSET_MS;
  }
  function dayOfAt(at, rotating = true) {
    return new Date(Date.parse(at) + dayOffsetMs(rotating)).toISOString().slice(0, 10);
  }
  function dayEndMs(day, rotating = true) {
    return (dayNumber(day) + 1) * DAY_MS - dayOffsetMs(rotating);
  }
  function stateAt(note, limitMs) {
    let last = null;
    for (const e of note.history) {
      if (Date.parse(e.at) >= limitMs) break;
      last = e;
    }
    return last;
  }
  function handoverOn(notes, day, rotating = true) {
    const endMs = dayEndMs(day, rotating),
      startMs = endMs - DAY_MS,
      items = [];
    for (const note of notes) {
      if (note.category !== HANDOVER_CATEGORY) continue;
      const end = stateAt(note, endMs);
      if (!end || end.note.deleted) continue;
      const before = stateAt(note, startMs);
      const done = end.note.status === 'done';
      if (before && !before.note.deleted && before.note.status === 'done' && done) continue;
      const createdDay = dayOfAt(note.history[0].at, rotating);
      items.push({ note, state: end, done, pinned: end.note.pinned, createdDay, carriedDays: Math.max(0, daysBetween(createdDay, day)) });
    }
    return items.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.note.history[0].at.localeCompare(b.note.history[0].at) ||
        a.note.id.localeCompare(b.note.id),
    );
  }
  // Only handover items can name a person in charge (optional, 1-40 characters).
  function validAssignee(n) {
    if (n.assignee === undefined) return true;
    return n.category === HANDOVER_CATEGORY && typeof n.assignee === 'string' && n.assignee.trim().length > 0 && n.assignee.length <= 40;
  }
  function validSchedule(n) {
    if (!SCHEDULE_KINDS.includes(n.kind) || !validDay(n.date)) return false;
    if (n.endDate === undefined) return true;
    return validDay(n.endDate) && n.endDate >= n.date && daysBetween(n.date, n.endDate) <= MAX_SCHEDULE_DAYS;
  }
  function shortText(value, max) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  }
  function noExtras(n, allowed = []) {
    return EXTRA_KEYS.every(key => allowed.includes(key) || n[key] === undefined);
  }
  function validEquipment(n) {
    return (
      shortText(n.group, 30) &&
      (n.code === undefined || shortText(n.code, 40)) &&
      (n.location === undefined || shortText(n.location, 40)) &&
      Number.isInteger(n.cycle) &&
      n.cycle >= 1 &&
      n.cycle <= 366 &&
      n.kind === undefined &&
      n.date === undefined &&
      n.endDate === undefined &&
      n.assignee === undefined &&
      noExtras(n, EQUIPMENT_KEYS)
    );
  }
  function validInspection(n) {
    if (!validDay(n.date) || n.kind !== undefined || n.endDate !== undefined || n.assignee !== undefined || !noExtras(n, ['results']))
      return false;
    if (!Array.isArray(n.results) || n.results.length < 1 || n.results.length > MAX_SHEET_ITEMS) return false;
    const seen = new Set();
    for (const r of n.results) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['e', 'r', 'm'].includes(k))) return false;
      if (!ID.test(r.e) || seen.has(r.e) || !INSPECTION_RESULTS.includes(r.r)) return false;
      if (r.m !== undefined && !shortText(r.m, 200)) return false;
      seen.add(r.e);
    }
    return true;
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
        ? validSchedule(n) && n.assignee === undefined && noExtras(n)
        : n.category === EQUIPMENT_CATEGORY
          ? validEquipment(n)
          : n.category === INSPECTION_CATEGORY
            ? validInspection(n)
            : (CATEGORIES.includes(n.category) || n.category === TEMPLATE_CATEGORY) &&
              n.kind === undefined &&
              n.date === undefined &&
              n.endDate === undefined &&
              noExtras(n) &&
              validAssignee(n)) &&
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
  // Current state of every piece of equipment: its latest result, when it is due next and whether it is overdue.
  // Sheets in the trash do not count; equipment in the trash is left out (its old results stay in the history).
  function equipmentStatus(notes, today) {
    const latest = new Map();
    for (const sheet of notes) {
      if (sheet.category !== INSPECTION_CATEGORY || sheet.deleted) continue;
      for (const r of sheet.results) {
        const known = latest.get(r.e);
        if (!known || sheet.date > known.date || (sheet.date === known.date && sheet.at > known.at))
          latest.set(r.e, { date: sheet.date, result: r.r, memo: r.m || '', author: sheet.author, at: sheet.at, sheetId: sheet.id });
      }
    }
    return notes
      .filter(n => n.category === EQUIPMENT_CATEGORY && !n.deleted)
      .map(note => {
        const last = latest.get(note.id) || null;
        const due = last ? addDays(last.date, note.cycle) : null;
        const daysLeft = due ? daysBetween(today, due) : null;
        // never checked, overdue, or last result not "정상" all need attention
        const attention = !last || daysLeft < 0 || last.result !== '정상';
        return { note, last, due, daysLeft, overdue: daysLeft !== null && daysLeft < 0, attention };
      })
      .sort(
        (a, b) =>
          a.note.group.localeCompare(b.note.group, 'ko') ||
          a.note.title.localeCompare(b.note.title, 'ko') ||
          a.note.id.localeCompare(b.note.id),
      );
  }
  // Every recorded result of one piece of equipment, newest first (sheets in the trash are left out).
  function inspectionHistory(notes, equipmentId) {
    const rows = [];
    for (const sheet of notes) {
      if (sheet.category !== INSPECTION_CATEGORY || sheet.deleted) continue;
      const r = sheet.results.find(x => x.e === equipmentId);
      if (r)
        rows.push({
          date: sheet.date,
          result: r.r,
          memo: r.m || '',
          author: sheet.author,
          at: sheet.at,
          sheetId: sheet.id,
          sheetTitle: sheet.title,
        });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
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
    HANDOVER_CATEGORY,
    MEMO_CATEGORIES,
    TEMPLATE_CATEGORY,
    EQUIPMENT_CATEGORY,
    INSPECTION_CATEGORY,
    INSPECTION_RESULTS,
    MAX_SHEET_ITEMS,
    equipmentStatus,
    inspectionHistory,
    handoverOn,
    dayOfAt,
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
