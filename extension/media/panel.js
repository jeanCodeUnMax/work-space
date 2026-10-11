// Webview UI logic for the Everything-style search panel.
// Runs inside the webview sandbox: DOM + acquireVsCodeApi only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const q = document.getElementById('q');
  const filterEl = document.getElementById('filter');
  const statusEl = document.getElementById('status');
  const tbody = document.getElementById('tbody');
  const ctxMenu = document.getElementById('ctxMenu');

  // Everything's default filter dropdown (Everything.exe built-ins).
  // Only folder:/file: are native IPC functions — the named filters are
  // ext: lists compiled into the app; we replicate them here.
  const FILTERS = {
    '': '',
    audio: 'ext:aac;ac3;aif;aiff;ape;au;cda;flac;m4a;mid;midi;mp3;ogg;ra;wav;wma',
    compressed: 'ext:7z;ace;arj;bz2;cab;gz;gzip;jar;lz4;rar;tar;tgz;xz;z;zip;zipx;zst',
    doc: 'ext:csv;doc;docm;docx;epub;md;ods;odt;pdf;ppt;pptx;rtf;txt;xls;xlsm;xlsx',
    exe: 'ext:bat;cmd;com;exe;msi;ps1;scr;vbs',
    folder: 'folder:',
    image: 'ext:ai;bmp;dds;gif;heic;ico;jfif;jpe;jpeg;jpg;png;psd;svg;tga;tif;tiff;webp',
    video: 'ext:3gp;asf;avi;flv;m2ts;m4v;mkv;mov;mp4;mpe;mpeg;mpg;mts;ts;vob;webm;wmv',
  };

  const state = {
    seq: 0,
    sort: 'name',
    descending: false,
    results: [],
    total: 0,
    renderCap: 500,
    sel: -1, // selected row index (rendered rows only)
    ctxPath: null,
  };

  // ---------------- query ----------------

  let debTimer = null;
  q.addEventListener('input', () => {
    clearTimeout(debTimer);
    debTimer = setTimeout(search, 150);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debTimer); search(); }
    else if (e.key === 'Escape') { q.value = ''; search(); }
    else if (e.key === 'ArrowDown') { moveSel(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { moveSel(-1); e.preventDefault(); }
  });

  filterEl.addEventListener('change', () => { search(); q.focus(); });

  function effectiveQuery() {
    const frag = FILTERS[filterEl.value] || '';
    return frag ? frag + ' ' + q.value : q.value;
  }

  function search() {
    state.seq += 1;
    vscode.postMessage({
      type: 'search',
      seq: state.seq,
      query: effectiveQuery(),
      sort: state.sort,
      descending: state.descending,
    });
    statusEl.textContent = 'Searching…';
  }

  // ---------------- rendering ----------------

  // mtime defensive decode. Verified against live server 2026-10:
  // everything_ipc.py's FILETIME delta is off by 10x (uses the 1601->1970
  // delta in us instead of 100ns), so the wire value is actually
  // unix_seconds + 10480026240 (~1.2e10). Handle that first, then fall back
  // to "true" seconds-since-1601 and plain unix s/ms, picking the first
  // candidate that lands in [1970, now+2d].
  function mtimeToMs(m) {
    if (m == null || !isFinite(m) || m <= 0) return null;
    if (m > 1e15) m = m / 1e7; // raw FILETIME -> seconds since 1601
    const candidates = [];
    if (m > 1e10) {
      candidates.push((m - 10480026240) * 1000); // current server quirk
      candidates.push((m - 11644473600) * 1000); // proper seconds-since-1601
    }
    candidates.push(m > 1e12 ? m : m * 1000);    // unix ms / unix s
    const hi = Date.now() + 2 * 24 * 3600 * 1000;
    for (const c of candidates) {
      if (c >= 0 && c <= hi) return c;
    }
    return candidates[0];
  }

  function fmtSize(n) {
    if (n == null || !isFinite(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function fmtDate(m) {
    const ms = mtimeToMs(m);
    if (ms == null) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function dirOf(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }

  function render(payload) {
    const rows = payload.results || [];
    state.results = rows;
    state.total = payload.total != null ? payload.total : rows.length;
    state.sel = rows.length ? 0 : -1;

    const shown = Math.min(rows.length, state.renderCap);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < shown; i += 1) {
      const it = rows[i];
      const tr = document.createElement('tr');
      tr.dataset.i = String(i);
      tr.draggable = true;
      tr.title = it.path;

      const icon = document.createElement('td');
      icon.className = 'icon';
      icon.textContent = it.dir ? '📁' : '📄';
      tr.appendChild(icon);

      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = it.name || '';
      tr.appendChild(name);

      const dir = document.createElement('td');
      dir.className = 'path';
      dir.textContent = dirOf(it.path || '');
      tr.appendChild(dir);

      const size = document.createElement('td');
      size.className = 'num';
      size.textContent = it.dir ? '' : fmtSize(it.size);
      tr.appendChild(size);

      const mod = document.createElement('td');
      mod.className = 'date';
      mod.textContent = fmtDate(it.mtime);
      tr.appendChild(mod);

      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
    markSel();

    let s = `${state.total.toLocaleString()} result${state.total === 1 ? '' : 's'}` +
            ` in ${payload.elapsed_ms != null ? payload.elapsed_ms : '?'} ms`;
    if (rows.length > shown) s += ` — showing ${shown} of ${rows.length} returned`;
    if (payload.filtered_by_policy) s += ` (${payload.filtered_by_policy} filtered by policy)`;
    statusEl.textContent = s;
  }

  // ---------------- selection & open ----------------

  function markSel() {
    const rows = tbody.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle('sel', i === state.sel);
    }
    if (state.sel >= 0 && rows[state.sel]) {
      rows[state.sel].scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSel(d) {
    const n = tbody.children.length;
    if (!n) return;
    state.sel = Math.min(n - 1, Math.max(0, state.sel + d));
    markSel();
  }

  function openItem(it) {
    if (!it) return;
    vscode.postMessage({ type: 'open', path: it.path, dir: !!it.dir });
  }

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    state.sel = Number(tr.dataset.i);
    markSel();
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    openItem(state.results[Number(tr.dataset.i)]);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement !== q) {
      openItem(state.results[state.sel]);
    }
  });

  // ---------------- drag & drop out of the webview ----------------

  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !e.dataTransfer) return;
    const it = state.results[Number(tr.dataset.i)];
    if (!it) return;
    const uri = 'file:///' + encodeURI(it.path.replace(/\\/g, '/'));
    e.dataTransfer.setData('text/uri-list', uri);
    e.dataTransfer.setData('text/plain', it.path);
    e.dataTransfer.effectAllowed = 'copy';
    vscode.postMessage({ type: 'dragStart', path: it.path });
  });

  // ---------------- context menu ----------------

  tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    e.preventDefault();
    state.sel = Number(tr.dataset.i);
    markSel();
    const it = state.results[state.sel];
    if (!it) return;
    state.ctxPath = it.path;
    ctxMenu.classList.remove('hidden');
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
  });
  document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
  ctxMenu.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    const p = state.ctxPath;
    if (!act || !p) return;
    if (act === 'open') {
      const it = state.results[state.sel];
      openItem(it);
    } else {
      vscode.postMessage({ type: act, path: p });
    }
    ctxMenu.classList.add('hidden');
  });

  // ---------------- column sorting ----------------

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      if (state.sort === f) {
        state.descending = !state.descending;
      } else {
        state.sort = f;
        state.descending = false;
      }
      document.querySelectorAll('th .arrow').forEach((a) => { a.textContent = ''; });
      th.querySelector('.arrow').textContent = state.descending ? '▼' : '▲';
      search();
    });
  });

  // ---------------- extension -> webview ----------------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.seq != null && msg.seq !== state.seq) return; // stale response
    if (msg.type === 'results') {
      if (msg.renderCap) state.renderCap = msg.renderCap;
      render(msg.payload || {});
    } else if (msg.type === 'error') {
      statusEl.textContent = 'Error: ' + msg.message;
    }
  });

  vscode.postMessage({ type: 'ready' });
  q.focus();
})();
