// Layout engine: measures markdown atoms and flows them into fixed-size multi-column pages.
(function () {
  // Page presets: [width, height]
  const SIZES = { portrait: [1080, 1440], landscape: [1440, 1080], wide: [1920, 1080] };
  const PAD_X = 68;
  const TOP = 80;
  const BOTTOM = 130; // space reserved for the footer

  let mermaidReady = false;
  const mermaidCache = new Map();
  let mermaidSeq = 0;
  let curFs = 26;

  function geometry(settings) {
    const [W, H] = SIZES[settings.pageSize] || SIZES.landscape;
    const n = Math.min(4, Math.max(2, Number(settings.columns) || 3));
    const fs = Number(settings.fontSize) || 26;
    const gap = { 2: 56, 3: 46, 4: 40 }[n];
    const colW = Math.floor((W - PAD_X * 2 - gap * (n - 1)) / n);
    return { W, H, n, fs, gap, colW, colH: H - TOP - BOTTOM };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function atomHtml(a) {
    if (a.html != null) return a.html; // server-rendered html already includes its wrappers
    return (a.pre || '') + innerHtml(a) + (a.post || '');
  }
  function innerHtml(a) {
    switch (a.type) {
      case 'code': {
        const lang = a.lang && !a.cont ? `<span class="lang">${esc(a.lang)}</span>` : '';
        return `<pre>${lang}<code class="hljs">${a.lines.join('\n') || ' '}</code></pre>`;
      }
      case 'table':
        return `<table>${a.head}<tbody>${a.rows.join('')}</tbody></table>`;
      case 'tcards':
        return `<div class="tcards">${a.rows.join('')}</div>`;
      case 'mermaid': {
        // Scale diagrams so their labels roughly match body text, capped at column width.
        const k = curFs / 20;
        const svg = (mermaidCache.get(a.code) || '').replace(/max-width:\s*([\d.]+)px;?/, (_, w) => `max-width: min(100%, ${Math.round(w * k)}px);`);
        return `<div class="mermaid-box">${svg}</div>`;
      }
      case 'label':
        return `<div class="cont-label">${esc(a.text)}</div>`;
      default:
        return a.html; // already wrapped by the server
    }
  }

  async function renderMermaid(atoms) {
    const todo = atoms.filter((a) => a.type === 'mermaid' && !mermaidCache.has(a.code));
    if (!todo.length) return;
    if (!mermaidReady) {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
        fontFamily: '"Microsoft YaHei UI","Microsoft YaHei",sans-serif',
        themeVariables: {
          background: '#F4EEE1',
          primaryColor: '#EFE3CC',
          primaryBorderColor: '#A0673A',
          primaryTextColor: '#3A332A',
          secondaryColor: '#E6EEDC',
          tertiaryColor: '#F7F1E6',
          lineColor: '#8A7259',
          textColor: '#3A332A',
          noteBkgColor: '#F7EBD3',
          noteBorderColor: '#C9A77F',
          fontSize: '16px',
        },
      });
      mermaidReady = true;
    }
    for (const a of todo) {
      try {
        const { svg } = await window.mermaid.render('mmd' + ++mermaidSeq, a.code);
        mermaidCache.set(a.code, svg);
      } catch (e) {
        mermaidCache.set(a.code, `<div class="mermaid-err">Mermaid 渲染失败：${esc(e.message || e)}</div>`);
        document.querySelectorAll('[id^="dmmd"]').forEach((el) => el.remove());
      }
    }
  }

  async function waitImages(root) {
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  }

  // ---------- measurement ----------
  function setupMeasure(G) {
    const box = document.getElementById('measure');
    box.style.width = G.colW + 'px';
    box.style.fontSize = G.fs + 'px';
    box.style.setProperty('--colH', G.colH + 'px');
    box.innerHTML = '';
    return box;
  }
  function measureOne(box, a) {
    const d = document.createElement('div');
    d.className = 'atom';
    d.innerHTML = atomHtml(a);
    box.appendChild(d);
    const h = Math.ceil(d.getBoundingClientRect().height);
    d.remove();
    return h;
  }

  // Split atoms that are taller than a whole column: lists/quotes into their inner blocks,
  // code by lines, tables by rows (header repeated). Recurses until every piece fits.
  function splitOversize(box, a, G) {
    if (a.h <= G.colH) return [a];
    if (a.parts && a.parts.length) {
      const out = [];
      for (const p of a.parts) {
        const piece = { ...p };
        piece.h = measureOne(box, piece);
        out.push(...splitOversize(box, piece, G));
      }
      return out;
    }
    let key, make;
    if (a.type === 'code' && a.lines.length > 1) {
      key = 'lines';
      make = (part, i) => ({ ...a, lines: part, cont: i > 0 });
    } else if ((a.type === 'table' || a.type === 'tcards') && a.rows.length > 1) {
      key = 'rows';
      make = (part) => ({ ...a, rows: part });
    } else if (a.type === 'table') {
      const c = toCards(a);
      c.h = measureOne(box, c);
      return splitOversize(box, c, G);
    } else if (a.type === 'tcards') {
      return splitUnits(box, a, G, cardUnits(a));
    } else if (a.type === 'p' && a.html != null) {
      return splitUnits(box, a, G, textUnits(a));
    } else return [a];

    const items = a[key];
    const out = [];
    let start = 0;
    while (start < items.length) {
      let lo = start + 1, hi = items.length, best = start + 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const h = measureOne(box, make(items.slice(start, mid), out.length));
        if (h <= G.colH) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const piece = make(items.slice(start, best), out.length);
      piece.h = measureOne(box, piece);
      // A single table row still taller than a column: switch the whole table to cards.
      if (piece.h > G.colH && a.type === 'table') {
        const c = toCards(a);
        c.h = measureOne(box, c);
        return splitOversize(box, c, G);
      }
      if (piece.h > G.colH && a.type === 'tcards') { out.push(...splitOversize(box, piece, G)); start = best; continue; }
      out.push(piece);
      start = best;
    }
    return out;
  }

  // ---------- tables that are too wide for a column become "cards" ----------
  const MIN_CELL_EM = 3.5;
  function tableTooNarrow(nCols, G) {
    return nCols * MIN_CELL_EM * G.fs > G.colW;
  }
  function cellsOf(rowHtml, cellTag) {
    const t = document.createElement('template');
    t.innerHTML = `<table>${rowHtml}</table>`;
    return [...t.content.querySelectorAll(cellTag)].map((c) => c.innerHTML.trim());
  }
  function cardHtml(heads, cells) {
    const title = `<div class="tc-title">${heads[0] ? `<span class="k">${heads[0]}</span>` : ''}${cells[0] || ''}</div>`;
    const kv = cells.slice(1).map((c, i) => c ? `<div class="kv"><span class="k">${heads[i + 1] || ''}</span><span class="v">${c}</span></div>` : '').join('');
    return `<div class="tcard">${title}${kv}</div>`;
  }
  function toCards(a) {
    const heads = cellsOf(a.head, 'th');
    const rows = a.rows.map((r) => cardHtml(heads, cellsOf(r, 'td')));
    return { ...a, type: 'tcards', rows, head: undefined };
  }
  // Replace too-narrow tables embedded in server-rendered html (e.g. inside list items).
  function cardifyHtml(html, G) {
    if (!html || html.indexOf('<table') < 0) return html;
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll('table').forEach((tb) => {
      const heads = [...tb.querySelectorAll('thead th')].map((c) => c.innerHTML.trim());
      if (!tableTooNarrow(heads.length, G)) return;
      const div = document.createElement('div');
      div.className = 'tcards';
      div.innerHTML = [...tb.querySelectorAll('tbody tr')].map((tr) => cardHtml(heads, [...tr.children].map((c) => c.innerHTML.trim()))).join('');
      tb.replaceWith(div);
    });
    return t.innerHTML;
  }
  function prep(a, G) {
    let b = { ...a };
    if (b.type === 'table' && tableTooNarrow(cellsOf(b.head, 'th').length, G)) b = toCards(b);
    if (b.html) b.html = cardifyHtml(b.html, G);
    if (b.parts) b.parts = b.parts.map((p) => prep(p, G));
    return b;
  }

  // ---------- last-resort splitting of a single block into smaller units ----------
  // Returns { units, build(unitsSlice, isFirst) => atom } or null.
  function textUnits(a) {
    const pre = a.pre || '', post = a.post || '';
    const inner = a.html.slice(pre.length, a.html.length - post.length).trim();
    const t = document.createElement('template');
    t.innerHTML = inner;
    let container = t.content, open = '', close = '';
    const only = t.content.childNodes.length === 1 ? t.content.firstChild : null;
    if (only && only.nodeType === 1 && only.tagName === 'P') { container = only; open = '<p>'; close = '</p>'; }
    const units = [];
    for (const n of container.childNodes) {
      if (n.nodeType === 3) n.textContent.split(/(?<=[。！？；!?;])/).forEach((s) => s && units.push(esc(s)));
      else if (n.nodeType === 1) units.push(n.outerHTML);
    }
    // Later pieces continue the same list item without repeating its bullet/number.
    const contPre = pre.endsWith('<li>') ? pre.slice(0, -4) + '<li class="cont">' : pre;
    return {
      units,
      build: (u, first) => {
        const p = first ? pre : contPre;
        return { ...a, pre: p, html: p + open + u.join('') + close + post, parts: undefined };
      },
    };
  }
  function cardUnits(a) {
    if (a.rows.length !== 1) return null;
    const t = document.createElement('template');
    t.innerHTML = a.rows[0];
    const units = [...t.content.firstElementChild.children].map((c) => c.outerHTML);
    return { units, build: (u) => ({ ...a, rows: [`<div class="tcard">${u.join('')}</div>`] }) };
  }
  function splitUnits(box, a, G, spec) {
    if (!spec || spec.units.length < 2) return [a];
    const { units, build } = spec;
    const out = [];
    let start = 0;
    while (start < units.length) {
      let lo = start + 1, hi = units.length, best = start + 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (measureOne(box, build(units.slice(start, mid), start === 0)) <= G.colH) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const piece = build(units.slice(start, best), start === 0);
      piece.h = measureOne(box, piece);
      out.push(piece);
      start = best;
    }
    return out;
  }

  async function measureAtoms(atoms, G) {
    atoms = atoms.map((a) => prep(a, G));
    await renderMermaid(atoms);
    const box = setupMeasure(G);
    const els = atoms.map((a) => {
      const d = document.createElement('div');
      d.className = 'atom';
      d.innerHTML = atomHtml(a);
      box.appendChild(d);
      return d;
    });
    await waitImages(box);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    atoms.forEach((a, i) => { a.h = Math.ceil(els[i].getBoundingClientRect().height); });
    box.innerHTML = '';
    // Measure every inner part (lists / quotes) in one batch so they can fill column bottoms.
    const all = [];
    (function collect(list) { for (const a of list) if (a.parts) { a.parts = a.parts.map((p) => ({ ...p })); all.push(...a.parts); collect(a.parts); } })(atoms);
    const pels = all.map((p) => {
      const d = document.createElement('div');
      d.className = 'atom';
      d.innerHTML = atomHtml(p);
      box.appendChild(d);
      return d;
    });
    all.forEach((p, i) => { p.h = Math.ceil(pels[i].getBoundingClientRect().height); });
    box.innerHTML = '';
    const out = [];
    for (const a of atoms) out.push(...splitOversize(box, a, G));
    return { atoms: out, box };
  }

  // ---------- splitting at a column bottom (to use leftover space) ----------
  // List items / quotes break between their inner blocks; code breaks between lines
  // (at least 2 lines on each side); tables break between rows (rows never split, header repeats).
  let curBox = null;
  function seqKey(a) {
    if (a.type === 'code') return 'lines';
    if (a.type === 'table' || a.type === 'tcards') return 'rows';
    return null;
  }
  function makePiece(a, items, first) {
    const key = seqKey(a);
    const p = { ...a, [key]: items, _ph: undefined };
    if (key === 'lines') p.cont = a.cont || !first;
    return p;
  }
  function prefixH(a, k) {
    if (!a._ph) a._ph = [];
    if (a._ph[k] == null) a._ph[k] = measureOne(curBox, makePiece(a, a[seqKey(a)].slice(0, k), true));
    return a._ph[k];
  }
  function minParts(a) { return a.type === 'code' ? 2 : 1; }
  // Largest prefix length that fits in `avail`, or 0 if the atom can't be split there.
  function splitPoint(a, avail) {
    const key = seqKey(a);
    if (!key) return 0;
    const n = a[key].length, m = minParts(a);
    if (n < 2 * m) return 0;
    let lo = m, hi = n - m, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prefixH(a, mid) <= avail) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }
  // Smallest leading chunk of `a` that could start a column (used for heading look-ahead).
  function minLead(a) {
    if (a.parts && a.parts.length) return minLead(a.parts[0]);
    const key = seqKey(a);
    if (key && a[key].length >= 2 * minParts(a)) return prefixH(a, minParts(a));
    return a.h;
  }
  // Can some leading part of `a` go into `avail`?
  function canStart(a, avail) {
    if (a.h <= avail) return true;
    if (a.parts && a.parts.length) return canStart(a.parts[0], avail);
    return splitPoint(a, avail) > 0;
  }

  // ---------- flow ----------
  function makeGap(G) {
    const fs = G.fs;
    const hGap = [0, 1.5, 1.3, 1.05, 0.85, 0.8, 0.8];
    return (prev, a) => {
      if (!prev) return 0;
      if (a.type === 'heading') return Math.round(hGap[a.level] * fs);
      if (prev.type === 'heading') return Math.round(0.55 * fs);
      if (prev.type === 'label') return Math.round(0.45 * fs);
      if (a.group && prev.group === a.group) return Math.round(0.3 * fs);
      return Math.round(0.8 * fs);
    };
  }

  class Flow {
    constructor(G, gap, labelFor, sim) {
      Object.assign(this, { G, gap, labelFor, sim });
      this.pages = [];
      this.pageCount = 0;
      this.c = 0;
      this.y = 0;
      this.prev = null;
    }
    clone() {
      const f = new Flow(this.G, this.gap, this.labelFor, true);
      Object.assign(f, { pageCount: this.pageCount, c: this.c, y: this.y, prev: this.prev });
      return f;
    }
    newPage() {
      this.pageCount++;
      if (!this.sim) this.pages.push({ cols: Array.from({ length: this.G.n }, () => []) });
      this.c = 0; this.y = 0; this.prev = null;
    }
    nextCol() {
      this.c++; this.y = 0; this.prev = null;
      if (this.c >= this.G.n) this.newPage();
    }
    blank() {
      if (!this.pageCount) return 0;
      return (this.G.colH - this.y) + (this.G.n - 1 - this.c) * this.G.colH;
    }
    put(a) {
      const g = this.gap(this.prev, a);
      if (!this.sim) this.pages[this.pages.length - 1].cols[this.c].push({ a, y: this.y + g });
      this.y += g + a.h;
      this.prev = a;
    }
    // `ahead` lists the atoms that follow `a` (used to keep headings with their content).
    place(a, ahead = []) {
      const { colH } = this.G;
      if (!this.pageCount) this.newPage();
      let need = a.h;
      // Never leave a heading (or a chain of headings) alone at the bottom of a column.
      if (a.type === 'heading') {
        let prev = a;
        for (const b of ahead) {
          need += this.gap(prev, b) + (b.type === 'heading' ? b.h : minLead(b));
          if (b.type !== 'heading') break;
          prev = b;
        }
      }
      if (this.y > 0 && this.y + this.gap(this.prev, a) + need > colH) {
        const avail = colH - this.y - this.gap(this.prev, a);
        if (a.type !== 'heading' && canStart(a, avail)) {
          // Fill the rest of this column with the leading part of `a`.
          if (a.parts && a.parts.length) {
            a.parts.forEach((p, i) => this.place(p, a.parts.slice(i + 1, i + 8).concat(ahead)));
            return;
          }
          const k = splitPoint(a, avail);
          const items = a[seqKey(a)];
          const head = makePiece(a, items.slice(0, k), true);
          head.h = prefixH(a, k);
          const tail = makePiece(a, items.slice(k), false);
          tail.h = measureOne(curBox, tail);
          this.put(head);
          this.place(tail, ahead);
          return;
        }
        this.nextCol();
      }
      // A page that starts in the middle of a section gets a "continued" label.
      if (this.pageCount > 1 && this.c === 0 && this.y === 0 && a.type !== 'heading' && a.section) {
        const label = this.labelFor(a.section);
        if (label.h + this.gap(label, a) + a.h <= colH) this.put(label);
      }
      this.put(a);
    }
  }

  function buildTree(atoms) {
    const root = { heading: null, level: 0, intro: [], children: [] };
    const stack = [root];
    for (const a of atoms) {
      if (a.type === 'heading' && a.level <= 4) {
        while (stack[stack.length - 1].level >= a.level) stack.pop();
        const node = { heading: a, level: a.level, intro: [], children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      } else {
        stack[stack.length - 1].intro.push(a);
      }
    }
    return root;
  }

  function seqOf(node) {
    const out = [];
    (function walk(n) {
      if (n.heading) out.push(n.heading);
      out.push(...n.intro);
      n.children.forEach(walk);
    })(node);
    return out;
  }

  function flowSeq(fl, seq, after = []) {
    for (let i = 0; i < seq.length; i++) fl.place(seq[i], seq.slice(i + 1, i + 8).concat(after));
  }

  // Keep a whole section on one page when possible; otherwise split it at sub-headings,
  // and as a last resort flow its content to fill pages.
  function placeNode(fl, node, G) {
    const seq = seqOf(node);
    if (!seq.length) return;
    const sim = fl.clone();
    flowSeq(sim, seq);
    if (sim.pageCount === Math.max(fl.pageCount, 1)) { flowSeq(fl, seq); return; }

    const empty = new Flow(G, fl.gap, fl.labelFor, true);
    flowSeq(empty, seq);
    if (empty.pageCount === 1 && fl.blank() <= G.colH) {
      fl.newPage();
      flowSeq(fl, seq);
      return;
    }
    const own = [node.heading, ...node.intro].filter(Boolean);
    const firstChild = node.children.length ? seqOf(node.children[0]).slice(0, 8) : [];
    flowSeq(fl, own, firstChild);
    node.children.forEach((ch) => placeNode(fl, ch, G));
  }

  async function layout(srcAtoms, settings) {
    const G = geometry(settings);
    curFs = G.fs;
    const copies = srcAtoms.map((a) => ({ ...a }));
    const { atoms, box } = await measureAtoms(copies, G);
    curBox = box;
    const gap = makeGap(G);
    const labels = new Map();
    const labelFor = (section) => {
      if (!labels.has(section)) {
        const l = { type: 'label', text: section + I18N.t('page.cont') };
        l.h = measureOne(box, l);
        labels.set(section, l);
      }
      return labels.get(section);
    };
    const fl = new Flow(G, gap, labelFor, false);
    placeNode(fl, buildTree(atoms), G);
    fl.pages.forEach((p) => {
      const first = p.cols.flat();
      const h = first.find((e) => e.a.type === 'heading');
      const body = first.find((e) => e.a.type !== 'label');
      p.title = h ? h.a.text : (body && body.a.section) || '';
    });
    return { pages: fl.pages.filter((p) => p.cols.some((c) => c.length)), G };
  }

  function renderPage(page, G, num, total, settings) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.title = page.title || '';
    el.style.width = G.W + 'px';
    el.style.height = G.H + 'px';
    el.style.setProperty('--colH', G.colH + 'px');
    page.cols.forEach((col, ci) => {
      const left = PAD_X + ci * (G.colW + G.gap);
      if (ci > 0 && col.length) {
        const d = document.createElement('div');
        d.className = 'divider';
        Object.assign(d.style, { left: left - G.gap / 2 + 'px', top: TOP + 'px', height: G.colH + 'px' });
        el.appendChild(d);
      }
      const c = document.createElement('div');
      c.className = 'col md';
      Object.assign(c.style, { left: left + 'px', top: TOP + 'px', width: G.colW + 'px', height: G.colH + 'px', fontSize: G.fs + 'px' });
      for (const { a, y } of col) {
        const d = document.createElement('div');
        d.className = 'atom';
        d.style.top = y + 'px';
        d.dataset.h = a.h;
        d.dataset.type = a.type + (a.parts ? ':' + a.parts.length : '');
        d.innerHTML = atomHtml(a);
        c.appendChild(d);
      }
      el.appendChild(c);
    });
    const f = document.createElement('div');
    f.className = 'footer';
    f.innerHTML = `<span class="sig">${esc(settings.signature || '')}</span><span class="num">${num} / ${total}</span>`;
    el.appendChild(f);
    return el;
  }

  window.MD2PIC = { layout, renderPage, waitImages };
})();
