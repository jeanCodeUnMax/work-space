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

  // ---------------- i18n ----------------

  const STR = {
    en: {
      ph: 'Search everything… (ext:py;txt, size:>10mb, dm:today, folder:)',
      sHint: 'Type to search…', searching: 'Searching…', loading: 'Loading…',
      fAll: 'All', fAudio: 'Audio', fCompressed: 'Compressed', fDoc: 'Document',
      fExe: 'Executable', fFolder: 'Folder', fImage: 'Image', fVideo: 'Video',
      hName: 'Name', hPath: 'Path', hSize: 'Size', hDate: 'Modified',
      mOpen: 'Open', mCopyPath: 'Copy Path', mOpenContaining: 'Open Containing Folder',
      mReveal: 'Reveal in Explorer', mSubmit: 'Submit to Agent',
      mNewFile: 'New File Here', mNewDir: 'New Folder Here',
      tFilter: 'Filter', tExplore: 'Open containing folder in Explorer',
      tSubmit: 'Submit selection to agent (copies paths + opens chat)',
      tNewFile: 'New file in selected folder', tNewDir: 'New folder in selected folder',
      tPreview: 'Toggle preview pane', tFavs: 'Favorites — jump straight in',
      tFavAdd: 'Add selection to favorites', tFavDel: 'Remove selected favorite',
      tGrip: 'Drag to resize', tSettings: 'Settings',
      tBack: 'Back', tFwd: 'Forward', tUp: 'Up', tSearch: 'Back to search',
      sFileOnly: 'Files only — drop folders on the navigation bar',
      favHeader: '★ Favorites',
      sResults: '{n} result{s} in {ms} ms', sShowing: ' — showing {a} of {b} returned',
      sFiltered: ' ({n} filtered by policy)',
      sItems: '{n} item{s} — {p}', sPc: 'PC (drives)',
      sNothing: 'Nothing selected', sSelFav: 'Select a row to favorite',
      sAlreadyFav: 'Already a favorite', sRemoved: 'Removed {p}',
      sCreated: 'Created {p}', sCreateFail: 'Create failed: {e}',
      sCopied: '{n} path(s) copied — paste into agent chat (Ctrl+V)',
      sNoPrev: 'No preview for .{e} — {p}', sPickFav: 'Pick a favorite to remove',
      sNewFilePh: 'New file name…', sNewDirPh: 'New folder name…',
      sSelCreate: 'Select a row first (its folder becomes the target)',
      sLoadingPrev: 'Loading preview…', sFavAdded: '★ {p} added to favorites',
      sSearchTag: '🔍 search', sDrives: '🖥 PC',
    },
    fr: {
      ph: 'Rechercher… (ext:py;txt, size:>10mb, dm:today, folder:)',
      sHint: 'Tapez pour rechercher…', searching: 'Recherche…', loading: 'Chargement…',
      fAll: 'Tout', fAudio: 'Audio', fCompressed: 'Compressé', fDoc: 'Document',
      fExe: 'Exécutable', fFolder: 'Dossier', fImage: 'Image', fVideo: 'Vidéo',
      hName: 'Nom', hPath: 'Chemin', hSize: 'Taille', hDate: 'Modifié',
      mOpen: 'Ouvrir', mCopyPath: 'Copier le chemin', mOpenContaining: 'Ouvrir le dossier parent',
      mReveal: 'Afficher dans l\u2019Explorateur', mSubmit: 'Soumettre à l\u2019agent',
      mNewFile: 'Nouveau fichier ici', mNewDir: 'Nouveau dossier ici',
      tFilter: 'Filtre', tExplore: 'Ouvrir le dossier parent dans l\u2019Explorateur',
      tSubmit: 'Soumettre la sélection à l\u2019agent (copie les chemins + ouvre le chat)',
      tNewFile: 'Nouveau fichier dans le dossier sélectionné',
      tNewDir: 'Nouveau dossier dans le dossier sélectionné',
      tPreview: 'Basculer le panneau d\u2019aperçu', tFavs: 'Favoris — saut direct',
      tFavAdd: 'Ajouter la sélection aux favoris', tFavDel: 'Retirer le favori sélectionné',
      tGrip: 'Glisser pour redimensionner', tSettings: 'Paramètres',
      tBack: 'Précédent', tFwd: 'Suivant', tUp: 'Remonter', tSearch: 'Retour à la recherche',
      sFileOnly: 'Fichiers uniquement — les dossiers vont sur la barre de navigation',
      favHeader: '★ Favoris',
      sResults: '{n} résultat{s} en {ms} ms', sShowing: ' — affichés {a} sur {b}',
      sFiltered: ' ({n} filtrés par la politique)',
      sItems: '{n} élément{s} — {p}', sPc: 'PC (lecteurs)',
      sNothing: 'Aucune sélection', sSelFav: 'Sélectionnez une ligne à mettre en favori',
      sAlreadyFav: 'Déjà en favori', sRemoved: 'Retiré {p}',
      sCreated: 'Créé {p}', sCreateFail: 'Échec de création : {e}',
      sCopied: '{n} chemin(s) copié(s) — collez dans le chat agent (Ctrl+V)',
      sNoPrev: 'Pas d\u2019aperçu pour .{e} — {p}', sPickFav: 'Choisissez un favori à retirer',
      sNewFilePh: 'Nom du nouveau fichier…', sNewDirPh: 'Nom du nouveau dossier…',
      sSelCreate: 'Sélectionnez d\u2019abord une ligne (son dossier devient la cible)',
      sLoadingPrev: 'Chargement de l\u2019aperçu…', sFavAdded: '★ {p} ajouté aux favoris',
      sSearchTag: '🔍 recherche', sDrives: '🖥 PC',
    },
    es: {
      ph: 'Buscar… (ext:py;txt, size:>10mb, dm:today, folder:)',
      sHint: 'Escribe para buscar…', searching: 'Buscando…', loading: 'Cargando…',
      fAll: 'Todo', fAudio: 'Audio', fCompressed: 'Comprimido', fDoc: 'Documento',
      fExe: 'Ejecutable', fFolder: 'Carpeta', fImage: 'Imagen', fVideo: 'Vídeo',
      hName: 'Nombre', hPath: 'Ruta', hSize: 'Tamaño', hDate: 'Modificado',
      mOpen: 'Abrir', mCopyPath: 'Copiar ruta', mOpenContaining: 'Abrir carpeta contenedora',
      mReveal: 'Mostrar en el Explorador', mSubmit: 'Enviar al agente',
      mNewFile: 'Nuevo archivo aquí', mNewDir: 'Nueva carpeta aquí',
      tFilter: 'Filtro', tExplore: 'Abrir carpeta contenedora en el Explorador',
      tSubmit: 'Enviar selección al agente (copia rutas + abre chat)',
      tNewFile: 'Nuevo archivo en la carpeta seleccionada',
      tNewDir: 'Nueva carpeta en la carpeta seleccionada',
      tPreview: 'Alternar panel de vista previa', tFavs: 'Favoritos — salto directo',
      tFavAdd: 'Añadir selección a favoritos', tFavDel: 'Quitar favorito seleccionado',
      tGrip: 'Arrastrar para redimensionar', tSettings: 'Configuración',
      tBack: 'Atrás', tFwd: 'Adelante', tUp: 'Subir', tSearch: 'Volver a búsqueda',
      sFileOnly: 'Solo archivos — las carpetas van en la barra',
      favHeader: '★ Favoritos',
      sResults: '{n} resultado{s} en {ms} ms', sShowing: ' — mostrando {a} de {b}',
      sFiltered: ' ({n} filtrados por política)',
      sItems: '{n} elemento{s} — {p}', sPc: 'PC (unidades)',
      sNothing: 'Nada seleccionado', sSelFav: 'Selecciona una fila para favoritos',
      sAlreadyFav: 'Ya está en favoritos', sRemoved: 'Eliminado {p}',
      sCreated: 'Creado {p}', sCreateFail: 'Error al crear: {e}',
      sCopied: '{n} ruta(s) copiada(s) — pega en el chat del agente (Ctrl+V)',
      sNoPrev: 'Sin vista previa para .{e} — {p}', sPickFav: 'Elige un favorito para quitar',
      sNewFilePh: 'Nombre del nuevo archivo…', sNewDirPh: 'Nombre de la nueva carpeta…',
      sSelCreate: 'Selecciona primero una fila (su carpeta será el destino)',
      sLoadingPrev: 'Cargando vista previa…', sFavAdded: '★ {p} añadido a favoritos',
      sSearchTag: '🔍 búsqueda', sDrives: '🖥 PC',
    },
    de: {
      ph: 'Suchen… (ext:py;txt, size:>10mb, dm:today, folder:)',
      sHint: 'Tippen zum Suchen…', searching: 'Suche…', loading: 'Laden…',
      fAll: 'Alle', fAudio: 'Audio', fCompressed: 'Komprimiert', fDoc: 'Dokument',
      fExe: 'Ausführbar', fFolder: 'Ordner', fImage: 'Bild', fVideo: 'Video',
      hName: 'Name', hPath: 'Pfad', hSize: 'Größe', hDate: 'Geändert',
      mOpen: 'Öffnen', mCopyPath: 'Pfad kopieren', mOpenContaining: 'Übergeordneten Ordner öffnen',
      mReveal: 'Im Explorer anzeigen', mSubmit: 'An Agent senden',
      mNewFile: 'Neue Datei hier', mNewDir: 'Neuer Ordner hier',
      tFilter: 'Filter', tExplore: 'Übergeordneten Ordner im Explorer öffnen',
      tSubmit: 'Auswahl an Agent senden (Pfade kopieren + Chat öffnen)',
      tNewFile: 'Neue Datei im ausgewählten Ordner', tNewDir: 'Neuer Ordner im ausgewählten Ordner',
      tPreview: 'Vorschau ein-/ausblenden', tFavs: 'Favoriten — direkt hinspringen',
      tFavAdd: 'Auswahl zu Favoriten hinzufügen', tFavDel: 'Ausgewählten Favorit entfernen',
      tGrip: 'Zum Anpassen ziehen', tSettings: 'Einstellungen',
      tBack: 'Zurück', tFwd: 'Vorwärts', tUp: 'Nach oben', tSearch: 'Zurück zur Suche',
      sFileOnly: 'Nur Dateien — Ordner in die Leiste ziehen',
      favHeader: '★ Favoriten',
      sResults: '{n} Ergebnis{se} in {ms} ms', sShowing: ' — {a} von {b} angezeigt',
      sFiltered: ' ({n} durch Richtlinie gefiltert)',
      sItems: '{n} Element{e} — {p}', sPc: 'PC (Laufwerke)',
      sNothing: 'Nichts ausgewählt', sSelFav: 'Zeile für Favorit auswählen',
      sAlreadyFav: 'Bereits Favorit', sRemoved: 'Entfernt {p}',
      sCreated: 'Erstellt {p}', sCreateFail: 'Erstellen fehlgeschlagen: {e}',
      sCopied: '{n} Pfad(e) kopiert — in Agent-Chat einfügen (Strg+V)',
      sNoPrev: 'Keine Vorschau für .{e} — {p}', sPickFav: 'Favorit zum Entfernen wählen',
      sNewFilePh: 'Neuer Dateiname…', sNewDirPh: 'Neuer Ordnername…',
      sSelCreate: 'Zuerst eine Zeile wählen (ihr Ordner wird zum Ziel)',
      sLoadingPrev: 'Vorschau wird geladen…', sFavAdded: '★ {p} zu Favoriten hinzugefügt',
      sSearchTag: '🔍 Suche', sDrives: '🖥 PC',
    },
  };
  const LANGS = ['en', 'fr', 'es', 'de'];
  let lang = 'en';

  function t(key, vars) {
    const d = STR[lang] || STR.en;
    let s = d[key] != null ? d[key] : (STR.en[key] != null ? STR.en[key] : key);
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  function pluralS(n, kind) {
    // kind: '' uses {s}, 'e' uses {e} (de: Element->Elemente)
    if (n === 1) return '';
    return kind === 'e' ? 'e' : 's';
  }

  function applyStrings() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    renderCrumbs();
  }

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
    hist: [], // browse history (browser-like back/forward)
    histIdx: -1,
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
    statusEl.textContent = t('searching');
  }

  // ---------------- browse mode (file-browser navigation) ----------------

  function navTo(dir, push) {
    if (push !== false) {
      // browser-like history: truncate forward entries then push
      state.hist = state.hist.slice(0, state.histIdx + 1);
      state.hist.push(dir || '');
      state.histIdx = state.hist.length - 1;
    }
    state.mode = 'browse';
    state.cwd = dir || '';
    state.seq += 1;
    renderCrumbs();
    vscode.postMessage({ type: 'browse', seq: state.seq, path: state.cwd });
    statusEl.textContent = t('loading');
  }

  const crumbsEl = document.getElementById('crumbs');
  const crumbTrail = document.getElementById('crumbTrail');
  const navBack = document.getElementById('navBack');
  const navFwd = document.getElementById('navFwd');
  const navUp = document.getElementById('navUp');

  function renderCrumbs() {
    crumbTrail.innerHTML = '';
    const pc = document.createElement('span');
    pc.className = 'crumb' + (state.mode === 'browse' && !state.cwd ? ' here' : '');
    pc.textContent = t('sDrives');
    pc.title = 'Drives';
    pc.addEventListener('click', () => navTo(''));
    crumbTrail.appendChild(pc);
    if (state.mode === 'search') {
      crumbTrail.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const s = document.createElement('span');
      s.className = 'crumb here';
      s.textContent = t('sSearchTag');
      crumbTrail.appendChild(s);
    } else {
      // browse: split cwd into clickable segments
      const parts = state.cwd.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
      let acc = '';
      parts.forEach((part, i) => {
        acc += part + '\\';
        const target = acc;
        crumbTrail.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
        const c = document.createElement('span');
        c.className = 'crumb' + (i === parts.length - 1 ? ' here' : '');
        c.textContent = part;
        c.title = target;
        c.addEventListener('click', () => navTo(target));
        crumbTrail.appendChild(c);
      });
    }
    // nav buttons enabled state
    navBack.classList.toggle('off', state.histIdx <= 0);
    navFwd.classList.toggle('off', state.histIdx >= state.hist.length - 1);
    navUp.classList.toggle('off', state.mode !== 'browse' || !state.cwd);
    navSearch.classList.toggle('on', state.mode === 'search');
    renderDirChips();
  }

  const navSearch = document.getElementById('navSearch');
  navSearch.addEventListener('click', () => search());

  navBack.addEventListener('click', () => {
    if (state.histIdx > 0) {
      state.histIdx -= 1;
      navTo(state.hist[state.histIdx], false);
    }
  });
  navFwd.addEventListener('click', () => {
    if (state.histIdx < state.hist.length - 1) {
      state.histIdx += 1;
      navTo(state.hist[state.histIdx], false);
    }
  });
  navUp.addEventListener('click', () => {
    if (state.mode === 'browse' && state.cwd) navTo(parentOf(state.cwd));
    else if (state.mode !== 'browse') navTo('');
  });

  // drag & drop a folder/file ONTO the crumbs bar -> quick favorite
  crumbsEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    crumbsEl.classList.add('dropok');
  });
  crumbsEl.addEventListener('dragleave', () => crumbsEl.classList.remove('dropok'));
  crumbsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    crumbsEl.classList.remove('dropok');
    const p = (e.dataTransfer.getData('text/plain') || '').trim();
    if (p) vscode.postMessage({ type: 'statPath', path: p }); // host stats -> fav
  });
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
      s = t('sItems', { n: state.total.toLocaleString(), s: pluralS(state.total), p: state.cwd || t('sPc') });
    } else {
      s = t('sResults', { n: state.total.toLocaleString(), s: pluralS(state.total), ms: payload.elapsed_ms != null ? payload.elapsed_ms : '?' });
      if (rows.length > shown) s += t('sShowing', { a: shown, b: rows.length });
      if (payload.filtered_by_policy) s += t('sFiltered', { n: payload.filtered_by_policy });
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
    if (!items.length) { statusEl.textContent = t('sNothing'); return; }
    vscode.postMessage({ type: 'submitToAgent', paths: items.map((i) => i.path) });
  }

  function dirForCreate() {
    const items = selectedItems();
    return items.length ? parentDirOf(items[0]) : null;
  }

  function startCreate(kind) {
    const parent = dirForCreate();
    if (!parent) { statusEl.textContent = t('sSelCreate'); return; }
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
    input.placeholder = t(kind === 'dir' ? 'sNewDirPh' : 'sNewFilePh');
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
          statusEl.textContent = `${name} — ${parent}`;
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
  const dirFavChips = document.getElementById('dirFavChips');
  // Two favorite stores:
  //   persisted.fileFavs = ["path", ...] -> bottom dropdown, files ONLY
  //   persisted.dirFavs  = ["path", ...] -> chips pinned in the crumbs bar
  // (legacy persisted.favs[{path,dir}] is migrated/split on load)

  function populateFavs() {
    const cur = favList.value;
    favList.innerHTML = `<option value="">${t('favHeader')}</option>`;
    (persisted.fileFavs || []).forEach((p) => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
      o.title = p;
      favList.appendChild(o);
    });
    favList.value = [...favList.options].some((o) => o.value === cur) ? cur : '';
  }

  function renderDirChips() {
    dirFavChips.innerHTML = '';
    (persisted.dirFavs || []).forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = p;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = '📁 ' + (p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p);
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.title = 'Remove';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        persisted.dirFavs = persisted.dirFavs.filter((f) => f !== p);
        persistState();
        renderDirChips();
        statusEl.textContent = t('sRemoved', { p });
      });
      lbl.addEventListener('click', () => navTo(p));
      chip.appendChild(lbl);
      chip.appendChild(x);
      dirFavChips.appendChild(chip);
    });
  }

  favList.addEventListener('change', () => {
    const p = favList.value;
    if (p) vscode.postMessage({ type: 'open', path: p, dir: false });
    q.focus();
  });

  function addFavorite(path, dir) {
    const store = dir ? 'dirFavs' : 'fileFavs';
    persisted[store] = persisted[store] || [];
    if (persisted[store].includes(path)) {
      statusEl.textContent = t('sAlreadyFav');
      return;
    }
    persisted[store].push(path);
    persisted[store].sort((a, b) => a.localeCompare(b));
    persistState();
    populateFavs();
    renderDirChips();
    statusEl.textContent = t('sFavAdded', { p: path });
  }

  document.getElementById('actFavAdd').addEventListener('click', () => {
    const it = selectedItems()[0];
    if (!it) { statusEl.textContent = t('sSelFav'); return; }
    if (it.dir) { statusEl.textContent = t('sFileOnly'); return; } // files only below
    addFavorite(it.path, false);
  });
  document.getElementById('actFavDel').addEventListener('click', () => {
    const f = favList.value;
    if (!f) { statusEl.textContent = t('sPickFav'); return; }
    persisted.fileFavs = (persisted.fileFavs || []).filter((x) => x !== f);
    persistState();
    populateFavs();
    statusEl.textContent = t('sRemoved', { p: f });
  });

  // ---------------- settings gear ----------------

  const settingsMenu = document.getElementById('settingsMenu');
  document.getElementById('actSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    settingsMenu.querySelectorAll('.item').forEach((el) =>
      el.classList.toggle('on', el.dataset.lang === lang));
    const r = e.target.getBoundingClientRect();
    settingsMenu.classList.toggle('hidden');
    settingsMenu.style.left = Math.max(4, r.right - 140) + 'px';
    settingsMenu.style.top = (r.bottom + 4) + 'px';
  });
  settingsMenu.addEventListener('click', (e) => {
    const l = e.target.dataset.lang;
    if (!l || !LANGS.includes(l)) return;
    lang = l;
    persisted.lang = lang;
    persistState();
    applyStrings();
    settingsMenu.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!settingsMenu.contains(e.target) && e.target.id !== 'actSettings') {
      settingsMenu.classList.add('hidden');
    }
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
      d.textContent = t('sNoPrev', { e: e || '?', p: it.path });
      previewBox.appendChild(d);
      return;
    }
    previewBox.textContent = t('sLoadingPrev');
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
  // migrate legacy favorites: strings -> dir chips; {path,dir} -> split
  persisted.fileFavs = persisted.fileFavs || [];
  persisted.dirFavs = persisted.dirFavs || [];
  (persisted.favs || []).forEach((f) => {
    const it = typeof f === 'string' ? { path: f, dir: true } : f;
    const store = it.dir ? persisted.dirFavs : persisted.fileFavs;
    if (!store.includes(it.path)) store.push(it.path);
  });
  delete persisted.favs;
  populateFavs();
  renderDirChips();
  // language: persisted > browser locale > en
  if (persisted.lang && LANGS.includes(persisted.lang)) lang = persisted.lang;
  else {
    const bl = (navigator.language || 'en').slice(0, 2);
    lang = LANGS.includes(bl) ? bl : 'en';
    persisted.lang = lang;
  }
  applyStrings();

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
        ? t('sCreateFail', { e: msg.error })
        : t('sCreated', { p: msg.path });
      if (!msg.error) search();
    } else if (msg.type === 'stat') {
      if (msg.path) addFavorite(msg.path, msg.dir);
    } else if (msg.type === 'status') {
      statusEl.textContent = msg.message || '';
    }
  });

  vscode.postMessage({ type: 'ready' });
  q.focus();
})();
