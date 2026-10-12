(function (root) {
  'use strict';
  // Downloads of the whole history. CSV files open directly in Excel (UTF-8 with BOM so Korean text is not garbled);
  // the JSON backup keeps every revision exactly as stored.
  const STATUS = { todo: '미처리', doing: '진행 중', done: '완료' };

  // A cell that starts with = + - @ would be run as a formula by Excel; a leading apostrophe keeps it as text.
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // (real numbers such as -2 days left are not formulas and stay numbers)
    if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
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
      '담당자',
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
          note.assignee || '',
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
      '담당자',
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
        e.note.assignee || '',
        e.actor ? e.actor.kind : '',
        e.noteId,
        e.id,
        e.parents.length,
      ]);
    return toCsv(header, rows);
  }

  // Fire equipment: one row per item with its latest inspection and the next due date.
  function equipmentCsv(core, notes, today) {
    const header = [
      '분류',
      '장비명',
      '관리번호·수량',
      '보관 위치',
      '점검 주기(일)',
      '최근 점검일',
      '최근 결과',
      '최근 메모',
      '최근 점검자',
      '다음 점검일',
      '남은 일수',
      '상태',
      '비고',
      '등록자',
      '등록 시각',
    ];
    const rows = core
      .equipmentStatus(notes, today)
      .map(s => [
        s.note.group,
        s.note.title,
        s.note.code || '',
        s.note.location || '',
        s.note.cycle,
        s.last ? s.last.date : '',
        s.last ? s.last.result : '',
        s.last ? s.last.memo : '',
        s.last ? s.last.author : '',
        s.due || '',
        s.daysLeft === null ? '' : s.daysLeft,
        !s.last ? '미점검' : s.overdue ? '기한 지남' : s.last.result !== '정상' ? '조치 필요' : '정상',
        s.note.content,
        s.note.history ? s.note.history[0].note.author : '',
        s.note.history ? kst(s.note.history[0].at) : '',
      ]);
    return toCsv(header, rows);
  }
  // Every inspection result ever recorded (sheets in the trash left out), oldest first: the cumulative record.
  function inspectionsCsv(core, notes) {
    const names = new Map(notes.filter(n => n.category === core.EQUIPMENT_CATEGORY).map(n => [n.id, n]));
    const header = [
      '점검일',
      '분류',
      '장비명',
      '관리번호·수량',
      '결과',
      '메모',
      '점검자',
      '점검표',
      '점검표 메모',
      '기록 시각',
      '장비 상태',
    ];
    const rows = [];
    for (const sheet of notes) {
      if (sheet.category !== core.INSPECTION_CATEGORY || sheet.deleted) continue;
      for (const r of sheet.results) {
        const item = names.get(r.e);
        rows.push([
          sheet.date,
          item ? item.group : '',
          item ? item.title : '(알 수 없는 장비)',
          item ? item.code || '' : '',
          r.r,
          r.m || '',
          sheet.author,
          sheet.title,
          sheet.content,
          kst(sheet.at),
          !item ? '' : item.deleted ? '삭제됨' : '사용 중',
        ]);
      }
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]) || a[9].localeCompare(b[9]) || String(a[2]).localeCompare(String(b[2]), 'ko'));
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
      '담당자',
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
            note.assignee || '',
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

  // What a backup file would add to this board, in an order the server accepts (parents before children, whatever the clocks say).
  function parseBackup(text, validEvent) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('백업 파일(JSON)을 읽을 수 없습니다.');
    }
    if (!data || data.schema !== 1 || !Array.isArray(data.events)) throw new Error('이 보드의 백업 파일이 아닙니다.');
    if (!data.events.length) throw new Error('백업 파일에 기록이 없습니다.');
    if (data.events.length > 20000) throw new Error('백업 파일의 기록이 너무 많습니다 (20,000건 이하).');
    for (const event of data.events) if (!validEvent(event)) throw new Error('백업 파일에 올바르지 않은 기록이 있어 복원하지 않았습니다.');
    return data;
  }
  function orderForRestore(events, existingIds) {
    const present = new Set(existingIds),
      byId = new Map(),
      ordered = [];
    for (const event of events) if (!present.has(event.id)) byId.set(event.id, event);
    const visit = (event, stack) => {
      if (!byId.has(event.id)) return;
      if (stack.has(event.id)) throw new Error('백업 파일의 수정 기록이 순환 연결되어 있습니다.');
      stack.add(event.id);
      for (const parent of event.parents) {
        if (present.has(parent)) continue;
        const parentEvent = byId.get(parent);
        if (!parentEvent) throw new Error('백업 파일에 이전 수정 기록이 빠져 있어 복원할 수 없습니다.');
        visit(parentEvent, stack);
      }
      byId.delete(event.id);
      present.add(event.id);
      ordered.push(event);
    };
    for (const event of [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) visit(event, new Set());
    return ordered;
  }

  const api = {
    parseBackup,
    orderForRestore,
    csvCell,
    toCsv,
    kst,
    itemsCsv,
    revisionsCsv,
    logbookCsv,
    backupJson,
    equipmentCsv,
    inspectionsCsv,
  };
  root.BoardExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
