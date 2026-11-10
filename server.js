// md2pic local server: parses Markdown into layout atoms, remembers config,
// serves note assets, and exports pages to PNG via headless Edge.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

const PORT = Number(process.env.PORT) || 3456;
const ROOT = __dirname;
const CONFIG_PATH = process.env.MD2PIC_CONFIG || path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULT_CONFIG = {
  notePath: '',
  settings: { pageSize: 'landscape', columns: 3, fontSize: 26, signature: 'Zaughter', scale: 2, lang: 'zh' },
  range: null, // { start: {idx, text}, end: {idx, text} }
};

// ---------- config ----------
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, settings: { ...DEFAULT_CONFIG.settings, ...(c.settings || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function writeConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
}

// ---------- markdown ----------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Split highlighted HTML into per-line HTML, closing/reopening spans that cross newlines.
function splitHighlightedLines(html) {
  const lines = [];
  const stack = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); cur += m[1]; }
    else if (m[2]) { stack.pop(); cur += m[2]; }
    else {
      const parts = (m[3] || m[4]).split('\n');
      parts.forEach((part, i) => {
        if (i > 0) {
          cur += '</span>'.repeat(stack.length);
          lines.push(cur);
          cur = stack.join('');
        }
        cur += part;
      });
    }
  }
  lines.push(cur);
  if (lines.length > 1 && lines[lines.length - 1].replace(/<[^>]+>/g, '') === '') lines.pop();
  return lines;
}

function highlightLines(code, lang) {
  let html;
  try {
    if (lang && hljs.getLanguage(lang)) html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    else html = escapeHtml(code);
  } catch {
    html = escapeHtml(code);
  }
  return splitHighlightedLines(html);
}

function createMd(noteDir) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') || '';
    if (src && !/^(https?:|data:)/i.test(src)) {
      let p = src;
      try { p = decodeURIComponent(src); } catch {}
      const abs = path.resolve(noteDir, p);
      t.attrSet('src', '/asset?p=' + encodeURIComponent(abs));
    }
    return defaultImage(tokens, idx, options, env, self);
  };
  return md;
}

// Find index of the token closing the block that opens at i (top level).
function blockEnd(tokens, i) {
  const t = tokens[i];
  if (t.nesting !== 1) return i;
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    depth += tokens[j].nesting;
    if (depth === 0) return j;
  }
  return tokens.length - 1;
}

function parseNote(src, noteDir) {
  const md = createMd(noteDir);
  const env = {};
  const tokens = md.parse(src, env);
  const render = (toks) => md.renderer.render(toks, md.options, env);
  const atoms = [];
  const headings = [];
  let groupCounter = 0;
  let section = '';

  // Convert the block tokens in [from, to) into layout atoms. `pre`/`post` wrap each atom
  // in its ancestor containers (lists, blockquotes) so a fragment renders with the same
  // indentation as the whole. `group` ties fragments of one list/quote together for spacing.
  // Lists and blockquotes also get `parts`: finer atoms used only when the whole is taller
  // than a column.
  function blocks(from, to, pre, post, group) {
    const out = [];
    const wrap = (h) => pre + h + post;
    const base = () => ({ section, group, pre, post });
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      const end = blockEnd(tokens, i);
      const slice = tokens.slice(i, end + 1);

      if (t.type === 'heading_open' && !pre) {
        const level = Number(t.tag.slice(1));
        const text = tokens[i + 1].content;
        const atom = { type: 'heading', level, text, html: render(slice) };
        if (level <= 4) {
          headings.push({ idx: headings.length, level, text, atom: atoms.length + out.length });
          section = text;
        }
        atom.section = section;
        out.push(atom);
      } else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        const gid = group || 'g' + ++groupCounter;
        const ordered = t.type === 'ordered_list_open';
        const tag = ordered ? 'ol' : 'ul';
        const startNum = ordered ? Number(t.attrGet('start') || 1) : 1;
        let n = 0;
        for (let k = i + 1; k < end; k++) {
          if (tokens[k].type !== 'list_item_open') continue;
          const kEnd = blockEnd(tokens, k);
          const open = ordered ? `<ol start="${startNum + n}">` : '<ul>';
          const close = `</${tag}>`;
          const html = wrap(open + render(tokens.slice(k, kEnd + 1)) + close);
          const parts = [];
          let first = true;
          for (let c = k + 1; c < kEnd; c++) {
            const cEnd = blockEnd(tokens, c);
            const p2 = first ? pre + open + '<li>' : pre + `<${tag}><li class="cont">`;
            parts.push(...blocks(c, cEnd + 1, p2, '</li>' + close + post, gid));
            first = false;
            c = cEnd;
          }
          out.push({ ...base(), type: 'li', group: gid, html, parts });
          n++;
          k = kEnd;
        }
      } else if (t.type === 'blockquote_open') {
        const gid = group || 'g' + ++groupCounter;
        const parts = blocks(i + 1, end, pre + '<blockquote>', '</blockquote>' + post, gid);
        out.push({ ...base(), type: 'blockquote', group: gid, html: wrap(render(slice)), parts });
      } else if (t.type === 'fence' || t.type === 'code_block') {
        const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'mermaid') out.push({ ...base(), type: 'mermaid', code: t.content });
        else out.push({ ...base(), type: 'code', lang, lines: highlightLines(t.content.replace(/\n$/, ''), lang) });
      } else if (t.type === 'table_open') {
        let head = '';
        const rows = [];
        for (let k = i + 1; k < end; k++) {
          if (tokens[k].type === 'thead_open') {
            const e = blockEnd(tokens, k);
            head = render(tokens.slice(k, e + 1));
            k = e;
          } else if (tokens[k].type === 'tr_open') {
            const e = blockEnd(tokens, k);
            rows.push(render(tokens.slice(k, e + 1)));
            k = e;
          }
        }
        out.push({ ...base(), type: 'table', head, rows });
      } else if (t.type === 'hr') {
        out.push({ ...base(), type: 'hr', html: wrap('<hr>') });
      } else {
        const inner = render(slice);
        if (inner.trim()) {
          const onlyImg = t.type === 'paragraph_open' && /^<p>\s*<img[^>]*>\s*<\/p>\s*$/.test(inner);
          out.push({ ...base(), type: onlyImg ? 'image' : 'p', html: wrap(inner) });
        }
      }
      i = end;
    }
    return out;
  }

  for (let i = 0; i < tokens.length; i++) {
    const end = blockEnd(tokens, i);
    atoms.push(...blocks(i, end + 1, '', '', undefined));
    i = end;
  }
  return { atoms, headings };
}

