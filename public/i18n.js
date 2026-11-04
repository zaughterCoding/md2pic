// Minimal i18n: zh (default) / en.
(function () {
  const dict = {
    zh: {
      'brand.sub': '笔记转多栏图片',
      'note.label': '笔记文件路径',
      'note.placeholder': '例如 E:\\notes\\xxx.md',
      'note.load': '加载',
      'note.info': '{name} · {h} 个标题 · {a} 个内容块',
      'layout.label': '版式',
      'size.label': '尺寸',
      'size.landscape': '横 4:3',
      'size.wide': '横 16:9',
      'size.portrait': '竖 3:4',
      'cols.label': '栏数',
      'cols.n': '{n} 栏',
      'scale.label': '清晰',
      'scale.tip': '导出像素翻倍，更清晰',
      'font.label': '字号',
      'sig.label': '署名',
      'range.label': '选择范围',
      'range.all': '全选',
      'range.hint': '点击标题左侧的「起」「止」设定范围；结束标题包含其子标题。',
      'range.from': '起',
      'range.to': '止',
      'range.noHeadings': '笔记中没有 1–4 级标题，将导出全文。',
      'export.btn': '导出 PNG',
      'export.running': '正在导出…',
      'export.done': '已导出 {n} 张到 {dir}',
      'export.open': '打开文件夹',
      'export.failed': '导出失败：{msg}',
      'status.empty': '请先加载一个 Markdown 笔记',
      'status.layout': '排版中…',
      'status.ok': '共 {n} 张 · {W}×{H} · {c} 栏 · 字号 {fs}px · 用时 {ms}ms　（悬停可排除某张，点击放大）',
      'status.failed': '排版失败：{msg}',
      'thumb.exclude': '排除',
      'thumb.restore': '恢复',
      'thumb.excluded': '已排除',
      'page.cont': ' · 续',
      'err.FILE_NOT_FOUND': '文件不存在：{detail}',
      'err.NOTE_MISSING': '上次的笔记已不存在：{detail}',
      'err.NO_NOTE': '尚未选择笔记',
      'err.BUSY': '正在导出中，请稍候',
      'lang.switch': 'EN',
    },
    en: {
      'brand.sub': 'Markdown → multi-column images',
      'note.label': 'Markdown file path',
      'note.placeholder': 'e.g. E:\\notes\\xxx.md',
      'note.load': 'Load',
      'note.info': '{name} · {h} headings · {a} blocks',
      'layout.label': 'Layout',
      'size.label': 'Size',
      'size.landscape': '4:3',
      'size.wide': '16:9',
      'size.portrait': '3:4',
      'cols.label': 'Cols',
      'cols.n': '{n}',
      'scale.label': 'Scale',
      'scale.tip': 'Double the pixels for sharper text',
      'font.label': 'Font',
      'sig.label': 'Sign',
      'range.label': 'Range',
      'range.all': 'All',
      'range.hint': 'Use "From" / "To" next to a heading to set the range; the end heading includes its sub-headings.',
      'range.from': 'From',
      'range.to': 'To',
      'range.noHeadings': 'No H1–H4 headings found; the whole note will be exported.',
      'export.btn': 'Export PNG',
      'export.running': 'Exporting…',
      'export.done': 'Exported {n} images to {dir}',
      'export.open': 'Open folder',
      'export.failed': 'Export failed: {msg}',
      'status.empty': 'Load a Markdown note to get started',
      'status.layout': 'Laying out…',
      'status.ok': '{n} images · {W}×{H} · {c} columns · {fs}px · {ms}ms  (hover to exclude, click to zoom)',
      'status.failed': 'Layout failed: {msg}',
      'thumb.exclude': 'Exclude',
      'thumb.restore': 'Restore',
      'thumb.excluded': 'Excluded',
      'page.cont': ' (cont.)',
      'err.FILE_NOT_FOUND': 'File not found: {detail}',
      'err.NOTE_MISSING': 'The last note no longer exists: {detail}',
      'err.NO_NOTE': 'No note selected',
      'err.BUSY': 'An export is already running',
      'lang.switch': '中文',
    },
  };

  let lang = 'zh';

  function t(key, params) {
    let s = (dict[lang] && dict[lang][key]) ?? dict.zh[key] ?? key;
    if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
    return s;
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n, { n: el.dataset.n }); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.lang = lang;
  }

  // Translate a server error ({ code, detail, error }) into the current language.
  function errorText(e) {
    if (e && e.code && dict.zh['err.' + e.code]) return t('err.' + e.code, { detail: e.detail || '' });
    return (e && (e.message || e.error)) || String(e);
  }

  window.I18N = {
    t, apply, errorText,
    get lang() { return lang; },
    set lang(v) { lang = v === 'en' ? 'en' : 'zh'; },
  };
})();
