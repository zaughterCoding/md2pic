// UI controller: note loading, range selection, preview, export.
(function () {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const EXPORT = params.get('export') === '1';
  const THUMB_SCALE = 0.34;
  const t = I18N.t;
  let statusMsg = { key: 'status.empty' };
  let exportMsg = null; // { key, params, dir }

  let config = null;
  let note = null;
  let range = null; // { s, e } heading indices
  let result = null; // { pages, G }
  let exclude = new Set();
  let layoutToken = 0;

  async function api(url, body) {
    const r = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code, detail: j.detail });
    return j;
  }

  // ---------- range ----------
  function resolveRange(saved) {
    const hs = note.headings;
    if (!hs.length) return null;
    const find = (ref) => {
      if (!ref) return -1;
      if (hs[ref.idx] && hs[ref.idx].text === ref.text) return ref.idx;
      const i = hs.findIndex((h) => h.text === ref.text);
      return i;
    };
    let s = saved ? find(saved.start) : -1;
    let e = saved ? find(saved.end) : -1;
    if (s < 0) s = 0;
    if (e < 0 || e < s) e = hs.length - 1;
    return { s, e };
  }

  function selectedAtoms() {
    const atoms = note.atoms;
    const hs = note.headings;
    if (!hs.length || !range) return atoms;
    const from = range.s === 0 ? 0 : hs[range.s].atom;
    const endH = hs[range.e];
    const nxt = hs.find((h) => h.idx > endH.idx && h.level <= endH.level);
    const to = nxt ? nxt.atom : atoms.length;
    return atoms.slice(from, to);
  }

  function inRangeSet() {
    const set = new Set();
    if (!range) return set;
    const hs = note.headings;
    const endH = hs[range.e];
    const nxt = hs.find((h) => h.idx > endH.idx && h.level <= endH.level);
    const last = nxt ? nxt.idx - 1 : hs.length - 1;
    for (let i = range.s; i <= last; i++) set.add(i);
    return set;
  }

  function saveRange() {
    const hs = note.headings;
    const r = range ? { start: { idx: range.s, text: hs[range.s].text }, end: { idx: range.e, text: hs[range.e].text } } : null;
    return api('/api/config', { range: r });
  }

  // ---------- outline ----------
  function renderOutline() {
    const box = $('#outline');
    box.innerHTML = '';
    if (!note) return;
    if (!note.headings.length) { box.innerHTML = `<div class="hint">${t('range.noHeadings')}</div>`; return; }
    const sel = inRangeSet();
    note.headings.forEach((h) => {
      const row = document.createElement('div');
      row.className = `oi l${h.level}` + (sel.has(h.idx) ? ' in' : '') + (range && (h.idx === range.s || h.idx === range.e) ? ' edge' : '');
      row.style.paddingLeft = 4 + (h.level - 1) * 14 + 'px';
      const bs = document.createElement('button');
      bs.textContent = t('range.from');
      if (range && range.s === h.idx) bs.className = 'on';
      bs.onclick = () => { range = { s: h.idx, e: Math.max(h.idx, range ? range.e : h.idx) }; onRangeChange(); };
      const be = document.createElement('button');
      be.textContent = t('range.to');
      if (range && range.e === h.idx) be.className = 'on';
      be.onclick = () => { range = { s: Math.min(h.idx, range ? range.s : h.idx), e: h.idx }; onRangeChange(); };
      const lv = document.createElement('span');
      lv.className = 'lv';
      lv.textContent = 'H' + h.level;
      const txt = document.createElement('span');
      txt.className = 't';
      txt.textContent = h.text;
      txt.title = h.text;
      row.append(bs, be, lv, txt);
      box.appendChild(row);
    });
    const hs = note.headings;
    $('#rangeInfo').textContent = range ? `${hs[range.s].text} → ${hs[range.e].text}` : '';
  }

  function onRangeChange() {
    renderOutline();
    saveRange();
    scheduleLayout();
  }

  // ---------- settings ----------
  function readSettings() {
    return {
      pageSize: document.querySelector('input[name=size]:checked').value,
      columns: Number(document.querySelector('input[name=cols]:checked').value),
      scale: Number(document.querySelector('input[name=scale]:checked').value),
      fontSize: Math.min(40, Math.max(8, Number($('#fontSize').value) || 26)),
      signature: $('#signature').value,
      lang: I18N.lang,
    };
  }
  function fillSettings(s) {
    document.querySelectorAll('input[name=cols]').forEach((r) => { r.checked = Number(r.value) === Number(s.columns); });
    document.querySelectorAll('input[name=size]').forEach((r) => { r.checked = r.value === s.pageSize; });
    document.querySelectorAll('input[name=scale]').forEach((r) => { r.checked = Number(r.value) === Number(s.scale); });
    $('#fontSize').value = s.fontSize;
    $('#signature').value = s.signature;
  }
  let settingsTimer;
  function onSettingsChange() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      config.settings = readSettings();
      await api('/api/config', { settings: config.settings });
      scheduleLayout();
    }, 300);
  }

  // ---------- layout & preview ----------
  let layoutTimer;
  function scheduleLayout() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(runLayout, 50);
  }

  async function runLayout() {
    if (!note) return;
    const token = ++layoutToken;
    setStatus('status.layout');
    const t0 = performance.now();
    try {
      const r = await MD2PIC.layout(selectedAtoms(), config.settings);
      if (token !== layoutToken) return;
      result = r;
      exclude = new Set();
      renderPreview();
      setStatus('status.ok', { n: r.pages.length, W: r.G.W, H: r.G.H, c: r.G.n, fs: r.G.fs, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(e);
      setStatus('status.failed', { msg: e.message });
    }
  }

  function setStatus(key, params) {
    statusMsg = { key, params };
    $('#status').textContent = t(key, params);
  }

  function numbering() {
    const keep = result.pages.map((_, i) => i).filter((i) => !exclude.has(i));
    const map = new Map(keep.map((i, k) => [i, k + 1]));
    return { map, total: keep.length };
  }

  function renderPreview() {
    const box = $('#pages');
    box.innerHTML = '';
    const { map, total } = numbering();
    const scale = THUMB_SCALE * 1440 / Math.max(result.G.W, result.G.H);
    result.pages.forEach((p, i) => {
      const off = exclude.has(i);
      const pageEl = MD2PIC.renderPage(p, result.G, off ? '–' : map.get(i), total, config.settings);
      pageEl.style.transform = `scale(${scale})`;
      const th = document.createElement('div');
      th.className = 'thumb' + (off ? ' off' : '');
      th.dataset.off = t('thumb.excluded');
      th.style.width = result.G.W * scale + 'px';
      th.style.height = result.G.H * scale + 'px';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const lab = document.createElement('span');
      lab.textContent = `#${i + 1} ${p.title || ''}`.slice(0, 22);
      const btn = document.createElement('button');
      btn.textContent = off ? t('thumb.restore') : t('thumb.exclude');
      btn.onclick = (ev) => {
        ev.stopPropagation();
        off ? exclude.delete(i) : exclude.add(i);
        renderPreview();
      };
      bar.append(lab, btn);
      th.append(pageEl, bar);
      th.onclick = () => openLightbox(i);
      box.appendChild(th);
    });
  }

  function openLightbox(i) {
    const { map, total } = numbering();
    const { W, H } = result.G;
    const s = Math.min((window.innerHeight - 40) / H, (window.innerWidth - 40) / W);
    const el = MD2PIC.renderPage(result.pages[i], result.G, exclude.has(i) ? '–' : map.get(i), total, config.settings);
    el.style.transform = `scale(${s})`;
    const inner = $('#lbInner');
    inner.innerHTML = '';
    inner.style.width = W * s + 'px';
    inner.style.height = H * s + 'px';
    inner.appendChild(el);
    $('#lightbox').hidden = false;
  }

  // ---------- note ----------
  async function loadNote(path) {
    try {
      const j = path ? await api('/api/note', { path }) : await api('/api/note');
      if (j.code) $('#noteInfo').textContent = I18N.errorText(j);
      if (!j.note) return;
      note = j.note;
      config = await api('/api/config');
      $('#notePath').value = note.path;
      showNoteInfo();
      range = resolveRange(config.range);
      renderOutline();
      scheduleLayout();
    } catch (e) {
      $('#noteInfo').textContent = I18N.errorText(e);
    }
  }

  function showNoteInfo() {
    if (note) $('#noteInfo').textContent = t('note.info', { name: note.name, h: note.headings.length, a: note.atoms.length });
  }

  // Open the OS file dialog (via the server) and load the chosen note.
  async function pickNote() {
    const btn = $('#pickBtn');
    btn.disabled = true;
    const before = $('#noteInfo').textContent;
    $('#noteInfo').textContent = t('note.picking');
    try {
      const r = await api('/api/pick', { title: t('note.pickTitle') });
      if (r.path) {
        $('#notePath').value = r.path;
        await loadNote(r.path);
      } else {
        $('#noteInfo').textContent = before; // cancelled
      }
    } catch (e) {
      $('#noteInfo').textContent = I18N.errorText(e);
    } finally {
      btn.disabled = false;
    }
  }

  async function doExport() {
    if (!result) return;
    const btn = $('#exportBtn');
    btn.disabled = true;
    showExport({ key: 'export.running' });
    try {
      clearTimeout(settingsTimer);
      config.settings = readSettings();
      await api('/api/config', { settings: config.settings });
      await saveRange();
      const r = await api('/api/export', { exclude: [...exclude] });
      showExport({ key: 'export.done', params: { n: r.files.length, dir: r.dir }, dir: r.dir });
    } catch (e) {
      showExport({ key: 'export.failed', params: { msg: I18N.errorText(e) } });
    } finally {
      btn.disabled = false;
    }
  }

  function showExport(m) {
    exportMsg = m;
    const box = $('#exportInfo');
    box.innerHTML = '';
    if (!m) return;
    const msg = document.createElement('div');
    msg.textContent = t(m.key, m.params);
    box.appendChild(msg);
    if (m.dir) {
      const open = document.createElement('button');
      open.className = 'ghost';
      open.textContent = t('export.open');
      open.onclick = () => api('/api/open-dir', { dir: m.dir });
      box.appendChild(open);
    }
  }

  // Re-render every piece of text after a language switch.
  function applyLang() {
    I18N.apply();
    $('#status').textContent = t(statusMsg.key, statusMsg.params);
    showNoteInfo();
    showExport(exportMsg);
    renderOutline();
    if (result) renderPreview();
  }

  // ---------- export mode (driven by headless browser) ----------
  async function exportMode() {
    document.body.classList.add('export');
    try {
      config = await api('/api/config');
      I18N.lang = config.settings.lang;
      const j = await api('/api/note');
      if (!j.note) throw new Error(I18N.errorText(j.code ? j : { code: 'NO_NOTE' }));
      note = j.note;
      range = resolveRange(config.range);
      const r = await MD2PIC.layout(selectedAtoms(), config.settings);
      const ex = new Set((params.get('exclude') || '').split(',').filter(Boolean).map(Number));
      const keep = r.pages.filter((_, i) => !ex.has(i));
      const root = $('#exportRoot');
      keep.forEach((p, k) => root.appendChild(MD2PIC.renderPage(p, r.G, k + 1, keep.length, config.settings)));
      await MD2PIC.waitImages(root);
      window.__layoutDone = true;
    } catch (e) {
      window.__layoutError = String(e.message || e);
    }
  }

  async function init() {
    if (EXPORT) return exportMode();
    config = await api('/api/config');
    I18N.lang = config.settings.lang;
    I18N.apply();
    fillSettings(config.settings);
    $('#langBtn').onclick = async () => {
      I18N.lang = I18N.lang === 'zh' ? 'en' : 'zh';
      config.settings.lang = I18N.lang;
      applyLang();
      await api('/api/config', { settings: { lang: I18N.lang } });
      scheduleLayout(); // "continued" labels on pages follow the language
    };
    $('#loadBtn').onclick = () => loadNote($('#notePath').value);
    $('#pickBtn').onclick = pickNote;
    $('#notePath').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadNote($('#notePath').value); });
    document.querySelectorAll('input[name=cols], input[name=size], input[name=scale]').forEach((r) => r.addEventListener('change', onSettingsChange));
    $('#fontSize').addEventListener('input', onSettingsChange);
    $('#signature').addEventListener('input', onSettingsChange);
    $('#allBtn').onclick = () => { if (note && note.headings.length) { range = { s: 0, e: note.headings.length - 1 }; onRangeChange(); } };
    $('#exportBtn').onclick = doExport;
    $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });
    if (config.notePath) {
      $('#notePath').value = config.notePath;
      await loadNote();
    }
  }

  init();
})();
