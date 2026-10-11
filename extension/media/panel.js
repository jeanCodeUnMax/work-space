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
    sel: -1, // cursor row index
    selSet: new Set(), // multi-selection (shift/ctrl)
    anchor: -1, // shift-range anchor
    ctxPath: null,
    previewOn: false,
    pendingCreate: null, // {kind:'file'|'dir', parent}
    mode: 'search', // 'search' | 'browse'
    cwd: '', // current browse dir ('' = PC / drives)
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
    state.mode = 'search';
    state.cwd = '';
    state.seq += 1;
    renderCrumbs();
    vscode.postMessage({
      type: 'search',
      seq: state.seq,
      query: effectiveQuery(),
      sort: state.sort,
      descending: state.descending,
    });
    statusEl.textContent = 'Searching…';
  }

  // ---------------- browse mode (file-browser navigation) ----------------

  function navTo(dir) {
    state.mode = 'browse';
    state.cwd = dir || '';
    state.seq += 1;
    renderCrumbs();
    vscode.postMessage({ type: 'browse', seq: state.seq, path: state.cwd });
    statusEl.textContent = 'Loading…';
  }

  const crumbsEl = document.getElementById('crumbs');
  function renderCrumbs() {
    crumbsEl.innerHTML = '';
    const pc = document.createElement('span');
    pc.className = 'crumb' + (state.mode === 'browse' && !state.cwd ? ' here' : '');
    pc.textContent = '🖥 PC';
    pc.title = 'Drives';
    pc.addEventListener('click', () => navTo(''));
    crumbsEl.appendChild(pc);
    if (state.mode === 'search') {
      crumbsEl.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const s = document.createElement('span');
      s.className = 'crumb here';
      s.textContent = '🔍 search';
      crumbsEl.appendChild(s);
      return;
    }
    // browse: split cwd into clickable segments
    const parts = state.cwd.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => {
      acc += (i === 0 ? part + '\\' : part + '\\'); // keep trailing sep in path
      const target = acc;
      crumbsEl.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const c = document.createElement('span');
      c.className = 'crumb' + (i === parts.length - 1 ? ' here' : '');
      c.textContent = part;
      c.title = target;
      c.addEventListener('click', () => navTo(target));
      crumbsEl.appendChild(c);
    });
  }
  renderCrumbs();

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

  function parentOf(cwd) {
    const p = (cwd || '').replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(p)) return ''; // drive root -> PC drives
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    if (/^[A-Za-z]:/.test(p) && i <= 2) return p.slice(0, 2) + '\\'; // parent = drive root
    return i > 0 ? p.slice(0, i) : '';
  }

  function render(payload) {
    const rows = payload.results || [];
    state.results = rows;
    state.total = payload.total != null ? payload.total : rows.length;
    state.sel = rows.length ? 0 : -1;
    state.selSet = new Set(state.sel >= 0 ? [0] : []);
    state.anchor = state.sel;

    const shown = Math.min(rows.length, state.renderCap);
    const frag = document.createDocumentFragment();

    // ".." row to go up — always first when browsing a real dir
    if (state.mode === 'browse' && state.cwd) {
      const up = document.createElement('tr');
      up.dataset.i = '-1';
      const ic = document.createElement('td');
      ic.className = 'icon';
      ic.textContent = '↩';
      const nm = document.createElement('td');
      nm.className = 'name';
      nm.textContent = '..';
      nm.colSpan = 4;
      up.appendChild(ic);
      up.appendChild(nm);
      up.addEventListener('dblclick', () => navTo(parentOf(state.cwd)));
      up.title = 'Parent directory';
      frag.appendChild(up);
    }

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

    let s;
    if (state.mode === 'browse') {
      s = `${state.total.toLocaleString()} item${state.total === 1 ? '' : 's'} — ${state.cwd || 'PC (drives)'}`;
    } else {
      s = `${state.total.toLocaleString()} result${state.total === 1 ? '' : 's'}` +
          ` in ${payload.elapsed_ms != null ? payload.elapsed_ms : '?'} ms`;
      if (rows.length > shown) s += ` — showing ${shown} of ${rows.length} returned`;
      if (payload.filtered_by_policy) s += ` (${payload.filtered_by_policy} filtered by policy)`;
    }
    statusEl.textContent = s;
  }

  // ---------------- selection & open ----------------

  function markSel() {
    const rows = tbody.children;
    for (let i = 0; i < rows.length; i += 1) {
      const idx = Number(rows[i].dataset.i);
      rows[i].classList.toggle('sel', state.selSet.has(idx));
    }
    if (state.sel >= 0 && rows[state.sel]) {
      rows[state.sel].scrollIntoView({ block: 'nearest' });
    }
    if (state.previewOn) requestPreview();
  }

  function moveSel(d) {
    const n = tbody.children.length;
    if (!n) return;
    state.sel = Math.min(n - 1, Math.max(0, state.sel + d));
    state.selSet = new Set([state.sel]);
    state.anchor = state.sel;
    markSel();
  }

  function selectedItems() {
    const idx = [...state.selSet].sort((a, b) => a - b);
    const list = idx.map((i) => state.results[i]).filter(Boolean);
    return list.length ? list : (state.results[state.sel] ? [state.results[state.sel]] : []);
  }

  function parentDirOf(it) {
    // creation target: inside a selected dir, else next to a selected file
    return it && it.dir ? it.path : dirOf(it ? it.path : '');
  }

  function openItem(it) {
    if (!it) return;
    // dirs: navigate INTO them (browser mode); files: open in the IDE
    if (it.dir) navTo(it.path);
    else vscode.postMessage({ type: 'open', path: it.path, dir: false });
  }

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || tr.classList.contains('pending')) return;
    const i = Number(tr.dataset.i);
    if (e.shiftKey && state.anchor >= 0) {
      const lo = Math.min(state.anchor, i);
      const hi = Math.max(state.anchor, i);
      state.selSet = new Set();
      for (let k = lo; k <= hi; k += 1) state.selSet.add(k);
      state.sel = i;
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selSet.has(i)) state.selSet.delete(i); else state.selSet.add(i);
      state.sel = i;
      state.anchor = i;
    } else {
      state.sel = i;
      state.selSet = new Set([i]);
      state.anchor = i;
    }
    markSel();
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || tr.classList.contains('pending')) return;
    openItem(state.results[Number(tr.dataset.i)]);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement !== q
        && !(document.activeElement && document.activeElement.tagName === 'INPUT')) {
      const items = selectedItems();
      openItem(items[0]);
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
    if (!act) return;
    if (act === 'open') {
      openItem(state.results[state.sel]);
    } else if (act === 'submit') {
      submitToAgent();
    } else if (act === 'newFile' || act === 'newDir') {
      startCreate(act === 'newDir' ? 'dir' : 'file');
    } else if (p) {
      vscode.postMessage({ type: act, path: p });
    }
    ctxMenu.classList.add('hidden');
  });

  // ---------------- actions bar ----------------

  function submitToAgent() {
    const items = selectedItems();
    if (!items.length) { statusEl.textContent = 'Nothing selected'; return; }
    vscode.postMessage({ type: 'submitToAgent', paths: items.map((i) => i.path) });
  }

  function dirForCreate() {
    const items = selectedItems();
    return items.length ? parentDirOf(items[0]) : null;
  }

  function startCreate(kind) {
    const parent = dirForCreate();
    if (!parent) { statusEl.textContent = 'Select a row first (its folder becomes the target)'; return; }
    if (state.pendingCreate) return;
    state.pendingCreate = { kind, parent };
    const tr = document.createElement('tr');
    tr.className = 'pending';
    const icon = document.createElement('td');
    icon.className = 'icon';
    icon.textContent = kind === 'dir' ? '📁' : '📄';
    const td = document.createElement('td');
    td.colSpan = 4;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = kind === 'dir' ? 'New folder name…' : 'New file name…';
    td.appendChild(input);
    tr.appendChild(icon);
    tr.appendChild(td);
    tbody.prepend(tr);
    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (name) {
          vscode.postMessage({ type: 'fsCreate', kind, parent, name });
          statusEl.textContent = `Creating ${kind} « ${name} » in ${parent}…`;
        }
        cancelPending();
      } else if (e.key === 'Escape') {
        cancelPending();
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => { if (state.pendingCreate) cancelPending(); });
  }

  function cancelPending() {
    state.pendingCreate = null;
    const tr = tbody.querySelector('tr.pending');
    if (tr) tr.remove();
  }

  document.getElementById('actExplore').addEventListener('click', () => {
    const items = selectedItems();
    if (items.length) vscode.postMessage({ type: 'openContaining', path: items[0].path });
  });
  document.getElementById('actSubmit').addEventListener('click', submitToAgent);
  document.getElementById('actNewFile').addEventListener('click', () => startCreate('file'));
  document.getElementById('actNewDir').addEventListener('click', () => startCreate('dir'));
  const actPreviewBtn = document.getElementById('actPreview');
  const previewWrap = document.getElementById('previewWrap');
  const previewGrip = document.getElementById('previewGrip');
  const previewBox = document.getElementById('previewBox');
  actPreviewBtn.addEventListener('click', () => {
    state.previewOn = !state.previewOn;
    previewWrap.classList.toggle('hidden', !state.previewOn);
    previewGrip.classList.toggle('hidden', !state.previewOn);
    actPreviewBtn.classList.toggle('on', state.previewOn);
    if (state.previewOn) requestPreview();
  });

  // ---------------- favorites ----------------

  const favList = document.getElementById('favList');
  let favScope = null; // currently applied scope dir

  function populateFavs() {
    const cur = favList.value;
    favList.innerHTML = '<option value="">★ Favorites</option>';
    (persisted.favs || []).forEach((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      favList.appendChild(o);
    });
    favList.value = [...favList.options].some((o) => o.value === cur) ? cur : '';
  }

  function applyFavScope(f) {
    if (favScope && q.value.startsWith(`"${favScope}"`)) {
      q.value = q.value.slice(favScope.length + 2).trim();
    }
    favScope = f || null;
    if (favScope) q.value = `"${favScope}" ` + q.value;
  }

  favList.addEventListener('change', () => {
    applyFavScope(favList.value);
    search();
    q.focus();
  });
  document.getElementById('actFavAdd').addEventListener('click', () => {
    const items = selectedItems();
    const dir = items.length ? parentDirOf(items[0]) : null;
    if (!dir) { statusEl.textContent = 'Select a row to favorite its folder'; return; }
    persisted.favs = persisted.favs || [];
    if (persisted.favs.includes(dir)) { statusEl.textContent = 'Already a favorite'; return; }
    persisted.favs.push(dir);
    persisted.favs.sort((a, b) => a.localeCompare(b));
    persistState();
    populateFavs();
    statusEl.textContent = '★ ' + dir;
  });
  document.getElementById('actFavDel').addEventListener('click', () => {
    const f = favList.value;
    if (!f) { statusEl.textContent = 'Pick a favorite to remove'; return; }
    persisted.favs = (persisted.favs || []).filter((x) => x !== f);
    if (favScope === f) { applyFavScope(''); favList.value = ''; search(); }
    persistState();
    populateFavs();
    statusEl.textContent = 'Removed ' + f;
  });

  // ---------------- preview pane ----------------

  const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg']);
  const TXT_EXT = new Set(['txt', 'md', 'py', 'js', 'ts', 'json', 'css', 'html', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'log', 'csv', 'bat', 'ps1', 'sh', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'toml']);

  function extOf(p) {
    const m = /\.([a-z0-9]+)$/i.exec(p || '');
    return m ? m[1].toLowerCase() : '';
  }

  function requestPreview() {
    const items = selectedItems();
    const it = items[0];
    if (!it) { previewBox.textContent = ''; return; }
    if (it.dir) {
      previewBox.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'meta';
      d.textContent = `📁 ${it.path}`;
      previewBox.appendChild(d);
      return;
    }
    const e = extOf(it.path);
    if (!IMG_EXT.has(e) && !TXT_EXT.has(e)) {
      previewBox.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'meta';
      d.textContent = `No preview for .${e || '?'} — ${it.path}`;
      previewBox.appendChild(d);
      return;
    }
    previewBox.textContent = 'Loading preview…';
    vscode.postMessage({ type: 'preview', path: it.path, ext: e });
  }

  function renderPreview(msg) {
    previewBox.innerHTML = '';
    if (msg.kind === 'image' && msg.data) {
      const img = document.createElement('img');
      img.src = msg.data;
      img.title = msg.path || '';
      previewBox.appendChild(img);
    } else if (msg.kind === 'text' && msg.data != null) {
      const pre = document.createElement('pre');
      pre.textContent = msg.data;
      previewBox.appendChild(pre);
    } else {
      const d = document.createElement('div');
      d.className = 'meta';
      d.textContent = msg.error || `No preview — ${msg.path || ''}`;
      previewBox.appendChild(d);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${msg.path || ''}${msg.size != null ? ' — ' + fmtSize(msg.size) : ''}`;
    previewBox.appendChild(meta);
  }

  // ---------------- column resize ----------------

  const cols = document.querySelectorAll('#results colgroup col');
  const colKeys = ['icon', 'name', 'path', 'size', 'date'];
  const persisted = (vscode.getState && vscode.getState()) || {};
  if (persisted.colW) {
    colKeys.forEach((k, i) => { if (persisted.colW[k] && cols[i]) cols[i].style.width = persisted.colW[k] + 'px'; });
  }
  const resultsWrap = document.getElementById('resultsWrap');
  if (persisted.wrapH) resultsWrap.style.height = persisted.wrapH + 'px';
  if (persisted.prevH) previewWrap.style.height = persisted.prevH + 'px';
  persisted.favs = persisted.favs || [];
  populateFavs();

  function persistState() {
    if (!vscode.setState) return;
    const colW = {};
    colKeys.forEach((k, i) => { if (cols[i].style.width) colW[k] = parseInt(cols[i].style.width, 10); });
    persisted.colW = colW;
    if (resultsWrap.style.height) persisted.wrapH = parseInt(resultsWrap.style.height, 10);
    if (previewWrap.style.height) persisted.prevH = parseInt(previewWrap.style.height, 10);
    vscode.setState(persisted);
  }

  document.querySelectorAll('#results thead th').forEach((th, idx) => {
    th.addEventListener('mousemove', (e) => {
      const r = th.getBoundingClientRect();
      th.classList.toggle('resize-hint', r.right - e.clientX < 6);
    });
    th.addEventListener('mousedown', (e) => {
      const r = th.getBoundingClientRect();
      if (r.right - e.clientX >= 6 || !cols[idx]) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = cols[idx].getBoundingClientRect().width;
      document.body.classList.add('col-resize');
      const mv = (ev) => {
        cols[idx].style.width = Math.max(24, startW + ev.clientX - startX) + 'px';
      };
      const up = () => {
        document.body.classList.remove('col-resize');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        persistState();
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  });

  // ---------------- height grips (results + preview) ----------------

  function heightGrip(gripEl, targetEl, minH, maxH) {
    gripEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = targetEl.getBoundingClientRect().height;
      document.body.classList.add('row-resize');
      const mv = (ev) => {
        const h = Math.min(maxH(), Math.max(minH, startH + ev.clientY - startY));
        targetEl.style.height = h + 'px';
      };
      const up = () => {
        document.body.classList.remove('row-resize');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        persistState();
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }
  heightGrip(document.getElementById('resizeGrip'), resultsWrap, 100, () => window.innerHeight - 140);
  heightGrip(previewGrip, previewWrap, 60, () => window.innerHeight - 120);

  // ---------------- column sorting ----------------

  function clientSort() {
    const key = { name: 'name', path: 'path', size: 'size', date: 'mtime' }[state.sort] || 'name';
    const mul = state.descending ? -1 : 1;
    state.results.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1; // dirs first, always
      const va = a[key], vb = b[key];
      if (typeof va === 'number' || typeof vb === 'number') {
        return mul * ((va || 0) - (vb || 0));
      }
      return mul * String(va || '').localeCompare(String(vb || ''));
    });
    render({ results: state.results, total: state.total });
  }

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
      if (state.mode === 'browse') clientSort(); else search();
    });
  });

  // ---------------- extension -> webview ----------------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.seq != null && msg.seq !== state.seq) return; // stale response
    if (msg.type === 'results' || msg.type === 'browse') {
      if (msg.renderCap) state.renderCap = msg.renderCap;
      render(msg.payload || {});
    } else if (msg.type === 'error') {
      statusEl.textContent = 'Error: ' + msg.message;
    } else if (msg.type === 'preview') {
      if (state.previewOn) renderPreview(msg);
    } else if (msg.type === 'fsCreated') {
      statusEl.textContent = msg.error
        ? 'Create failed: ' + msg.error
        : `Created ${msg.path}`;
      if (!msg.error) search();
    } else if (msg.type === 'status') {
      statusEl.textContent = msg.message || '';
    }
  });

  vscode.postMessage({ type: 'ready' });
  q.focus();
})();
