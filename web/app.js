/* 야구기록지(스코어시트) 웹 편집기
 * - 원본 기록지 양식을 그대로 화면에 재현한다.
 * - 가운데 볼카운트(타석 다이아몬드) 영역은 판독한 칸만 표시한다(diamond 배열).
 *   칸의 자리는 이닝이 아니라 (타순, 열) 이다 — 한 이닝이 두 열에 걸치기도 한다.
 * - 나머지 모든 칸은 data/parsed/*.json 에서 읽은 값으로 채우고 편집할 수 있다.
 */
(function () {
  'use strict';

  const INNINGS = 14;

  /* 볼카운트 스트립 기호 (docs/2023recordRaw_스코어북 기록방법.pdf) */
  const COUNT_MARK = {
    B:  { g: '＼', t: '볼' },
    S:  { g: 'Ɔ',  t: '그대로 보낸 스트라이크' },
    W:  { g: '⊖',  t: '헛친 스트라이크(파울팁 포함)' },
    F:  { g: '△',  t: '파울 타구' },
    BF: { g: '▲',  t: '번트 파울 타구' },
    BM: { g: '●',  t: '번트 헛스윙' },
    H:  { g: 'θ',  t: '타격완료' },
    X:  { g: '×',  t: '자동고의4구 시점' }
  };
  /* 다이아몬드 네 칸: a=홈~1루, b=1~2루, c=2~3루, d=3루~홈 */
  const ZONES = [
    { k: 'a', t: '홈~1루' }, { k: 'b', t: '1루~2루' },
    { k: 'c', t: '2루~3루' }, { k: 'd', t: '3루~홈' }
  ];
  const BAT_COLS = [
    { key: '타수', head: '타\n수', w: 'col-stat-w' },
    { key: '득점', head: '득\n점', w: 'col-stat-w' },
    { key: '안타', head: '계\n', group: '안타', w: 'col-stat' },
    { key: '2루타', head: '2\n루\n타', group: '안타', w: 'col-stat' },
    { key: '3루타', head: '3\n루\n타', group: '안타', w: 'col-stat' },
    { key: '홈런', head: '홈\n런', group: '안타', w: 'col-stat' },
    { key: '루타수', head: '루\n타\n수', w: 'col-stat' },
    { key: '타점', head: '타\n점', w: 'col-stat-w' },
    { key: '도루', head: '도\n루', w: 'col-stat-w' },
    { key: '도루실패', head: '도\n루\n실\n패', w: 'col-stat' },
    { key: '희타', head: '희\n타', w: 'col-stat' },
    { key: '희비', head: '희\n비', w: 'col-stat' },
    { key: '4구', head: '4\n구', w: 'col-stat' },
    { key: '고의4구', head: '고\n의\n4\n구', w: 'col-stat' },
    { key: '사구', head: '사\n구', w: 'col-stat' },
    { key: '삼진', head: '삼\n진', w: 'col-stat' },
    { key: '병살타', head: '병\n살\n타', w: 'col-stat' },
    { key: '잔루', head: '잔\n루', w: 'col-stat', cls: 'red' }   /* 원본에서 빨간펜 */
  ];
  const DEF_COLS = [
    { key: 'putout', head: '풋아웃' },
    { key: 'assist', head: '어시스트' },
    { key: 'error',  head: '실책' },
    { key: 'dp',     head: '병살' }
  ];
  const PITCH_COLS = [
    { key: 'batters', head: '타\n자', w: 26 },
    { key: 'pitches', head: '투\n구\n수', w: 34 },
    { key: 'ab',      head: '타\n수', w: 26 },
    { key: 'hits',    head: '피\n안\n타', w: 26 },
    { key: 'hr',      head: '피\n홈\n런', w: 22 },
    { key: 'sh',      head: '희\n타', w: 22 },
    { key: 'sf',      head: '희\n비', w: 22 },
    { key: 'bb',      head: '4\n구', w: 26 },
    { key: 'ibb',     head: '고의4구', w: 24 },
    { key: 'hbp',     head: '사\n구', w: 22 },
    { key: 'so',      head: '탈\n삼\n진', w: 26 },
    { key: 'wp',      head: '폭\n투', w: 22 },
    { key: 'bk',      head: '보\n크', w: 22 },
    { key: 'r',       head: '실\n점', w: 26 },
    { key: 'er',      head: '자\n책\n점', w: 26 }
  ];

  const STORE_KEY = 'bra:sheets:v2';

  let originals = {};   // 파일에서 온 원본값
  let state = {};       // 편집 중인 값
  let currentId = null;

  /* ------------------------------------------------------------------ util */
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const deep = (o) => JSON.parse(JSON.stringify(o));

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = obj;
    for (const k of keys) {
      if (cur[k] == null) cur[k] = /^\d+$/.test(k) ? [] : {};
      cur = cur[k];
    }
    cur[last] = val;
  }

  /** 값에 바인딩된 input 을 만든다. */
  function bound(path, opts) {
    opts = opts || {};
    const i = el('input');
    i.type = 'text';
    i.dataset.path = path;
    i.value = getPath(state[currentId], path) ?? '';
    if (opts.cls) i.className = opts.cls;
    if (opts.title) i.title = opts.title;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.width) i.style.width = opts.width;
    i.addEventListener('input', () => {
      setPath(state[currentId], path, i.value);
      markDirty();
    });
    return i;
  }
  function boundArea(path, rows) {
    const t = el('textarea');
    t.dataset.path = path;
    t.rows = rows || 3;
    t.value = getPath(state[currentId], path) ?? '';
    t.addEventListener('input', () => {
      setPath(state[currentId], path, t.value);
      markDirty();
    });
    return t;
  }
  function td(child, cls, attrs) {
    const c = el('td', cls);
    if (attrs) for (const k in attrs) c.setAttribute(k, attrs[k]);
    if (child != null) c.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    return c;
  }
  function th(text, cls, attrs) {
    const c = el('th', cls);
    if (attrs) for (const k in attrs) c.setAttribute(k, attrs[k]);
    if (text != null) {
      if (String(text).includes('\n')) {
        const v = el('div', 'vhead', String(text).replace(/\n/g, ''));
        c.appendChild(v);
      } else {
        c.textContent = text;
      }
    }
    return c;
  }

  /* ------------------------------------------------------------ normalize */
  function blankRow() {
    const b = {};
    BAT_COLS.forEach(c => (b[c.key] = ''));
    return { uniform: '', putout: '', assist: '', error: '', dp: '', pos: '', name: '', note: '', bat: b };
  }
  function normalize(raw) {
    const s = deep(raw);
    s.header = s.header || {};
    s.linescore = s.linescore || [];
    while (s.linescore.length < 2) s.linescore.push({ team: '', innings: [], total: '' });
    s.linescore.forEach(r => {
      r.innings = r.innings || [];
      while (r.innings.length < INNINGS) r.innings.push('');
    });

    s.slots = s.slots || [];
    while (s.slots.length < 10) s.slots.push({ order: null, rows: [] });
    s.slots.forEach((slot, i) => {
      slot.order = i < 9 ? i + 1 : null;
      slot.rows = slot.rows || [];
      while (slot.rows.length < 3) slot.rows.push({});
      slot.rows = slot.rows.map(r => {
        const base = blankRow();
        const merged = Object.assign(base, r);
        merged.bat = Object.assign(blankRow().bat, r.bat || {});
        return merged;
      });
    });

    s.subs = s.subs || '';
    s.totals = s.totals || {};
    s.totals.members = s.totals.members || '';
    ['hits', 'fielding', 'pitches'].forEach(k => {
      s.totals[k] = s.totals[k] || [];
      while (s.totals[k].length < INNINGS) s.totals[k].push({ l: '', r: '' });
      s.totals[k] = s.totals[k].map(c => ({ l: c.l || '', r: c.r || '' }));
    });

    s.gameInfo = Object.assign(
      { startH: '', startM: '', endH: '', endM: '', excludeM: '', regEndH: '', regEndM: '', durH: '', durM: '', scorer: '' },
      s.gameInfo || {});
    s.umpires = Object.assign(
      { '주심': '', '1루심': '', '2루심': '', '3루심': '', '좌선심': '', '우선심': '' }, s.umpires || {});

    const pad = (arr, n, make) => {
      arr = arr || [];
      while (arr.length < n) arr.push(make());
      return arr;
    };
    s.agreement = pad(s.agreement, 5, () => ({ inn: '', order: '', request: '', content: '', first: '', last: '', duration: '' }));
    s.suspension = pad(s.suspension, 2, () => ({ from: '', to: '', minutes: '' }));
    s.homers = pad(s.homers, 10, () => ({ time: '', team: '', name: '', inn: '', runs: '' }));
    s.doublePlays = pad(s.doublePlays, 5, () => ({ team: '', content: '', inn: '' }));
    s.passedBall = pad(s.passedBall, 2, () => ({ team: '', name: '', inn: '', team2: '', name2: '', inn2: '' }));
    s.indifference = pad(s.indifference, 2, () => ({ team: '', name: '', inn: '', team2: '', name2: '', inn2: '' }));
    s.remarks = s.remarks || '';
    s.pitchers = pad(s.pitchers, 11, () => ({
      dec: '', bs: '', name: '', memo: '', ipWhole: '', ipThird: '', batters: '', pitches: '', ab: '',
      hits: '', hr: '', sh: '', sf: '', bb: '', ibb: '', hbp: '', so: '', wp: '', bk: '', r: '', er: ''
    }));
    s.notes = s.notes || [];
    s.diamond = Array.isArray(s.diamond) ? s.diamond : [];
    return s;
  }

  /** 판독한 다이아몬드 칸을 (타순, 열) 로 찾을 수 있게 묶는다. */
  function diamondIndex(s) {
    const m = new Map();
    s.diamond.forEach(d => m.set(`${d.slot}-${d.col}`, d));
    return m;
  }

  /** 이닝별 색 범례. 열과 이닝이 어긋나므로 어느 칸이 몇 회인지 한눈에 보이게 한다. */
  function buildInningLegend(s) {
    if (!s.diamond.length) return null;
    const by = new Map();
    s.diamond.forEach(d => {
      if (!by.has(d.inning)) by.set(d.inning, { pa: 0, cols: new Set() });
      const e = by.get(d.inning);
      e.pa += 1;
      e.cols.add(d.col);
    });
    const wrap = el('div', 'inn-legend');
    wrap.appendChild(el('span', 'lg-title', '판독한 이닝'));
    [...by.keys()].sort((a, b) => a - b).forEach(n => {
      const e = by.get(n);
      const cols = [...e.cols].sort((a, b) => a - b).join('·');
      const item = el('span', 'lg inn-' + n);
      item.appendChild(el('i'));
      item.appendChild(el('b', null, n + '회'));
      item.appendChild(el('span', null, `${e.pa}타석 · ${cols}열`));
      wrap.appendChild(item);
    });
    return wrap;
  }

  /** 다이아몬드 칸 하나를 그린다. d 가 없으면 빈 칸. */
  function buildDiamond(d) {
    const wrap = el('div', 'dia-wrap');

    const bc = el('div', 'bc');
    ((d && d.count) || []).forEach(code => {
      const m = COUNT_MARK[code];
      const n = el('span', 'bc-mark', m ? m.g : code);
      n.title = m ? m.t : code;
      bc.appendChild(n);
    });
    wrap.appendChild(bc);

    const box = el('div', 'dia-box');
    box.appendChild(el('div', 'diamond'));
    if (d) {
      const z = d.z || {};
      ZONES.forEach(zone => {
        if (!z[zone.k]) return;
        const n = el('span', 'zmark z-' + zone.k, z[zone.k]);
        n.title = zone.t;
        box.appendChild(n);
      });
      if (d.center) box.appendChild(el('span', 'dia-center k-' + (d.kind || ''), d.center));
      if (d.result) box.appendChild(el('span', 'dia-result', d.result));
    }
    wrap.appendChild(box);
    return wrap;
  }

  /* --------------------------------------------------------------- 상단부 */
  function buildTop(s) {
    const wrap = el('div');

    if (s.form === 'top') {
      const row = el('div', 'top-area');

      const left = el('div');
      const noLine = el('div', 'top-line');
      noLine.style.justifyContent = 'flex-end';
      noLine.appendChild(el('span', null, 'No.'));
      noLine.appendChild(bound('header.no', { width: '70px' }));
      left.appendChild(noLine);

      const box = el('div', 'box-head');
      const d = el('div', 'top-line');
      d.appendChild(bound('header.year', { width: '54px' }));
      d.appendChild(el('span', null, '년'));
      d.appendChild(bound('header.month', { width: '34px' }));
      d.appendChild(el('span', null, '월'));
      d.appendChild(bound('header.day', { width: '34px' }));
      d.appendChild(el('span', null, '일 ('));
      d.appendChild(bound('header.weekday', { width: '28px' }));
      d.appendChild(el('span', null, ') 요일'));
      box.appendChild(d);

      const t = el('div', 'top-line');
      t.style.marginLeft = '40px';
      const vh = el('div');
      vh.appendChild(el('div', 'vh-mark', '( V )'));
      const vi = bound('header.visitor', { width: '150px' }); vi.classList.add('big');
      vh.appendChild(vi);
      const hh = el('div');
      hh.appendChild(el('div', 'vh-mark', '( H )'));
      const hi = bound('header.home', { width: '150px' }); hi.classList.add('big');
      hh.appendChild(hi);
      t.appendChild(vh);
      t.appendChild(el('span', null, 'VS'));
      t.appendChild(hh);
      box.appendChild(t);
      left.appendChild(box);
      row.appendChild(left);

      const right = el('div');
      const att = el('div', 'top-line');
      att.style.justifyContent = 'flex-end';
      att.appendChild(el('span', null, '관중수 :'));
      att.appendChild(bound('header.attendance', { width: '80px' }));
      att.appendChild(el('span', null, '명'));
      right.appendChild(att);
      right.appendChild(buildLinescore(s));
      row.appendChild(right);

      wrap.appendChild(row);
    } else {
      const line = el('div', 'top-line');
      line.style.flexWrap = 'wrap';
      line.style.marginBottom = '6px';
      const add = (label, path, w, after) => {
        if (label) line.appendChild(el('span', null, label));
        line.appendChild(bound(path, { width: w }));
        if (after) line.appendChild(el('span', null, after));
      };
      add('', 'header.year', '54px', '년');
      add('', 'header.month', '30px', '월');
      add('', 'header.day', '30px', '일 (');
      add('', 'header.weekday', '28px', ') 요일');
      line.appendChild(el('span', null, ' '));
      add('', 'header.visitor', '120px', '대');
      add('', 'header.home', '120px', '');
      add('NO.', 'header.no', '60px', '');
      add('구장명', 'header.park', '90px', '구장');
      add('온도', 'header.temp', '40px', '℃');
      add('습도', 'header.humidity', '40px', '%');
      add('일기', 'header.weather', '60px', '');
      add('풍속', 'header.windDir', '40px', '');
      add('', 'header.windSpeed', '34px', 'm/sec');
      wrap.appendChild(line);
    }
    return wrap;
  }

  function buildLinescore(s) {
    const t = el('table');
    const head = el('tr');
    head.appendChild(th('TEAM', 'b-strong'));
    for (let i = 1; i <= INNINGS; i++) head.appendChild(th(String(i), 'b-strong'));
    head.appendChild(th('합계', 'b-strong'));
    t.appendChild(head);

    s.linescore.forEach((r, ri) => {
      const tr = el('tr');
      const nameTd = td(bound(`linescore.${ri}.team`, { width: '86px' }), 'b-strong');
      tr.appendChild(nameTd);
      for (let i = 0; i < INNINGS; i++) {
        tr.appendChild(td(bound(`linescore.${ri}.innings.${i}`, { width: '34px' }), 'b-strong'));
      }
      tr.appendChild(td(bound(`linescore.${ri}.total`, { width: '46px' }), 'b-strong'));
      t.appendChild(tr);
    });
    return t;
  }

  /* ---------------------------------------------------------------- 본표 */
  function buildGrid(s) {
    const dia = diamondIndex(s);
    const table = el('table', 'grid');
    const cg = el('colgroup');
    const col = (cls) => { const c = el('col', cls); cg.appendChild(c); };
    col('col-uniform');
    DEF_COLS.forEach(() => col('col-def'));
    col('col-pos'); col('col-name'); col('col-note'); col('col-ord');
    for (let i = 0; i < INNINGS * 2; i++) col('col-inn');
    BAT_COLS.forEach(c => col(c.w));
    table.appendChild(cg);

    /* --- header --- */
    const h1 = el('tr', 'hrow'), h2 = el('tr', 'hrow');
    h1.appendChild(th('등번호', 'b-strong', { rowspan: 2 }));
    DEF_COLS.forEach(c => h1.appendChild(th(c.head + '\n', 'b-strong', { rowspan: 2 })));
    const posTh = th(null, 'b-strong', { rowspan: 2 });
    posTh.appendChild(el('div', null, '수비'));
    posTh.appendChild(el('div', null, '위치'));
    h1.appendChild(posTh);

    const teamTh = th(null, 'b-strong', { colspan: 3 });
    teamTh.appendChild(bound('team', { cls: 'big' }));
    h1.appendChild(teamTh);

    for (let i = 1; i <= INNINGS; i++) h1.appendChild(th(String(i), 'b-strong', { colspan: 2, rowspan: 2 }));

    BAT_COLS.forEach((c, idx) => {
      if (c.group === '안타') {
        if (idx === 2) h1.appendChild(th('안       타', 'b-strong', { colspan: 4 }));
        h2.appendChild(th(c.head, 'b-strong'));
      } else {
        h1.appendChild(th(c.head, 'b-strong', { rowspan: 2 }));
      }
    });

    h2.appendChild(th(s.sideLabel || 'Top', 'b-strong', { colspan: 2 }));
    h2.appendChild(th(s.sideLabel2 || '초공격', 'b-strong'));
    // 안타 하위 4칸은 위 루프에서 h2 에 이미 붙었으므로 순서를 맞춰 재정렬
    const sub = Array.from(h2.children);
    h2.innerHTML = '';
    sub.slice(4).forEach(n => h2.appendChild(n));   // Top / 초공격
    // 이닝 헤더는 rowspan=2 라 h2 에는 없음
    sub.slice(0, 4).forEach(n => h2.appendChild(n)); // 계 / 2루타 / 3루타 / 홈런
    table.appendChild(h1);
    table.appendChild(h2);

    /* --- body --- */
    s.slots.forEach((slot, si) => {
      const isSubsRow = slot.order == null;
      for (let ri = 0; ri < 3; ri++) {
        const tr = el('tr');
        const base = `slots.${si}.rows.${ri}`;
        const topCls = ri === 0 ? ' bt' : '';

        tr.appendChild(td(bound(`${base}.uniform`), 'b-strong' + topCls));
        DEF_COLS.forEach(c => tr.appendChild(td(bound(`${base}.${c.key}`), topCls.trim())));
        tr.appendChild(td(bound(`${base}.pos`), 'bl' + topCls));
        tr.appendChild(td(bound(`${base}.name`, { cls: 'left big' }), 'bl' + topCls));
        tr.appendChild(td(bound(`${base}.note`), topCls.trim()));
        tr.appendChild(td(slot.order ? el('span', 'ord-num', String(slot.order + ri * 10)) : null,
                          'br' + topCls));

        if (ri === 0) {
          if (isSubsRow) {
            const c = td(null, 'subs-cell b-strong', { colspan: INNINGS * 2, rowspan: 3 });
            c.appendChild(el('div', 'lab', '교대란'));
            c.appendChild(boundArea('subs', 4));
            tr.appendChild(c);
          } else {
            for (let i = 0; i < INNINGS; i++) {
              const d = dia.get(`${slot.order}-${i + 1}`);
              const title = d
                ? `${d.inning}회 ${d.pa}번째 타석 · ${slot.order}번` + (d.note ? `\n${d.note}` : '')
                : '볼카운트/타석 영역 — 아직 판독하지 않음';
              const mark = d
                ? ` has-read inn-${d.inning}` + (d.pa === 1 ? ' inn-start' : '')
                : '';
              const c = td(null,
                           'diamond-cell' + (i === 0 ? ' bl' : '') + ' bt' + mark,
                           { colspan: 2, rowspan: 3, title: title });
              c.appendChild(buildDiamond(d));
              tr.appendChild(c);
            }
          }
        }

        BAT_COLS.forEach((c, ci) => {
          tr.appendChild(td(bound(`${base}.bat.${c.key}`, { cls: c.cls }),
                            (ci === 0 ? 'bl' : '') + topCls));
        });
        table.appendChild(tr);
      }
    });

    /* --- 하단 집계 3행 --- */
    const rowsDef = [
      { key: 'hits',     labels: ['안타', null],   cls: 'bt' },
      { key: 'fielding', labels: ['보살', '실책'], cls: '' },
      { key: 'pitches',  labels: ['투구수', null], cls: '' }
    ];
    rowsDef.forEach((rd, rIdx) => {
      const tr = el('tr', 'total-row');
      if (rIdx === 0) {
        const c = td(null, 'b-strong', { colspan: 9, rowspan: 3 });
        const box = el('div', 'cell-lab-input');
        box.style.justifyContent = 'center';
        box.appendChild(el('span', 'inline-lab', '합계'));
        box.appendChild(bound('totals.members', { width: '60px' }));
        box.appendChild(el('span', 'inline-lab', '명'));
        c.appendChild(box);
        tr.appendChild(c);
      }
      for (let i = 0; i < INNINGS; i++) {
        ['l', 'r'].forEach((side, sIdx) => {
          const cell = el('td', (i === 0 && sIdx === 0 ? 'bl ' : '') + rd.cls);
          const lab = i === 0 ? rd.labels[sIdx] : null;
          if (lab) {
            const box = el('div', 'stack-lab');
            box.appendChild(el('span', 'inline-lab', lab));
            box.appendChild(bound(`totals.${rd.key}.${i}.${side}`));
            cell.appendChild(box);
          } else {
            cell.appendChild(bound(`totals.${rd.key}.${i}.${side}`));
          }
          tr.appendChild(cell);
        });
      }
      tr.appendChild(td(null, 'bl ' + rd.cls, { colspan: BAT_COLS.length }));
      table.appendChild(tr);
    });

    return table;
  }

  /* ------------------------------------------------------------ 하단 패널 */
  function panel(title, node) {
    const p = el('div', 'panel');
    if (title) p.appendChild(el('div', 'panel-title', title));
    p.appendChild(node);
    return p;
  }

  function labeledRow(label, nodes) {
    const tr = el('tr');
    tr.appendChild(td(label, 'lab-td'));
    nodes.forEach(n => tr.appendChild(n));
    return tr;
  }

  function buildGameInfo() {
    const t = el('table');
    const mk = (label, hPath, mPath, hint) => {
      const tr = el('tr');
      tr.appendChild(td(label, 'lab-td'));
      const c = td(null);
      const box = el('div', 'cell-lab-input');
      box.style.justifyContent = 'flex-end';
      if (hPath) { box.appendChild(bound(hPath, { width: '46px' })); box.appendChild(el('span', 'inline-lab', hint || '시')); }
      box.appendChild(bound(mPath, { width: '46px' }));
      box.appendChild(el('span', 'inline-lab', hint === '시간' ? '분' : '분'));
      c.appendChild(box);
      tr.appendChild(c);
      return tr;
    };
    t.appendChild(mk('개 시', 'gameInfo.startH', 'gameInfo.startM'));
    t.appendChild(mk('종 료', 'gameInfo.endH', 'gameInfo.endM'));
    t.appendChild(mk('제외시간', null, 'gameInfo.excludeM'));
    t.appendChild(mk('정규이닝(9회)종료', 'gameInfo.regEndH', 'gameInfo.regEndM'));
    t.appendChild(mk('소요시간', 'gameInfo.durH', 'gameInfo.durM', '시간'));
    const tr = el('tr');
    tr.appendChild(td('공식기록원', 'lab-td'));
    tr.appendChild(td(bound('gameInfo.scorer', { cls: 'big' }), null, { style: 'width:180px' }));
    t.appendChild(tr);
    return t;
  }

  function buildUmpires() {
    const t = el('table');
    ['주심', '1루심', '2루심', '3루심', '좌선심', '우선심'].forEach(k => {
      const tr = el('tr');
      tr.appendChild(td(k, 'lab-td'));
      tr.appendChild(td(bound(`umpires.${k}`, { cls: 'big' }), null, { style: 'width:170px' }));
      t.appendChild(tr);
    });
    return t;
  }

  function buildAgreement(s) {
    const wrap = el('div');
    const t = el('table');
    const h = el('tr');
    ['회', '타순', '요청', '내 용', '최초', '최종', '소요시간'].forEach((x, i) =>
      h.appendChild(th(x, 'b-strong', { style: i === 3 ? 'width:180px' : 'width:56px' })));
    t.appendChild(h);
    s.agreement.forEach((_, i) => {
      const tr = el('tr');
      ['inn', 'order', 'request', 'content', 'first', 'last', 'duration'].forEach(k =>
        tr.appendChild(td(bound(`agreement.${i}.${k}`))));
      t.appendChild(tr);
    });
    wrap.appendChild(t);

    const t2 = el('table');
    const h2 = el('tr');
    h2.appendChild(th('경기중단', 'b-strong', { style: 'width:70px' }));
    h2.appendChild(th('시작', 'b-strong'));
    h2.appendChild(th('재개', 'b-strong'));
    h2.appendChild(th('소요(분)', 'b-strong'));
    t2.appendChild(h2);
    s.suspension.forEach((_, i) => {
      const tr = el('tr');
      tr.appendChild(td('', 'lab-td'));
      ['from', 'to', 'minutes'].forEach(k => tr.appendChild(td(bound(`suspension.${i}.${k}`))));
      t2.appendChild(tr);
    });
    wrap.appendChild(t2);
    return wrap;
  }

  function buildHomers(s) {
    const t = el('table');
    const h = el('tr');
    [['시 각', 66], ['소속', 70], ['성 명', 96], ['회', 34], ['점 수', 40]].forEach(([x, w]) =>
      h.appendChild(th(x, 'b-strong', { style: `width:${w}px` })));
    t.appendChild(h);
    s.homers.forEach((_, i) => {
      const tr = el('tr');
      ['time', 'team', 'name', 'inn', 'runs'].forEach(k => tr.appendChild(td(bound(`homers.${i}.${k}`))));
      t.appendChild(tr);
    });
    return t;
  }

  function buildDP(s) {
    const t = el('table');
    const h = el('tr');
    [['소속', 70], ['병살내용(D.P)', 190], ['회', 40]].forEach(([x, w]) =>
      h.appendChild(th(x, 'b-strong', { style: `width:${w}px` })));
    t.appendChild(h);
    s.doublePlays.forEach((_, i) => {
      const tr = el('tr');
      ['team', 'content', 'inn'].forEach(k => tr.appendChild(td(bound(`doublePlays.${i}.${k}`))));
      t.appendChild(tr);
    });
    return t;
  }

  function buildPBS(s) {
    const t = el('table');
    const h = el('tr');
    h.appendChild(th('', 'b-strong', { style: 'width:70px' }));
    [['소속', 62], ['선수명', 96], ['회', 34], ['소속', 62], ['선수명', 96], ['회', 34]].forEach(([x, w]) =>
      h.appendChild(th(x, 'b-strong', { style: `width:${w}px` })));
    t.appendChild(h);
    const block = (label, key, rows) => {
      rows.forEach((_, i) => {
        const tr = el('tr');
        if (i === 0) tr.appendChild(td(label, 'lab-td', { rowspan: rows.length }));
        ['team', 'name', 'inn', 'team2', 'name2', 'inn2'].forEach(k =>
          tr.appendChild(td(bound(`${key}.${i}.${k}`))));
        t.appendChild(tr);
      });
    };
    block('패스트볼(P)', 'passedBall', s.passedBall);
    block('무관심진루자(S)', 'indifference', s.indifference);
    return t;
  }

  function buildPitchers(s) {
    const t = el('table');
    const h1 = el('tr'), h2 = el('tr');
    h1.appendChild(th('승패\nS.H'.replace('\n', ' '), 'b-strong', { rowspan: 2, style: 'width:44px' }));
    h1.appendChild(th('B S', 'b-strong', { rowspan: 2, style: 'width:32px' }));
    h1.appendChild(th('투           수', 'b-strong', { rowspan: 2, style: 'width:180px' }));
    h1.appendChild(th('', 'b-strong', { rowspan: 2, style: 'width:44px' }));
    h1.appendChild(th('투구', 'b-strong', { colspan: 2 }));
    PITCH_COLS.forEach(c => h1.appendChild(th(c.head, 'b-strong', { rowspan: 2, style: `width:${c.w}px` })));
    h2.appendChild(th('회수', 'b-strong', { colspan: 2 }));
    t.appendChild(h1); t.appendChild(h2);

    s.pitchers.forEach((_, i) => {
      const tr = el('tr');
      tr.appendChild(td(bound(`pitchers.${i}.dec`, { cls: 'big' })));
      tr.appendChild(td(bound(`pitchers.${i}.bs`)));
      tr.appendChild(td(bound(`pitchers.${i}.name`, { cls: 'left big' })));
      tr.appendChild(td(bound(`pitchers.${i}.memo`)));
      tr.appendChild(td(bound(`pitchers.${i}.ipWhole`), null, { style: 'width:30px' }));
      const ipT = el('td');
      const box = el('div', 'cell-lab-input');
      box.appendChild(bound(`pitchers.${i}.ipThird`, { width: '18px' }));
      box.appendChild(el('span', 'inline-lab', '/3'));
      ipT.appendChild(box);
      ipT.style.width = '40px';
      tr.appendChild(ipT);
      PITCH_COLS.forEach(c => tr.appendChild(td(bound(`pitchers.${i}.${c.key}`))));
      t.appendChild(tr);
    });
    return t;
  }

  function buildBottom(s) {
    const area = el('div', 'bottom-area');
    if (s.form === 'top') {
      area.appendChild(panel(null, buildGameInfo()));
      area.appendChild(panel(null, buildUmpires()));
      area.appendChild(panel('합의판정', buildAgreement(s)));
      area.appendChild(panel(null, buildPitchers(s)));
    } else {
      area.appendChild(panel('홈런타자', buildHomers(s)));
      area.appendChild(panel(null, buildDP(s)));
      area.appendChild(panel(null, buildPBS(s)));
      const rm = el('div');
      rm.style.width = '360px';
      rm.appendChild(boundArea('remarks', 6));
      area.appendChild(panel('비고', rm));
      area.appendChild(panel(null, buildPitchers(s)));
    }
    return area;
  }

  /* --------------------------------------------------------------- render */
  function render() {
    const s = state[currentId];
    const root = document.getElementById('sheet');
    root.innerHTML = '';
    root.appendChild(buildTop(s));
    const legend = buildInningLegend(s);
    if (legend) root.appendChild(legend);
    root.appendChild(buildGrid(s));
    root.appendChild(buildBottom(s));

    const notes = document.getElementById('notes');
    notes.innerHTML = '';
    if (s.notes && s.notes.length) {
      notes.appendChild(el('h2', null, '판독 메모'));
      const ul = el('ul');
      s.notes.forEach(n => ul.appendChild(el('li', null, n)));
      notes.appendChild(ul);
    }
  }

  /* -------------------------------------------------------------- persist */
  let dirty = false;
  function markDirty() {
    dirty = true;
    setStatus('수정됨 (저장 안 됨)');
  }
  function setStatus(msg) {
    document.getElementById('status').textContent = msg;
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    dirty = false;
    setStatus('저장됨 · ' + new Date().toLocaleTimeString('ko-KR'));
  }
  function loadStored() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /* ----------------------------------------------------------------- boot */
  function boot() {
    const src = window.SCORESHEETS || {};
    Object.keys(src).forEach(id => { originals[id] = normalize(src[id]); });

    /* 저장본이 있으면 그것을 쓰되, 저장본에 없는 항목은 원본에서 채운다.
       그래야 판독을 새로 해서 records.js 에 항목이 늘어났을 때(예: diamond)
       예전에 저장해 둔 브라우저에서도 새 항목이 보인다. 편집한 값은 그대로 이긴다. */
    const stored = loadStored() || {};
    const filled = [];
    Object.keys(originals).forEach(id => {
      if (!stored[id]) { state[id] = deep(originals[id]); return; }
      const base = deep(originals[id]);
      Object.keys(base).forEach(k => {
        if (!(k in stored[id])) filled.push(`${id}.${k}`);
      });
      state[id] = normalize(Object.assign(base, stored[id]));
    });
    if (filled.length) {
      console.info('[기록지] 저장본에 없어 원본에서 채운 항목:', filled.join(', '));
    }

    const sel = document.getElementById('sheetSelect');
    Object.keys(originals).forEach(id => {
      const o = el('option', null, originals[id].title || id);
      o.value = id;
      sel.appendChild(o);
    });
    const asked = new URLSearchParams(location.search).get('sheet');
    currentId = originals[asked] ? asked : Object.keys(originals)[0];
    sel.value = currentId;
    sel.addEventListener('change', () => { currentId = sel.value; render(); setStatus(''); });

    document.getElementById('btnSave').addEventListener('click', save);

    document.getElementById('btnExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state[currentId], null, 2)], { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentId + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById('fileImport').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const obj = JSON.parse(r.result);
          const id = obj.id || currentId;
          state[id] = normalize(obj);
          if (!originals[id]) {
            originals[id] = deep(state[id]);
            const o = el('option', null, state[id].title || id);
            o.value = id;
            document.getElementById('sheetSelect').appendChild(o);
          }
          currentId = document.getElementById('sheetSelect').value = id;
          render();
          setStatus('불러옴: ' + f.name);
        } catch (e) {
          alert('JSON 을 읽지 못했습니다: ' + e.message);
        }
      };
      r.readAsText(f);
      ev.target.value = '';
    });

    document.getElementById('btnReset').addEventListener('click', () => {
      if (!confirm('현재 시트를 원본 판독값으로 되돌립니다. 계속할까요?')) return;
      state[currentId] = deep(originals[currentId]);
      render();
      save();
      setStatus('원본값으로 복원됨');
    });

    const modal = document.getElementById('imageModal');
    document.getElementById('btnImage').addEventListener('click', () => {
      const s = state[currentId];
      document.getElementById('sourceImage').src = '../' + (s.source || '');
      document.getElementById('imageCaption').textContent = s.source || '';
      modal.hidden = false;
    });
    document.getElementById('btnImageClose').addEventListener('click', () => { modal.hidden = true; });

    document.getElementById('btnPrint').addEventListener('click', () => window.print());

    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    render();
    setStatus(Object.keys(originals).length + '개 시트 로드됨');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
