(function (root) {
  'use strict';
  // Downloads of the whole history. CSV files open directly in Excel (UTF-8 with BOM so Korean text is not garbled);
  // the JSON backup keeps every revision exactly as stored.
  const STATUS = { todo: '미처리', doing: '진행 중', done: '완료' };

  // A cell that starts with = + - @ would be run as a formula by Excel; a leading apostrophe keeps it as text.
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function toCsv(header, rows) {
    return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  // Korean time, "2026-10-10 09:12:03".
  function kst(at) {
    return new Date(Date.parse(at) + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  }
  function label(note) {
    return note.deleted ? '휴지통' : STATUS[note.status] || note.status;
  }
  // When the current "done" state began, and who set it (null if the item is not done now).
  function completion(note) {
    let since = null;
    for (const event of note.history) {
      if (event.note.deleted || event.note.status !== 'done') since = null;
      else if (!since) since = event;
    }
    return note.status === 'done' && !note.deleted ? since : null;
  }

  // One row per item with its current state.
  function itemsCsv(notes) {
    const header = [
      '종류',
      '제목',
      '내용',
      '상태',
      '중요',
      '일정 종류',
      '일정 시작일',
      '일정 종료일',
      '작성자',
      '작성 시각',
      '마지막 수정자',
      '마지막 수정 시각',
      '수정 횟수',
      '완료 시각',
      '완료한 사람',
    ];
    const rows = [...notes]
      .sort((a, b) => a.history[0].at.localeCompare(b.history[0].at))
      .map(note => {
        const done = completion(note);
        return [
          note.category,
          note.title,
          note.content,
          label(note),
          note.pinned ? '중요' : '',
          note.kind || '',
          note.date || '',
          note.endDate || '',
          note.history[0].note.author,
          kst(note.history[0].at),
          note.author,
          kst(note.at),
          note.history.length,
          done ? kst(done.at) : '',
          done ? done.note.author : '',
        ];
      });
    return toCsv(header, rows);
  }

  // One row per saved revision: the complete audit trail.
  function revisionsCsv(events) {
    const header = [
      '저장 시각',
      '종류',
      '제목',
      '내용',
      '상태',
      '중요',
      '삭제',
      '작성자',
      '일정 종류',
      '일정 시작일',
      '일정 종료일',
      '계정 구분',
      '항목 ID',
      '기록 ID',
      '이전 기록 수',
    ];
    const rows = [...events]
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map(e => [
        kst(e.at),
        e.note.category,
        e.note.title,
        e.note.content,
        STATUS[e.note.status] || e.note.status,
        e.note.pinned ? '중요' : '',
        e.note.deleted ? '삭제' : '',
        e.note.author,
        e.note.kind || '',
        e.note.date || '',
        e.note.endDate || '',
        e.actor ? e.actor.kind : '',
        e.noteId,
        e.id,
        e.parents.length,
      ]);
    return toCsv(header, rows);
  }

  // The handover log: for every shift day, the list exactly as it looked that day (checked or not, how long carried over).
  function logbookCsv(core, notes, today, rotating, team) {
    const first = notes
      .filter(n => n.category === core.HANDOVER_CATEGORY)
      .map(n => core.dayOfAt(n.history[0].at, rotating))
      .sort()[0];
    const header = [
      '근무일',
      ...(rotating ? ['근무 팀'] : []),
      '항목',
      '완료',
      '이월(일)',
      '작성일',
      '작성자',
      '마지막 처리자',
      '중요',
      '메모',
    ];
    const rows = [];
    if (first) {
      const days = Math.min(3660, core.daysBetween(first, today));
      for (let i = 0; i <= days; i++) {
        const day = core.addDays(first, i);
        for (const item of core.handoverOn(notes, day, rotating)) {
          const note = item.state.note;
          rows.push([
            day,
            ...(rotating ? [team(day) + '팀'] : []),
            note.title,
            item.done ? '완료' : '미완료',
            item.carriedDays,
            item.createdDay,
            item.note.history[0].note.author,
            note.author,
            item.pinned ? '중요' : '',
            note.content,
          ]);
        }
      }
    }
    return toCsv(header, rows);
  }

  function backupJson(events, meta) {
    return JSON.stringify(
      { schema: 1, app: 'serotonin-board', exportedAt: new Date().toISOString(), ...meta, events: [...events] },
      null,
      2,
    );
  }

  const api = { csvCell, toCsv, kst, itemsCsv, revisionsCsv, logbookCsv, backupJson };
  root.BoardExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