function loadNote(notePath) {
  const src = fs.readFileSync(notePath, 'utf8');
  const stat = fs.statSync(notePath);
  const parsed = parseNote(src, path.dirname(notePath));
  return { path: notePath, name: path.basename(notePath, path.extname(notePath)), mtime: stat.mtimeMs, ...parsed };
}

// ---------- export ----------
let exporting = false;
async function exportPages(exclude) {
  const { chromium } = require('playwright-core');
  const cfg = readConfig();
  if (!cfg.notePath) throw Object.assign(new Error('No note selected'), { code: 'NO_NOTE' });
  const noteDir = path.dirname(cfg.notePath);
  const noteName = path.basename(cfg.notePath, path.extname(cfg.notePath));
  const outDir = path.join(noteDir, noteName + '_images');
  fs.mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }
  try {
    const page = await browser.newPage({ viewport: { width: 2000, height: 1600 }, deviceScaleFactor: Number(cfg.settings.scale) === 1 ? 1 : 2 });
    const url = `http://127.0.0.1:${PORT}/?export=1&exclude=${(exclude || []).join(',')}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__layoutDone === true || window.__layoutError, null, { timeout: 120000 });
    const err = await page.evaluate(() => window.__layoutError);
    if (err) throw new Error(err);

    // remove previous output produced by this tool
    for (const f of fs.readdirSync(outDir)) {
      if (/^\d{2,3}_.*\.png$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
    }
    const pages = page.locator('.page');
    const count = await pages.count();
    const files = [];
    for (let i = 0; i < count; i++) {
      const el = pages.nth(i);
      const title = (await el.getAttribute('data-title')) || 'page';
      const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'page';
      const name = `${String(i + 1).padStart(2, '0')}_${safe}.png`;
      await el.screenshot({ path: path.join(outDir, name) });
      files.push(name);
    }
    return { dir: outDir, files };
  } finally {
    await browser.close();
  }
}

// ---------- native file picker ----------
// Browsers never reveal a picked file's full path, so the server opens the OS dialog itself.
const PS_PICK = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = 'Markdown (*.md;*.markdown)|*.md;*.markdown|All files (*.*)|*.*'
$d.Title = $env:MD2PIC_PICK_TITLE
if ($env:MD2PIC_PICK_DIR -and (Test-Path -LiteralPath $env:MD2PIC_PICK_DIR)) { $d.InitialDirectory = $env:MD2PIC_PICK_DIR }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
$owner.Dispose()
`;

function pickFile(initialDir, title) {
  return new Promise((resolve, reject) => {
    let cmd, args;
    const env = { ...process.env, MD2PIC_PICK_DIR: initialDir || '', MD2PIC_PICK_TITLE: title || 'md2pic' };
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS_PICK];
    } else if (process.platform === 'darwin') {
      const where = initialDir ? ` default location (POSIX file ${JSON.stringify(initialDir)})` : '';
      cmd = 'osascript';
      args = ['-e', `POSIX path of (choose file with prompt ${JSON.stringify(title || 'md2pic')}${where})`];
    } else {
      cmd = 'zenity';
      args = ['--file-selection', '--title=' + (title || 'md2pic'), '--file-filter=Markdown | *.md *.markdown', '--file-filter=All files | *'];
      if (initialDir) args.push('--filename=' + path.join(initialDir, path.sep));
    }
    execFile(cmd, args, { env, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      const picked = String(stdout || '').trim();
      if (picked) return resolve(picked);
      // Cancelling the dialog exits with an error on macOS / Linux; treat it as "nothing picked".
      if (err && err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} not found`), { code: 'PICKER_UNAVAILABLE' }));
      resolve('');
    });
  });
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function normalizePath(p) {
  return path.resolve(String(p || '').trim().replace(/^["']|["']$/g, ''));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (p === '/lib/mermaid.min.js') return sendFile(res, path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'));
    if (p.startsWith('/public/')) {
      const f = path.join(PUBLIC_DIR, path.normalize(p.slice(8)));
      if (!f.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
      return sendFile(res, f);
    }
    if (p === '/asset') {
      const f = url.searchParams.get('p') || '';
      if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) return send(res, 403, { error: 'not an image' });
      return sendFile(res, f);
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, readConfig());
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      if (body.settings) cfg.settings = { ...cfg.settings, ...body.settings };
      if ('range' in body) cfg.range = body.range;
      writeConfig(cfg);
      return send(res, 200, cfg);
    }
    if (p === '/api/note') {
      const cfg = readConfig();
      let notePath = cfg.notePath;
      if (req.method === 'POST') {
        const body = await readBody(req);
        notePath = normalizePath(body.path);
        if (!fs.existsSync(notePath) || !fs.statSync(notePath).isFile()) return send(res, 400, { error: 'File not found: ' + notePath, code: 'FILE_NOT_FOUND', detail: notePath });
        if (notePath !== cfg.notePath) { cfg.notePath = notePath; cfg.range = null; writeConfig(cfg); }
      }
      if (!notePath) return send(res, 200, { note: null });
      if (!fs.existsSync(notePath)) return send(res, 200, { note: null, error: 'Note no longer exists: ' + notePath, code: 'NOTE_MISSING', detail: notePath });
      return send(res, 200, { note: loadNote(notePath) });
    }
    if (p === '/api/export' && req.method === 'POST') {
      if (exporting) return send(res, 409, { error: 'An export is already running', code: 'BUSY' });
      exporting = true;
      try {
        const body = await readBody(req);
        return send(res, 200, await exportPages(body.exclude));
      } finally {
        exporting = false;
      }
    }
    if (p === '/api/pick' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      const dir = cfg.notePath ? path.dirname(cfg.notePath) : '';
      const picked = await pickFile(dir, body.title);
      return send(res, 200, { path: picked ? path.resolve(picked) : '' });
    }
    if (p === '/api/open-dir' && req.method === 'POST') {
      const body = await readBody(req);
      openExternal(normalizePath(body.dir));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e), code: e.code });
  }
});

// Open a URL or folder with the OS default handler.
function openExternal(target) {
  const cmd = process.platform === 'win32' ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd);
}

const URL_BASE = `http://localhost:${PORT}`;
const shouldOpen = !process.env.NO_OPEN && !process.argv.includes('--no-open');

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Port taken: if it's already md2pic, just open it; otherwise explain.
  http.get(`http://127.0.0.1:${PORT}/api/config`, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      let isUs = false;
      try { isUs = 'notePath' in JSON.parse(b); } catch {}
      if (isUs) {
        console.log(`md2pic is already running at ${URL_BASE}, opening it.`);
        if (shouldOpen) openExternal(URL_BASE);
        setTimeout(() => process.exit(0), 500);
      } else {
        console.error(`Port ${PORT} is used by another program. Set PORT to use another one, e.g. set PORT=3457 && node server.js
端口 ${PORT} 被其他程序占用，可设置环境变量 PORT 换一个端口。`);
        process.exit(1);
      }
    });
  }).on('error', () => {
    console.error(`Port ${PORT} is used by another program. Set PORT to use another one.
端口 ${PORT} 被其他程序占用，可设置环境变量 PORT 换一个端口。`);
    process.exit(1);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`md2pic running at ${URL_BASE}  (close this window to stop / 关闭此窗口即停止服务)`);
  if (shouldOpen) openExternal(URL_BASE);
});
