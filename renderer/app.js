/* eslint-disable no-undef */
/**
 * StarHub 渲染进程：分类导航、列表、排序、预览、汉化、收藏/点赞。
 */
const api = window.starhub;

const state = {
  categories: [],
  topCategory: null,
  sorts: [],
  languages: [],
  langColors: {},
  tags: [],
  activeTag: null,
  curated: { counts: {}, total: 0, updatedAt: '' },
  settings: {},
  rate: {},
  theme: 'dark', // dark | light
  version: '1.2.2',
  update: null, // { ok, current, latest, hasUpdate, downloadUrl, ... }
  view: 'browse', // browse | favorites | likes
  tab: 'top',
  source: 'online', // online | curated
  sort: 'stars',
  language: 'all',
  minStars: 0,
  growth7: 0,
  growth30: 0,
  keyword: '',
  page: 1,
  pageSize: 24,
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  note: '',
  forceNext: false,
  library: { favorites: [], likes: [] },
  detailRepo: null,
  detailToken: 0,
  readme: { en: '', zh: null, mode: 'en', loadingTranslation: false },
  readmeToken: 0,
};

const el = (id) => document.getElementById(id);

const ICON_HEART =
  '<svg class="ico ico-heart" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const ICON_THUMB =
  '<svg class="ico ico-thumb" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';

const dom = {
  categoryNav: el('categoryNav'),
  libraryNav: el('libraryNav'),
  grid: el('grid'),
  content: el('content'),
  headTitle: el('headTitle'),
  headBlurb: el('headBlurb'),
  headMeta: el('headMeta'),
  setupTip: el('setupTip'),
  notice: el('notice'),
  empty: el('empty'),
  emptyDesc: el('emptyDesc'),
  listFooter: el('listFooter'),
  btnMore: el('btnMore'),
  footerNote: el('footerNote'),
  searchInput: el('searchInput'),
  searchClear: el('searchClear'),
  searchHints: el('searchHints'),
  sortSelect: el('sortSelect'),
  langSelect: el('langSelect'),
  starsSelect: el('starsSelect'),
  growth7Select: el('growth7Select'),
  growth30Select: el('growth30Select'),
  sourceSeg: el('sourceSeg'),
  drawer: el('drawer'),
  drawerBody: el('drawerBody'),
  drawerName: el('drawerName'),
  drawerOwner: el('drawerOwner'),
  drawerAvatar: el('drawerAvatar'),
  countFavorites: el('countFavorites'),
  countLikes: el('countLikes'),
  countCurated: el('countCurated'),
  apiState: el('apiState'),
  apiStateText: el('apiStateText'),
  statusSource: el('statusSource'),
  statusRate: el('statusRate'),
  statusTranslate: el('statusTranslate'),
  statusCache: el('statusCache'),
  statusVersion: el('statusVersion'),
  toasts: el('toastStack'),
  settingsModal: el('settingsModal'),
  aboutModal: el('aboutModal'),
  updateTip: el('updateTip'),
  aboutUpdateText: el('aboutUpdateText'),
};

/* ---------------- 主题（亮 / 暗） ---------------- */

// 主题同时写进 settings.json（跨启动持久化）和 localStorage（首屏同步上色，避免闪一下暗色）
const THEME_KEY = 'starhub.theme';

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch (_) {
    return 'dark';
  }
}

function paintTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  state.theme = next;
  document.documentElement.dataset.theme = next;
  // 图标由 CSS 按 data-theme 切换（暗色显示月亮、亮色显示太阳），这里只更新提示文案
  const btn = document.getElementById('btnTheme');
  if (btn) {
    btn.title = next === 'light' ? '切换到暗色主题' : '切换到亮色主题';
    btn.setAttribute('aria-label', btn.title);
  }
}

function applyTheme(theme, { persist = false } = {}) {
  paintTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch (_) {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
  // 同步主进程：窗口底色 + 右上角系统按钮配色
  if (api.setTheme) api.setTheme(state.theme).catch(() => {});
  if (persist && api.saveSettings) api.saveSettings({ theme: state.theme }).catch(() => {});
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light', { persist: true });
}

// 首屏先按上次的选择上色（只读 localStorage，不用等 IPC），避免亮色用户启动时闪一下暗色
paintTheme(readStoredTheme());

/* ---------------- 更新提示（读取 GitHub Releases） ---------------- */

// 24 小时检查一次；「跳过此版本」也记在 localStorage，避免每次启动都打扰
const UPDATE_KEY = 'starhub.updateCheck';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
const RELEASE_PAGE = 'https://github.com/kllll-c/starhub/releases/latest';

function readUpdateMeta() {
  try {
    return JSON.parse(localStorage.getItem(UPDATE_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function writeUpdateMeta(patch) {
  try {
    localStorage.setItem(UPDATE_KEY, JSON.stringify({ ...readUpdateMeta(), ...patch }));
  } catch (_) {
    /* localStorage 不可写时忽略，不影本次会话的提示 */
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function renderUpdateTip() {
  const info = state.update;
  const meta = readUpdateMeta();
  const show = Boolean(
    info && info.ok && info.hasUpdate && info.latest && meta.skippedVersion !== info.latest,
  );
  if (!show) {
    dom.updateTip.hidden = true;
    dom.updateTip.innerHTML = '';
    return;
  }
  const hint = info.downloadSize
    ? `安装包 ${formatBytes(info.downloadSize)}`
    : '点「下载新版」前往 Release 页面';
  dom.updateTip.innerHTML = `
    <div class="setup-tip-text">
      <span class="update-chip">NEW</span>
      <strong>发现新版本 v${esc(info.latest)}</strong>（当前 v${esc(state.version)}）· ${esc(hint)}
    </div>
    <div class="setup-tip-actions">
      <button class="tip-btn primary" data-act="update-download">下载新版</button>
      <button class="tip-btn ghost" data-act="update-later">稍后提醒</button>
      <button class="tip-btn ghost" data-act="update-skip">跳过此版本</button>
    </div>`;
  dom.updateTip.hidden = false;
}

function updateAboutUpdate() {
  if (!dom.aboutUpdateText) return;
  const info = state.update;
  if (!info) {
    dom.aboutUpdateText.textContent = '';
    return;
  }
  if (!info.ok) {
    dom.aboutUpdateText.textContent = info.error || '检查更新失败';
    return;
  }
  dom.aboutUpdateText.textContent = info.hasUpdate
    ? `发现新版本 v${info.latest}（当前 v${state.version}）`
    : `已是最新版本（v${state.version}）`;
}

async function checkUpdate({ force = false, silent = true } = {}) {
  const meta = readUpdateMeta();
  if (!force && meta.at && Date.now() - meta.at < UPDATE_INTERVAL) return state.update;
  writeUpdateMeta({ at: Date.now() });
  let result;
  try {
    result = await api.checkUpdate({ force });
  } catch (err) {
    result = { ok: false, current: state.version, error: `检查更新失败：${err.message}` };
  }
  state.update = result || null;
  renderUpdateTip();
  updateAboutUpdate();
  if (!silent) {
    if (!result || !result.ok) toast((result && result.error) || '检查更新失败', 'err');
    else if (result.hasUpdate) toast(`发现新版本 v${result.latest}，可前往下载`, 'ok');
    else toast(`已是最新版本 v${state.version}`, 'ok');
  }
  return state.update;
}

function handleUpdateAction(act) {
  const info = state.update || {};
  if (act === 'update-download') {
    api.openExternal(info.downloadUrl || info.pageUrl || RELEASE_PAGE).catch(() => {});
    toast('已在浏览器打开下载页面', 'ok');
    return;
  }
  if (act === 'update-later') {
    writeUpdateMeta({ at: Date.now() });
    renderUpdateTip();
    toast('好的，24 小时后再提醒');
    return;
  }
  if (act === 'update-skip') {
    writeUpdateMeta({ at: Date.now(), skippedVersion: info.latest || '' });
    renderUpdateTip();
    toast(`已跳过 v${info.latest || ''}，下个版本仍会提醒`);
  }
}

/* ---------------- 工具函数 ---------------- */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function formatNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function langColor(lang) {
  return state.langColors[lang] || '#6e7c8f';
}

function providerLabel() {
  const s = state.settings || {};
  if (s.translationProvider === 'openai' && s.hasOpenaiKey) {
    return `AI 翻译（${s.openaiModel || 'gpt-4o-mini'}）`;
  }
  if (s.translationProvider === 'openai' && !s.hasOpenaiKey) {
    return 'AI 翻译（未配置 Key，将回退免费翻译）';
  }
  if (s.translationProvider === 'zhipu' && s.hasZhipuKey) {
    return `智谱 GLM（${s.zhipuModel || 'glm-4.6v-flash'}）`;
  }
  if (s.translationProvider === 'zhipu' && !s.hasZhipuKey) {
    return '智谱 GLM（未配置 Key，将回退免费翻译）';
  }
  if (s.translationProvider === 'baidu' && s.hasBaiduKey) {
    return '百度翻译';
  }
  if (s.translationProvider === 'baidu' && !s.hasBaiduKey) {
    return '百度翻译（未配置 APP ID / 密钥，将回退免费翻译）';
  }
  if (s.translationProvider === 'youdao' && s.hasYoudaoKey) {
    return '有道翻译';
  }
  if (s.translationProvider === 'youdao' && !s.hasYoudaoKey) {
    return '有道翻译（未配置应用 ID / 应用密钥，将回退免费翻译）';
  }
  if (s.translationProvider === 'off') return '离线术语表（仅标题）';
  return 'MyMemory 免费翻译';
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  dom.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'all .25s ease';
    setTimeout(() => node.remove(), 260);
  }, 2600);
}

function showNotice(text, kind = '') {
  if (!text) {
    dom.notice.hidden = true;
    dom.notice.textContent = '';
    return;
  }
  dom.notice.hidden = false;
  dom.notice.className = `notice ${kind}`;
  dom.notice.innerHTML = text;
}

function plural(count, unit) {
  return `${count} ${unit}`;
}

/* ---------------- 标签搜索 ---------------- */

/**
 * 在「标签」列表里匹配输入内容：中文标签名、英文别名都能命中。
 */
function matchTags(query) {
  const kw = (query || '').trim().toLowerCase();
  if (!kw) return [];
  const compact = kw.replace(/\s+/g, '');
  const hits = [];
  for (const tag of state.tags) {
    const label = tag.label.toLowerCase();
    const terms = (tag.terms || []).map((t) => String(t).toLowerCase());
    const hit =
      label.includes(kw) ||
      label.replace(/\s+/g, '').includes(compact) ||
      terms.some((t) => t.includes(kw) || t.replace(/\s+/g, '').includes(compact));
    if (hit) hits.push(tag);
    if (hits.length >= 6) break;
  }
  return hits;
}

function renderSearchHints(query) {
  const hits = matchTags(query);
  if (!hits.length) {
    hideSearchHints();
    return;
  }
  const exact = hits.some((t) => t.label.toLowerCase() === (query || '').trim().toLowerCase());
  dom.searchHints.innerHTML =
    `<div class="hint-title">${exact ? '按标签搜索' : '相关标签（点击按标签搜索）'}</div>` +
    hits
      .map(
        (t) => `<button class="tag-hint" data-tag="${esc(t.label)}" title="${esc(t.desc)}">
          <span class="tag-hint-name">${esc(t.label)}</span>
          <span class="tag-hint-desc">${esc(t.desc)}</span>
          ${tagHintCount(t) ? `<span class="tag-hint-count">${tagHintCount(t)}</span>` : ''}
        </button>`,
      )
      .join('');
  dom.searchHints.hidden = false;
}

function tagHintCount(tag) {
  const counts = (state.curated && state.curated.tagCounts) || {};
  return counts[tag.label] ? `${counts[tag.label]} 个精选` : '';
}

function hideSearchHints() {
  dom.searchHints.hidden = true;
  dom.searchHints.innerHTML = '';
}

function applyTagSearch(label) {
  state.keyword = label;
  dom.searchInput.value = label;
  dom.searchClear.parentElement.classList.add('has-value');
  state.view = 'browse';
  hideSearchHints();
  load({ reset: true });
}

/* ---------------- 初始化 ---------------- */

async function init() {
  const data = await api.init();
  state.categories = data.categories;
  state.topCategory = data.topCategory;
  state.sorts = data.sorts;
  state.languages = data.languages;
  state.langColors = data.langColors || {};
  state.tags = data.tags || [];
  state.curated = data.curated;
  state.settings = { ...data.settings, translationProvider: data.translationProvider || data.settings.translationProvider };
  state.rate = data.rate || {};
  state.library = data.library || { favorites: [], likes: [] };
  state.pageSize = data.settings.pageSize || 24;

  // 以 settings.json 为准（localStorage 只用于首屏快速上色）
  applyTheme(data.settings.theme === 'light' ? 'light' : 'dark');

  state.version = data.version || '1.2.2';
  dom.statusVersion.textContent = state.version;
  el('aboutVersion').textContent = state.version;
  el('countCurated').textContent = state.curated.total;

  buildSidebar();
  buildSelects();
  bindEvents();
  updateLibraryCounts();
  updateRateUi();
  updateTranslateUi();
  renderSetupTip();
  renderHead();

  await refreshCacheStats();

  await load({ reset: true });

  // 首屏加载完成后延迟检查更新（不抢夺 GitHub 接口额度，失败静默）
  setTimeout(() => checkUpdate({ silent: true }), 1500);
}

async function refreshCacheStats() {
  try {
    const stats = await api.cacheStats();
    dom.statusCache.textContent = `缓存 ${stats.files} 项`;
  } catch (_) {
    dom.statusCache.textContent = '';
  }
}

function buildSidebar() {
  const fromCategory = (c) => ({
    tab: c.id,
    emoji: c.emoji,
    name: c.name,
    count: state.curated.counts[c.id] || '',
  });
  // 「全部」放在最上面作为默认汇总视图，其次是全站高星榜，最后是各用途分类
  const allCat = state.categories.find((c) => c.id === 'all');
  const rest = state.categories.filter((c) => c.id !== 'all');
  const items = [
    allCat ? fromCategory(allCat) : null,
    { tab: 'top', emoji: '⭐', name: '高星精选', count: '' },
    ...rest.map(fromCategory),
  ].filter(Boolean);
  dom.categoryNav.innerHTML = items
    .map(
      (item) => `<button class="nav-item${item.tab === state.tab && state.view === 'browse' ? ' active' : ''}"
        data-tab="${item.tab}" data-view="browse">
        <span class="nav-emoji">${item.emoji}</span>
        <span class="nav-name">${esc(item.name)}</span>
        ${item.count ? `<span class="nav-count">${item.count}</span>` : ''}
      </button>`,
    )
    .join('');
}

function buildSelects() {
  dom.sortSelect.innerHTML = state.sorts
    .map((s) => `<option value="${s.id}">${esc(s.label)}</option>`)
    .join('');
  dom.sortSelect.value = state.sort;

  dom.langSelect.innerHTML = state.languages
    .map((l) => `<option value="${l.id}">${esc(l.label)}</option>`)
    .join('');
  dom.langSelect.value = state.language;
}

function syncNavActive() {
  dom.categoryNav.querySelectorAll('.nav-item').forEach((node) => {
    // 内置精选模式下点分类会按分类过滤精选库，因此也高亮该分类；
    // 但「高星精选」在内置库等价于「全部精选」，交给侧边栏的「内置精选库」高亮
    const curatedHere = state.source === 'curated' && node.dataset.tab !== 'top';
    node.classList.toggle(
      'active',
      state.view === 'browse' && node.dataset.tab === state.tab && (state.source !== 'curated' || curatedHere),
    );
  });
  dom.libraryNav.querySelectorAll('.nav-item').forEach((node) => {
    const tab = node.dataset.tab;
    if (tab === 'curated') {
      node.classList.toggle('active', state.source === 'curated' && state.view === 'browse');
      return;
    }
    node.classList.toggle('active', state.view === tab);
  });
}

function syncSourceSeg() {
  dom.sourceSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === state.source);
  });
}

function updateLibraryCounts() {
  dom.countFavorites.textContent = state.library.favorites.length;
  dom.countLikes.textContent = state.library.likes.length;
}

function updateRateUi() {
  const rate = state.rate || {};
  const core = rate.core;
  const search = rate.search;
  const parts = [];
  if (core) parts.push(`核心 ${core.remaining}/${core.limit}`);
  if (search) parts.push(`搜索 ${search.remaining}/${search.limit}`);
  const text = parts.length ? `接口额度：${parts.join(' · ')}` : '接口额度：--';
  dom.statusRate.textContent = text;

  const stateNode = dom.apiState;
  stateNode.classList.remove('ok', 'warn', 'err');
  const anyRate = core || search;
  if (core && core.remaining <= 3) {
    stateNode.classList.add('warn');
    dom.apiStateText.textContent = `GitHub 额度即将用尽${rate.hasToken ? '' : '（可在设置中填 Token）'}`;
  } else if (anyRate) {
    stateNode.classList.add('ok');
    dom.apiStateText.textContent = rate.hasToken ? '已使用个人 Token 连接' : '已连接 GitHub（匿名额度）';
  } else {
    dom.apiStateText.textContent = '正在连接 GitHub…';
  }
}

function updateTranslateUi() {
  dom.statusTranslate.textContent = `汉化：${providerLabel()}`;
}

/* ---------------- 首次使用配置引导 ---------------- */

const BAIDU_CONSOLE_URL = 'https://fanyi-api.baidu.com/api/trans/product/desktop';

/** 是否已经配好了「不限额度」的在线引擎（AI 或百度）。 */
function translationConfigured() {
  const s = state.settings || {};
  if (s.translationProvider === 'openai') return Boolean(s.hasOpenaiKey);
  if (s.translationProvider === 'zhipu') return Boolean(s.hasZhipuKey);
  if (s.translationProvider === 'baidu') return Boolean(s.hasBaiduKey);
  if (s.translationProvider === 'youdao') return Boolean(s.hasYoudaoKey);
  if (s.translationProvider === 'off') return true; // 用户主动选了离线术语表，不再提示
  return false; // MyMemory 免费引擎：能用，但有每日额度
}

/**
 * 首次启动引导：还没配引擎时在列表上方提示「去配置」。
 * 关闭后写入 settings.json（setupTipDismissed），下次启动不再出现。
 */
function renderSetupTip() {
  if (!dom.setupTip) return;
  const s = state.settings || {};
  if (s.setupTipDismissed || translationConfigured()) {
    dom.setupTip.hidden = true;
    dom.setupTip.innerHTML = '';
    return;
  }
  const freeNow =
    s.translationProvider === 'baidu' ||
    s.translationProvider === 'openai' ||
    s.translationProvider === 'zhipu' ||
    s.translationProvider === 'youdao';
  dom.setupTip.innerHTML = `
    <div class="setup-tip-text">
      <strong>${freeNow ? '汉化引擎还没填凭据' : '汉化引擎还没配置'}</strong>：
      当前${freeNow ? '会回退到' : '使用'} MyMemory 免费翻译（每天约 5000 词，README 自动汉化只翻前 2500 字符）。
      配好<strong>百度翻译</strong>、<strong>有道翻译</strong>、<strong>智谱 GLM</strong>或<strong>AI 翻译</strong>后，可整篇、按量计费地自动汉化所有外语仓库。
    </div>
    <div class="setup-tip-actions">
      <button class="tip-btn primary" data-act="setup-open">去配置（3 步）</button>
      <button class="tip-btn" data-act="setup-baidu">获取百度 APP ID</button>
      <button class="tip-btn ghost" data-act="setup-dismiss">不再提示</button>
    </div>`;
  dom.setupTip.hidden = false;
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 图标加载失败时降级为占位块（替代内联 onerror，符合 CSP）
  const markImageFailed = (event) => {
    const target = event.target;
    if (target && target.tagName === 'IMG') target.classList.add('img-failed');
  };
  dom.grid.addEventListener('error', markImageFailed, true);
  dom.drawerBody.addEventListener('error', markImageFailed, true);

  dom.categoryNav.addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn) return;
    state.view = 'browse';
    state.tab = btn.dataset.tab;
    state.source = state.source === 'curated' ? 'curated' : 'online';
    if (state.tab === 'top') state.source = 'online';
    state.keyword = '';
    state.activeTag = null;
    hideSearchHints();
    dom.searchInput.value = '';
    dom.searchClear.parentElement.classList.remove('has-value');
    syncNavActive();
    syncSourceSeg();
    load({ reset: true });
  });

  dom.libraryNav.addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn) return;
    state.keyword = '';
    state.activeTag = null;
    hideSearchHints();
    dom.searchInput.value = '';
    dom.searchClear.parentElement.classList.remove('has-value');
    if (btn.dataset.tab === 'curated') {
      state.view = 'browse';
      state.source = 'curated';
      state.tab = 'top';
      syncNavActive();
      syncSourceSeg();
      load({ reset: true });
      return;
    }
    state.view = btn.dataset.tab;
    syncNavActive();
    load({ reset: true });
  });

  dom.sourceSeg.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn) return;
    state.source = btn.dataset.source;
    state.view = 'browse';
    if (state.tab === 'top' && state.source === 'curated') {
      // 内置库没有「全站高星榜」时，仍然按 Star 排序展示全部
    }
    syncSourceSeg();
    syncNavActive();
    load({ reset: true });
  });

  dom.sortSelect.addEventListener('change', () => {
    state.sort = dom.sortSelect.value;
    load({ reset: true });
  });

  dom.langSelect.addEventListener('change', () => {
    state.language = dom.langSelect.value;
    load({ reset: true });
  });

  dom.starsSelect.addEventListener('change', () => {
    state.minStars = Number(dom.starsSelect.value) || 0;
    load({ reset: true });
  });

  dom.growth7Select.addEventListener('change', () => {
    state.growth7 = Number(dom.growth7Select.value) || 0;
    load({ reset: true });
  });

  dom.growth30Select.addEventListener('change', () => {
    state.growth30 = Number(dom.growth30Select.value) || 0;
    load({ reset: true });
  });

  // 翻译引擎：只显示下拉框选中的那个引擎的配置面板
  el('inputProvider').addEventListener('change', () => {
    syncEnginePanels(el('inputProvider').value);
  });

  let searchTimer = null;
  dom.searchInput.addEventListener('input', () => {
    const value = dom.searchInput.value;
    const hasValue = Boolean(value.trim());
    dom.searchClear.parentElement.classList.toggle('has-value', hasValue);
    // 输入时即时提示可用的标签（点击即按标签搜索）
    renderSearchHints(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const kw = dom.searchInput.value.trim();
      if (kw === state.keyword) return;
      state.keyword = kw;
      load({ reset: true });
    }, 420);
  });
  dom.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      clearTimeout(searchTimer);
      state.keyword = dom.searchInput.value.trim();
      hideSearchHints();
      load({ reset: true });
    }
    if (event.key === 'Escape') {
      dom.searchInput.value = '';
      dom.searchInput.blur();
      hideSearchHints();
    }
  });
  dom.searchInput.addEventListener('blur', () => {
    // 让点击建议项的 click 先触发
    setTimeout(hideSearchHints, 150);
  });
  dom.searchInput.addEventListener('focus', () => {
    if (dom.searchInput.value.trim()) renderSearchHints(dom.searchInput.value);
  });
  dom.searchHints.addEventListener('click', (event) => {
    const btn = event.target.closest('.tag-hint');
    if (btn) applyTagSearch(btn.dataset.tag);
  });
  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.searchClear.parentElement.classList.remove('has-value');
    hideSearchHints();
    state.keyword = '';
    load({ reset: true });
  });

  // 顶部提示条里的快捷入口（如「设置」）
  dom.notice.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act="open-settings"]');
    if (btn) openSettings();
  });

  // 首次使用引导条
  dom.setupTip.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'setup-open') {
      openSettings();
      return;
    }
    if (act === 'setup-baidu') {
      api.openExternal(BAIDU_CONSOLE_URL).catch(() => {});
      return;
    }
    if (act === 'setup-dismiss') {
      state.settings = { ...state.settings, setupTipDismissed: true };
      renderSetupTip();
      try {
        await api.saveSettings({ setupTipDismissed: true });
      } catch (_) {
        /* 写盘失败也不影响本次会话隐藏 */
      }
      toast('已隐藏，可在「设置」里随时配置汉化引擎');
    }
  });

  dom.btnMore.addEventListener('click', () => load({ append: true }));

  el('btnReload').addEventListener('click', () => {
    state.forceNext = true;
    load({ reset: true }).then(() => toast('已刷新（强制请求 GitHub 最新数据）'));
  });

  dom.grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    const fullName = card.dataset.full;
    const repo = state.items.find((r) => r.fullName === fullName);
    if (!repo) return;
    const actBtn = event.target.closest('[data-act]');
    if (actBtn) {
      event.stopPropagation();
      handleCardAction(actBtn.dataset.act, repo, actBtn);
      return;
    }
    openDetail(repo);
  });

  el('btnCloseDrawer').addEventListener('click', closeDrawer);

  dom.drawerBody.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href');
      if (href && /^https?:/i.test(href)) api.openExternal(href);
      return;
    }
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const action = btn.dataset.act;
    const repo = state.detailRepo;
    if (action === 'tag') {
      applyTagSearch(btn.dataset.tag);
      closeDrawer();
      return;
    }
    if (action === 'readme-zh') setReadmeMode('zh');
    if (action === 'readme-en') setReadmeMode('en');
    if (action === 'readme-retranslate') retranslateReadme();
    if (action === 'translate-desc') translateDetailDesc();
    if (repo) {
      if (action === 'fav' || action === 'like') handleCardAction(action, repo, btn);
      if (action === 'open') api.openExternal(repo.htmlUrl);
      if (action === 'copy') {
        api.copy(repo.htmlUrl);
        toast('已复制仓库地址', 'ok');
      }
      if (action === 'homepage' && repo.homepage) api.openExternal(repo.homepage);
      if (action === 'close') closeDrawer();
    }
  });

  el('btnSettings').addEventListener('click', openSettings);
  el('btnTheme').addEventListener('click', toggleTheme);

  // 更新提示条：下载 / 稍后提醒 / 跳过此版本
  dom.updateTip.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (btn) handleUpdateAction(btn.dataset.act);
  });
  el('btnCloseSettings').addEventListener('click', closeSettings);
  el('btnCancelSettings').addEventListener('click', closeSettings);
  el('btnSaveSettings').addEventListener('click', saveSettings);
  el('btnClearCache').addEventListener('click', async () => {
    await api.clearCache();
    const s = await api.cacheStats();
    el('cacheStatsText').textContent = `缓存文件：${s.files}`;
    dom.statusCache.textContent = `缓存 ${s.files} 项`;
    toast('已清空接口缓存', 'ok');
  });

  el('btnAbout').addEventListener('click', () => {
    dom.aboutModal.hidden = false;
  });

  el('btnCloseAbout').addEventListener('click', () => {
    dom.aboutModal.hidden = true;
  });

  el('btnCheckUpdate').addEventListener('click', () => checkUpdate({ force: true, silent: false }));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!dom.settingsModal.hidden) closeSettings();
      else if (!dom.aboutModal.hidden) dom.aboutModal.hidden = true;
      else if (!dom.drawer.hidden) closeDrawer();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      dom.searchInput.focus();
      dom.searchInput.select();
    }
  });

  dom.settingsModal.addEventListener('click', (event) => {
    if (event.target === dom.settingsModal) closeSettings();
  });
  dom.aboutModal.addEventListener('click', (event) => {
    if (event.target === dom.aboutModal) dom.aboutModal.hidden = true;
  });
}

/* ---------------- 列表加载 ---------------- */

function renderHead() {
  if (state.view === 'favorites') {
    dom.headTitle.textContent = '我的收藏';
    dom.headBlurb.textContent = '你收藏的高星项目，可随时打开预览或回到原站';
    dom.headMeta.innerHTML = `<span class="chip accent">${state.library.favorites.length} 个仓库</span>`;
    return;
  }
  if (state.view === 'likes') {
    dom.headTitle.textContent = '我点赞的';
    dom.headBlurb.textContent = '给你觉得好用的项目点个赞，下次更快找到';
    dom.headMeta.innerHTML = `<span class="chip accent">${state.library.likes.length} 个仓库</span>`;
    return;
  }
  const category =
    state.tab === 'top'
      ? state.topCategory || { name: '高星精选', blurb: '全站 Star 最多的开源项目' }
      : state.categories.find((c) => c.id === state.tab);
  const meta = [];
  if (state.source === 'curated') meta.push('<span class="chip">内置精选库</span>');
  if (state.activeTag && state.activeTag.label === state.keyword) {
    meta.push(`<span class="chip accent" title="${esc(state.activeTag.desc || '按标签搜索')}">标签：${esc(state.activeTag.label)}</span>`);
  } else if (state.keyword) {
    meta.push(`<span class="chip accent">搜索：${esc(state.keyword)}</span>`);
  }
  if (state.language !== 'all') meta.push(`<span class="chip">${esc(state.language)}</span>`);
  if (state.minStars) meta.push(`<span class="chip">≥ ${formatNum(state.minStars)} Star</span>`);
  if (state.growth7) meta.push(`<span class="chip accent">近 7 日 +${formatNum(state.growth7)} Star</span>`);
  if (state.growth30) meta.push(`<span class="chip accent">近 30 日 +${formatNum(state.growth30)} Star</span>`);
  dom.headMeta.innerHTML = meta.join('');
  if (state.source === 'curated') {
    dom.headTitle.textContent = state.tab === 'top' ? '内置精选库' : `${category ? category.name : ''} · 内置精选`;
    dom.headBlurb.textContent = '人工整理的中文项目资料，按用途分类，离线也能浏览';
  } else {
    dom.headTitle.textContent = category ? category.name : '高星精选';
    dom.headBlurb.textContent = category ? category.blurb : '全站 Star 最多的开源项目';
  }
}

function showSkeletons() {
  dom.empty.hidden = true;
  dom.grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
  dom.listFooter.hidden = true;
}

function updateStatusSource() {
  const label =
    state.view === 'favorites'
      ? '我的收藏'
      : state.view === 'likes'
        ? '我点赞的'
        : state.source === 'curated'
          ? '内置精选'
          : state.keyword
            ? state.activeTag
              ? `标签搜索：${state.activeTag.label}`
              : '在线搜索'
            : '在线发现';
  dom.statusSource.textContent = label;
}

async function load({ reset = false, append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  renderHead();
  updateStatusSource();

  if (state.view === 'favorites' || state.view === 'likes') {
    const list = state.view === 'favorites' ? state.library.favorites : state.library.likes;
    let items = list.slice();
    if (state.keyword) {
      const kw = state.keyword.toLowerCase();
      items = items.filter(
        (r) =>
          r.fullName.toLowerCase().includes(kw) ||
          (r.zhDesc || '').includes(kw) ||
          (r.description || '').toLowerCase().includes(kw),
      );
    }
    state.items = items.map((r) => ({
      ...r,
      favorited: state.library.favorites.some((x) => x.fullName === r.fullName),
      liked: state.library.likes.some((x) => x.fullName === r.fullName),
    }));
    state.total = state.items.length;
    state.hasMore = false;
    renderGrid(state.items);
    dom.listFooter.hidden = true;
    showNotice('');
    state.loading = false;
    return;
  }

  if (!append) {
    state.page = 1;
    showSkeletons();
    showNotice('');
  } else {
    state.page += 1;
  }

  const params = {
    source: state.source,
    categoryId: state.tab,
    keyword: state.keyword,
    sort: state.sort,
    language: state.language,
    minStars: state.minStars,
    growth7: state.growth7,
    growth30: state.growth30,
    page: state.page,
    pageSize: state.pageSize,
    force: state.forceNext,
  };

  let res;
  try {
    res = await api.listRepos(params);
  } catch (err) {
    res = { items: [], total: 0, hasMore: false, error: err.message };
  }
  state.forceNext = false;

  if (res.rate) {
    state.rate = res.rate;
    updateRateUi();
  }

  if (res.error) {
    state.items = [];
    state.loading = false;
    dom.grid.innerHTML = '';
    dom.listFooter.hidden = true;
    dom.empty.hidden = false;
    dom.emptyDesc.textContent = res.error;
    if (res.rateLimited) {
      const resetAt = res.resetAt ? new Date(res.resetAt).toLocaleTimeString('zh-CN') : '';
      showNotice(
        `${esc(res.error)}${resetAt ? `，额度将在 ${resetAt} 重置` : ''}。<br>可以在「设置」里填入 GitHub Personal Access Token，把额度提升到每小时 5000 次。`,
        'error',
      );
    } else {
      showNotice(`${esc(res.error)}<br>如果网络访问 GitHub 不稳定，可以同时使用「内置精选」离线浏览。`, 'error');
    }
    updateRateUi();
    return;
  }

  if (append) {
    const merged = state.items.concat(res.items);
    state.items = merged;
  } else {
    state.items = res.items;
  }
  state.total = res.total;
  state.hasMore = res.hasMore;
  state.note = res.note || '';
  state.activeTag = res.tag || null;
  state.page = params.page;
  state.loading = false;
  renderHead();

  const nearLimit = res.total && res.total >= 1000;
  dom.footerNote.textContent = nearLimit
    ? 'GitHub 搜索最多返回 1000 条结果，可用关键词进一步缩小范围'
    : res.total
      ? `共 ${formatNum(res.total)} 个匹配仓库`
      : '';
  if (state.sort === 'alpha' && res.source !== 'curated') {
    dom.footerNote.textContent += ' · 首字母排序只在 Star 最高的 100 个结果内重排';
  }

  showNotice(state.note || '', 'info');
  renderGrid(state.items);
  dom.btnMore.disabled = !state.hasMore;
  dom.listFooter.hidden = !state.hasMore && !dom.footerNote.textContent;

  autoTranslateItems(state.items);
  if (state.sort === 'downloads') applyDownloads();
  refreshCacheStats();
}

function renderGrid(items) {
  if (!items.length) {
    dom.grid.innerHTML = '';
    dom.empty.hidden = false;
    if (state.view === 'favorites') {
      dom.emptyDesc.textContent = '还没有收藏。在列表或详情页点击 ❤ 即可收藏。';
    } else if (state.view === 'likes') {
      dom.emptyDesc.textContent = '还没有点赞。点击 👍 记录你觉得好用的项目。';
    } else if (state.growth7 || state.growth30) {
      dom.emptyDesc.textContent =
        '当前增速阈值下没有匹配的仓库：可以调低阈值；增速需要 GitHub Token 才能立即采样，未填写时需积累本机每日快照历史（可在设置里填 Token 后用「刷新」重试）。';
    } else if (state.activeTag) {
      dom.emptyDesc.textContent = `标签「${state.activeTag.label}」下暂时没有结果，可以换个标签，或切换到「内置精选」看看。`;
    } else {
      dom.emptyDesc.textContent = '换个分类、关键词或语言再试试。';
    }
    return;
  }
  dom.empty.hidden = true;
  dom.grid.innerHTML = items.map(cardHtml).join('');
}

/**
 * 增速徽标：有数据时显示「7 日 +N / 30 日 +N」，并说明数据来源。
 * 采样上限（最近一页星标都落在窗口内）时用「≥」表示。
 */
function growthHtml(growth) {
  if (!growth) return '';
  const pill = (days, value, capped) => {
    if (value == null) return '';
    const badge = `${capped ? '≥' : '+'}${formatNum(value)}`;
    const source =
      growth.source === 'token'
        ? '按最近一页星标采样（最多 100 条）'
        : `按本机历史快照估算${growth[`days${days}`] ? `（覆盖 ${growth[`days${days}`]} 天）` : ''}`;
    return `<span class="growth-pill" title="近 ${days} 日新增 Star：${source}">${days} 日 ${badge}</span>`;
  };
  return `${pill(7, growth.growth7, growth.capped7)}${pill(30, growth.growth30, growth.capped30)}`;
}

function cardHtml(repo) {
  const desc = repo.zhDesc || repo.description || '（该仓库暂无简介）';
  const isZh = Boolean(repo.zhDesc);
  // 优先显示中文标签（可点击按标签搜索），没有标签时退回 GitHub topics
  const repoTags = Array.isArray(repo.tags) && repo.tags.length
    ? repo.tags.slice(0, 4).map((t) => `<button class="tag tag-btn" data-act="tag" data-tag="${esc(t)}" title="按标签「${esc(t)}」搜索">${esc(t)}</button>`)
    : (repo.topics || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`);
  const tags = repoTags.join('');
  const downloads =
    repo.downloads != null
      ? `<span class="metric" title="最近 10 个 Release 附件累计下载次数">⬇ <strong>${formatNum(repo.downloads)}</strong></span>`
      : `<span class="metric" title="切换到「下载量最高」排序时会自动统计">⬇ <strong>—</strong></span>`;
  const avatar = repo.ownerAvatar || `https://github.com/${repo.owner}.png?size=64`;
  return `<article class="card" data-full="${esc(repo.fullName)}">
    <div class="card-head">
      <img class="avatar" src="${esc(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="card-title">
        <div class="repo-name">${esc(repo.name)}${isZh ? '<span class="zh-badge">中文</span>' : ''}</div>
        <div class="repo-owner">${esc(repo.owner)}${repo.zhName ? ` · ${esc(repo.zhName)}` : ''}</div>
      </div>
      <span class="star-pill" title="GitHub Star 数">★ ${formatNum(repo.stars)}</span>
    </div>
    <div class="card-desc${isZh ? '' : ' original'}${repo._translating ? ' translating' : ''}" data-desc="${esc(repo.fullName)}">
      ${repo._translating ? '正在汉化简介…' : esc(desc)}
    </div>
    <div class="desc-tools">${descToolsHtml(repo)}</div>
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    <div class="card-foot">
      ${growthHtml(repo.growth)}
      ${downloads}
      <span class="metric"><span class="lang-dot" style="background:${langColor(repo.language)}"></span>${esc(repo.language || '未知')}</span>
      <div class="card-actions">
        <button class="mini-btn${repo.favorited ? ' on' : ''}" data-act="fav" title="收藏/取消收藏">${ICON_HEART}</button>
        <button class="mini-btn like${repo.liked ? ' on' : ''}" data-act="like" title="点赞/取消点赞">${ICON_THUMB}</button>
        <button class="link-btn" data-act="open" title="在浏览器打开 GitHub 原站">原站</button>
      </div>
    </div>
  </article>`;
}

async function handleCardAction(action, repo, btn) {
  if (action === 'open') {
    api.openExternal(repo.htmlUrl);
    return;
  }
  if (action === 'tag') {
    applyTagSearch(btn && btn.dataset.tag ? btn.dataset.tag : '');
    return;
  }
  if (action === 'zh-desc') {
    translateOneDescription(repo);
    return;
  }
  if (action !== 'fav' && action !== 'like') return;
  const kind = action === 'fav' ? 'favorite' : 'like';
  const res = await api.toggle({ kind, repo });
  if (res.error) {
    toast(res.error, 'err');
    return;
  }
  const nowOn = kind === 'favorite' ? res.favorited : res.liked;
  repo.favorited = kind === 'favorite' ? nowOn : state.library.favorites.some((r) => r.fullName === repo.fullName);
  repo.liked = kind === 'like' ? nowOn : state.library.likes.some((r) => r.fullName === repo.fullName);
  state.library.favorites = res.favorites || state.library.favorites;
  state.library.likes = res.likes || state.library.likes;
  updateLibraryCounts();
  renderHead();

  if (btn) {
    btn.classList.toggle('on', nowOn);
  }
  // 同步卡片与详情页按钮
  const cardBtn = dom.grid.querySelector(`.card[data-full="${cssEscape(repo.fullName)}"] [data-act="${action}"]`);
  if (cardBtn) cardBtn.classList.toggle('on', nowOn);
  const drawerBtn = dom.drawerBody.querySelector(`[data-act="${action}"]`);
  if (drawerBtn) {
    drawerBtn.classList.toggle('on', nowOn);
    const label = drawerBtn.querySelector('.act-label');
    if (label) {
      label.textContent =
        kind === 'favorite' ? (nowOn ? '已收藏' : '收藏') : nowOn ? '已点赞' : '点赞';
    }
  }

  toast(kind === 'favorite' ? (nowOn ? '已加入收藏' : '已取消收藏') : nowOn ? '已点赞' : '已取消点赞', 'ok');

  if (state.view === 'favorites' && kind === 'favorite' && !nowOn) {
    state.items = state.items.filter((r) => r.fullName !== repo.fullName);
    renderGrid(state.items);
  }
  if (state.view === 'likes' && kind === 'like' && !nowOn) {
    state.items = state.items.filter((r) => r.fullName !== repo.fullName);
    renderGrid(state.items);
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ---------------- 简介自动汉化 ---------------- */

async function autoTranslateItems(items) {
  if (!state.settings.autoTranslate || state.settings.translationProvider === 'off') return;
  if (state.source !== 'online') return;
  const candidates = items.filter((r) => !r.zhDesc && r.description && !r._translating);
  if (!candidates.length) return;

  // 额度熔断：刚失败过（如免费额度用完）时不再自动反复请求，保留手动重试入口
  if (state.zhFatalAt && Date.now() - state.zhFatalAt < 10 * 60 * 1000) {
    candidates.forEach((r) => {
      r.zhError = state.zhFatalError || '翻译接口暂时不可用';
    });
    updateDescNodes(candidates);
    return;
  }

  const pending = candidates;
  pending.forEach((r) => {
    r._translating = true;
  });
  updateDescNodes(pending);

  const res = await api.translateDescriptions(
    pending.map(({ fullName, description }) => ({ fullName, description })),
  );
  const map = (res && res.items) || {};
  for (const repo of pending) {
    repo._translating = false;
    const hit = map[repo.fullName];
    if (hit && hit.zhDesc) {
      repo.zhDesc = hit.zhDesc;
      repo.zhPartial = Boolean(hit.partial) || Boolean(hit.offline);
      repo.zhSource = hit.engine;
      repo.zhError = '';
    } else {
      repo.zhError = (res && res.error) || '翻译接口没有返回结果';
    }
  }
  updateDescNodes(pending);

  if (res && res.error) {
    if (res.fatal) {
      state.zhFatalAt = Date.now();
      state.zhFatalError = res.error;
      showNotice(
        `简介汉化未完成：${esc(res.error)}<br>可以点击卡片上的「汉化简介」单条重试，或到 <button class="link-btn" data-act="open-settings">设置</button> 切换为 AI 翻译（质量最好、无每日额度限制）；也可以先用「内置精选」浏览人工整理的中文简介。`,
        'error',
      );
      if (state.zhErrorShown !== res.error) {
        state.zhErrorShown = res.error;
        toast(`简介汉化失败：${res.error}`, 'err');
      }
    } else if (res.failed) {
      if (state.zhErrorShown !== res.error) {
        state.zhErrorShown = res.error || 'partial';
        toast(`有 ${res.failed} 个简介没能汉化，可点击卡片上的「汉化简介」重试`, 'err');
      }
    }
  }
}

function descToolsHtml(repo) {
  if (repo._translating) return '<span class="zh-badge">汉化中…</span>';
  if (repo.zhDesc) {
    return repo.zhPartial
      ? '<span class="zh-badge partial" title="离线术语表只替换了部分技术名词，可在设置里切换 AI 翻译获得完整中文">术语汉化</span>'
      : '';
  }
  if (!repo.description) return '';
  const title = repo.zhError ? esc(repo.zhError) : '汉化这段外语简介';
  return `<button class="link-btn zh-btn" data-act="zh-desc" title="${title}">汉化简介</button>${
    repo.zhError ? '<span class="zh-badge err" title="自动汉化失败，可点左侧按钮重试">未汉化</span>' : ''
  }`;
}

function updateDescNodes(items) {
  for (const repo of items) {
    const node = dom.grid.querySelector(`[data-desc="${cssEscape(repo.fullName)}"]`);
    if (!node) continue;
    const card = node.closest('.card');
    node.classList.remove('original', 'translating');
    if (repo._translating) {
      node.textContent = '正在汉化简介…';
      node.classList.add('translating');
    } else if (repo.zhDesc) {
      node.textContent = repo.zhDesc;
      const nameNode = card && card.querySelector('.repo-name');
      if (nameNode && !nameNode.querySelector('.zh-badge')) {
        nameNode.insertAdjacentHTML('beforeend', '<span class="zh-badge">中文</span>');
      }
    } else {
      node.textContent = repo.description || '（该仓库暂无简介）';
      node.classList.add('original');
    }
    const tools = card && card.querySelector('.desc-tools');
    if (tools) tools.innerHTML = descToolsHtml(repo);
  }
}

/**
 * 手动汉化单个简介（自动汉化失败时的补救入口）。
 */
async function translateOneDescription(repo) {
  if (!repo || !repo.description || repo._translating) return;
  repo._translating = true;
  repo.zhError = '';
  updateDescNodes([repo]);
  const res = await api.translateText({ text: repo.description });
  repo._translating = false;
  if (res && res.text && res.text !== repo.description) {
    repo.zhDesc = res.text;
    repo.zhPartial = Boolean(res.partial);
    repo.zhSource = res.engine;
    repo.zhError = '';
  } else {
    repo.zhError = (res && res.error) || '翻译接口没有返回中文结果';
    toast(`汉化失败：${repo.zhError}`, 'err');
  }
  updateDescNodes([repo]);
}

/* ---------------- 下载量排序 ---------------- */

async function applyDownloads() {
  const pending = state.items.filter((r) => r.downloads == null).slice(0, 24);
  if (!pending.length) {
    sortByDownloads();
    return;
  }
  dom.footerNote.textContent = '正在统计 Release 下载量…';
  const res = await api.downloads({ fullNames: pending.map((r) => r.fullName) });
  if (res.rate) {
    state.rate = res.rate;
    updateRateUi();
  }
  const counts = res.counts || {};
  for (const repo of state.items) {
    const c = counts[repo.fullName];
    if (c && c.downloads != null) repo.downloads = c.downloads;
  }
  if (res.error) {
    toast(`下载量统计失败：${res.error}`, 'err');
  }
  sortByDownloads();
  dom.footerNote.textContent = '下载量为最近 10 个 Release 附件累计下载次数（GitHub 不提供全站下载量排序）';
}

function sortByDownloads() {
  state.items.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  renderGrid(state.items);
}

/* ---------------- 详情与预览 ---------------- */

function closeDrawer() {
  dom.drawer.hidden = true;
  state.detailToken += 1;
  state.readmeToken += 1;
  state.detailRepo = null;
}

async function openDetail(repo) {
  state.detailRepo = { ...repo };
  state.readme = { en: '', zh: null, mode: 'en', loadingTranslation: false };
  const token = ++state.detailToken;
  dom.drawer.hidden = false;
  dom.drawerAvatar.src = repo.ownerAvatar || `https://github.com/${repo.owner}.png?size=64`;
  dom.drawerName.textContent = repo.name;
  dom.drawerOwner.textContent = `@${repo.owner}`;
  dom.drawerBody.innerHTML = '<div class="detail-loading">正在加载仓库详情…</div>';

  const detail = await api.detail({ fullName: repo.fullName });
  if (token !== state.detailToken) return;
  if (detail.error) {
    const hint = /额度|rate limit/i.test(detail.error)
      ? '<br>可在右上角「设置」里填入 GitHub Personal Access Token（额度提升到每小时 5000 次）后重试，或先用「内置精选」离线浏览。'
      : '';
    dom.drawerBody.innerHTML = `<div class="detail-loading">详情加载失败：${esc(detail.error)}${hint}</div>`;
    return;
  }
  if (detail.rate) {
    state.rate = detail.rate;
    updateRateUi();
  }
  const full = detail.repo;
  state.detailRepo = { ...state.detailRepo, ...full, zhDesc: detail.zh?.zhDesc || state.detailRepo.zhDesc };
  renderDetail(full, detail);
  loadReadme(full, token);
}

function renderDetail(repo, detail) {
  const zhDesc =
    (detail.zh && detail.zh.zhDesc) ||
    repo.zhDesc ||
    (state.detailRepo && state.detailRepo.zhDesc) ||
    '';
  const downloads = detail.downloads ? detail.downloads.downloads : repo.downloads;
  const downloadsText =
    detail.downloads && detail.downloads.releaseCount === 0
      ? '无 Release'
      : downloads != null
        ? formatNum(downloads)
        : '—';
  const zhTags = (Array.isArray(repo.tags) ? repo.tags : [])
    .map((t) => `<button class="tag tag-btn" data-act="tag" data-tag="${esc(t)}" title="按标签「${esc(t)}」搜索">${esc(t)}</button>`)
    .join('');
  const tags = (repo.topics || []).slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const langList = Object.entries(detail.languages || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([lang]) => `<span class="tag"><span class="lang-dot" style="background:${langColor(lang)}"></span>${esc(lang)}</span>`)
    .join('');
  const descBlock = zhDesc
    ? `<p class="detail-desc">${esc(zhDesc)}</p>${
        repo.description ? `<p class="detail-desc-original">原文：${esc(repo.description)}</p>` : ''
      }`
    : `<p class="detail-desc">${esc(repo.description || '（该仓库暂无简介）')}</p>`;

  dom.drawerBody.innerHTML = `
    <div class="detail-top">
      <div style="flex:1">
        ${descBlock}
        ${!zhDesc && repo.description ? '<button class="btn-ghost" data-act="translate-desc">汉化这段简介</button>' : ''}
      </div>
    </div>
    <div class="detail-stats">
      <div class="stat"><div class="k">Star</div><div class="v">★ ${formatNum(repo.stars)}</div></div>
      <div class="stat"><div class="k">Fork</div><div class="v">${formatNum(repo.forks)}</div></div>
      <div class="stat"><div class="k">下载量（Release）</div><div class="v">${downloadsText}</div></div>
      <div class="stat"><div class="k">主语言</div><div class="v">${esc(repo.language || '未知')}</div></div>
      <div class="stat"><div class="k">最近更新</div><div class="v">${formatDate(repo.pushedAt || repo.updatedAt)}</div></div>
      <div class="stat"><div class="k">许可证</div><div class="v">${esc(repo.license || '未标注')}</div></div>
    </div>
    <div class="detail-tags">${zhTags}${tags}${langList}</div>
    <div class="detail-actions">
      <button class="btn-ghost${repo.favorited ? ' on' : ''}" data-act="fav">${ICON_HEART}<span class="act-label">${repo.favorited ? '已收藏' : '收藏'}</span></button>
      <button class="btn-ghost like${repo.liked ? ' on' : ''}" data-act="like">${ICON_THUMB}<span class="act-label">${repo.liked ? '已点赞' : '点赞'}</span></button>
      <button class="btn-primary" data-act="open">打开原站</button>
      <button class="btn-ghost" data-act="copy">复制链接</button>
      ${repo.homepage ? '<button class="btn-ghost" data-act="homepage">项目主页</button>' : ''}
    </div>
    <div class="detail-url">原站地址：<a href="${esc(repo.htmlUrl)}">${esc(repo.htmlUrl)}</a></div>
    <div class="drawer-tabs">
      <button class="tab-btn active" data-act="readme-en">原文</button>
      <button class="tab-btn" data-act="readme-zh">中文预览</button>
      <span class="tab-spacer"></span>
      <button class="btn-ghost" data-act="readme-retranslate">重新汉化</button>
    </div>
    <div class="engine-note" id="readmeNote">正在读取 README…</div>
    <div class="readme" id="readmeBox"></div>
  `;

  // 更新头部与收藏状态
  dom.drawerName.textContent = repo.name;
  dom.drawerOwner.textContent = `@${repo.owner}${repo.zhName ? ` · ${repo.zhName}` : ''}`;
  state.detailRepo = { ...repo, zhDesc };
}

function renderReadmeNote(text) {
  const note = el('readmeNote');
  if (note) note.innerHTML = text;
}

function setReadmeMode(mode) {
  if (mode === 'zh' && !state.readme.zh) {
    if (state.readme.en) {
      translateReadme({ force: false });
      toast('还没有中文版本，正在开始汉化…');
    }
    return;
  }
  state.readme.mode = mode;
  const box = el('readmeBox');
  if (!box) return;
  const tabs = dom.drawerBody.querySelectorAll('.tab-btn');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.act === `readme-${mode}`));
  const markdown = mode === 'zh' ? state.readme.zh && state.readme.zh.markdown : state.readme.en;
  box.innerHTML = renderMarkdownHtml(markdown);
  const zhInfo = state.readme.zh || {};
  const fromLang = zhInfo.sourceLabel && zhInfo.sourceLang !== 'zh' ? `（${zhInfo.sourceLabel} → 中文）` : '';
  renderReadmeNote(
    mode === 'zh'
      ? `中文由「${engineName(state.readme.zh)}」自动汉化${fromLang}${zhInfo.note ? `：${esc(zhInfo.note)}` : ''}${zhInfo.truncated ? '（超长 README 只汉化了前半部分）' : ''}`
      : '这是 README 原文，点击「中文预览」可切换汉化版本。',
  );
}

function engineName(result) {
  if (!result) return '翻译引擎';
  if (result.engine === 'openai') return 'AI 翻译';
  if (result.engine === 'zhipu') return '智谱 GLM';
  if (result.engine === 'baidu') return '百度翻译';
  if (result.engine === 'youdao') return '有道翻译';
  if (result.engine === 'mymemory') return 'MyMemory 免费翻译';
  if (result.engine === 'offline') return '离线术语表';
  return '翻译引擎';
}

function renderMarkdownHtml(markdown) {
  if (!markdown) return '<p class="detail-loading">该仓库没有 README，或读取失败。</p>';
  try {
    const html = marked.parse(markdown, { gfm: true, breaks: false });
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button'],
      FORBID_ATTR: ['style', 'onerror', 'onload'],
      ALLOW_DATA_ATTR: false,
    });
  } catch (err) {
    return `<pre>${esc(markdown.slice(0, 4000))}</pre>`;
  }
}

async function loadReadme(repo, token) {
  const rToken = ++state.readmeToken;
  const data = await api.readme({ fullName: repo.fullName });
  if (token !== state.detailToken || rToken !== state.readmeToken) return;
  if (data.rate) {
    state.rate = data.rate;
    updateRateUi();
  }
  if (data.error) {
    renderReadmeNote(`README 读取失败：${esc(data.error)}`);
    return;
  }
  if (!data.hasReadme) {
    renderReadmeNote('该仓库没有 README 文件。');
    el('readmeBox').innerHTML = '';
    return;
  }
  state.readme.en = data.markdown;
  setReadmeMode('en');

  // 自动汉化 README：AI 翻译没有额度限制，整篇翻译；
  // MyMemory 免费额度有限（自动模式先翻前 2500 字符），百度按字符计费（先翻前 5000 字符），
  // 剩余内容都可手动「重新汉化」。
  const provider = state.settings.translationProvider;
  const auto = state.settings.autoTranslateReadme !== false;
  const cooling = state.zhFatalAt && Date.now() - state.zhFatalAt < 10 * 60 * 1000;
  if (provider === 'off') {
    renderReadmeNote(
      'README 已加载（原文）。当前是「离线术语表」模式，只翻译标题与术语；在设置里切换在线引擎可汉化全部正文。',
    );
  } else if (!auto) {
    renderReadmeNote(
      'README 已加载（原文）。自动汉化已在设置中关闭，点击「中文预览」即可手动汉化。',
    );
    return;
  } else if (cooling) {
    // 刚失败过（多半是免费额度用完），暂停自动汉化，避免反复空跑
    renderReadmeNote(
      `README 已加载（原文）。翻译接口刚才失败过：${esc(state.zhFatalError || '额度不足')}，已暂停自动汉化。<br>点「重新汉化」可重试，或到「设置」切换为 AI 翻译。`,
    );
    return;
  } else {
    renderReadmeNote('README 已加载（原文）。正在后台自动汉化…');
    translateReadme({ force: false, auto: true });
  }
}

async function translateReadme({ force = false, auto = false } = {}) {
  const repo = state.detailRepo;
  if (!repo || !state.readme.en) return;
  if (state.readme.loadingTranslation) return;
  const token = state.readmeToken;
  const provider = state.settings.translationProvider;
  // 免费 / 按字符计费的引擎额度紧张：自动模式只翻一部分，手动点击则整篇翻译
  const paid = provider === 'baidu' || provider === 'youdao';
  // AI 类（OpenAI 兼容 / 智谱）没有每日额度，自动模式也整篇翻译
  const ai = provider === 'openai' || provider === 'zhipu';
  const maxChars = !auto || ai ? undefined : paid ? 5000 : 2500;
  state.readme.loadingTranslation = true;
  renderReadmeNote(
    maxChars
      ? `正在汉化 README 前 ${maxChars} 个字符…（${paid ? `${provider === 'baidu' ? '百度' : '有道'}按字符计费` : '免费额度有限'}，可稍后手动翻完整篇）`
      : '正在汉化 README…（可先阅读原文）',
  );
  const res = await api.translateReadme({
    fullName: repo.fullName,
    markdown: state.readme.en,
    force,
    maxChars,
  });
  if (token !== state.readmeToken) return;
  state.readme.loadingTranslation = false;
  if (res.error) {
    renderReadmeNote(
      `汉化失败：${esc(res.error)}<br>可以先阅读原文；到「设置」切换为 AI 翻译、智谱 GLM、百度或有道翻译后点「重新汉化」即可。`,
    );
    return;
  }
  state.readme.zh = res;
  // 在线翻译失败会退回离线术语表（几乎还是原文），此时不自动切到「中文预览」
  if (!res.degraded && (state.readme.mode === 'zh' || state.readme.mode === 'en')) {
    setReadmeMode('zh');
  }
  if (res.degraded && /额度|quota|429|rate limit/i.test(res.note || '')) {
    state.zhFatalAt = Date.now();
    state.zhFatalError = res.note;
  }
  const fromLang = res.sourceLabel && res.sourceLang !== 'zh' ? `${res.sourceLabel} → 中文` : '';
  if (res.degraded) {
    renderReadmeNote(`汉化未能完成：${esc(res.note || '在线翻译失败')}`);
    return;
  }
  if (res.markdown) {
    const parts = [fromLang, engineName(res)].filter(Boolean).join(' · ');
    toast(`README 已汉化（${parts}）`, 'ok');
    if (res.truncated) {
      renderReadmeNote(
        `已汉化 README 的前 ${res.translatedLines || 0} 段（免费额度有限，未覆盖的段落保留原文）。点「重新汉化」会整篇重译（更耗免费额度），或在「设置」切换 AI 翻译。`,
      );
    }
  }
}

async function retranslateReadme() {
  if (!state.readme.en) {
    toast('还没有可翻译的 README');
    return;
  }
  state.readme.zh = null;
  await translateReadme({ force: true });
}

async function translateDetailDesc() {
  const repo = state.detailRepo;
  if (!repo || !repo.description) return;
  const res = await api.translateText({ text: repo.description });
  if (res && res.text && res.text !== repo.description) {
    repo.zhDesc = res.text;
    toast(`简介已汉化（${engineName(res)}）`, 'ok');
    dom.drawerBody.querySelector('.detail-top').innerHTML = `<div style="flex:1">
      <p class="detail-desc">${esc(res.text)}</p>
      <p class="detail-desc-original">原文：${esc(repo.description)}</p>
    </div>`;
    const card = state.items.find((r) => r.fullName === repo.fullName);
    if (card) {
      card.zhDesc = res.text;
      updateDescNodes([card]);
    }
  } else {
    toast('汉化失败或没有变化', 'err');
  }
}

/* ---------------- 设置 ---------------- */

/**
 * 汉化引擎按需显示：下拉框选中哪个引擎，就只展开该引擎的配置面板。
 */
function syncEnginePanels(provider) {
  const current = provider || 'mymemory';
  document.querySelectorAll('.engine-panel').forEach((panel) => {
    panel.hidden = panel.dataset.engine !== current;
  });
}

async function openSettings() {
  const s = await api.getSettings();
  el('inputToken').value = s.githubToken || '';
  el('inputProvider').value = s.translationProvider || 'mymemory';
  el('inputAutoTranslate').checked = Boolean(s.autoTranslate);
  el('inputAutoReadme').checked = s.autoTranslateReadme !== false;
  el('inputEmail').value = s.myMemoryEmail || '';
  el('inputBaseUrl').value = s.openaiBaseUrl || '';
  el('inputModel').value = s.openaiModel || '';
  el('inputApiKey').value = s.openaiApiKey || '';
  el('inputZhipuApiKey').value = s.zhipuApiKey || '';
  el('inputZhipuModel').value = s.zhipuModel || 'glm-4.6v-flash';
  el('inputBaiduAppId').value = s.baiduAppId || '';
  el('inputBaiduKey').value = s.baiduKey || '';
  el('inputYoudaoAppKey').value = s.youdaoAppKey || '';
  el('inputYoudaoSecret').value = s.youdaoAppSecret || '';
  syncEnginePanels(s.translationProvider);
  const stats = await api.cacheStats().catch(() => ({ files: 0 }));
  el('cacheStatsText').textContent = `缓存文件：${stats.files}`;
  dom.settingsModal.hidden = false;
}

function closeSettings() {
  dom.settingsModal.hidden = true;
}

async function saveSettings() {
  const patch = {
    githubToken: el('inputToken').value.trim(),
    translationProvider: el('inputProvider').value,
    autoTranslate: el('inputAutoTranslate').checked,
    autoTranslateReadme: el('inputAutoReadme').checked,
    myMemoryEmail: el('inputEmail').value.trim(),
    openaiBaseUrl: el('inputBaseUrl').value.trim() || 'https://api.openai.com/v1',
    openaiModel: el('inputModel').value.trim() || 'gpt-4o-mini',
    openaiApiKey: el('inputApiKey').value.trim(),
    zhipuApiKey: el('inputZhipuApiKey').value.trim(),
    zhipuModel: el('inputZhipuModel').value.trim() || 'glm-4.6v-flash',
    baiduAppId: el('inputBaiduAppId').value.trim(),
    baiduKey: el('inputBaiduKey').value.trim(),
    youdaoAppKey: el('inputYoudaoAppKey').value.trim(),
    youdaoAppSecret: el('inputYoudaoSecret').value.trim(),
  };
  const res = await api.saveSettings(patch);
  if (res.rate) {
    state.rate = res.rate;
    updateRateUi();
  }
  const saved = res.settings || {};
  state.settings = {
    ...state.settings,
    ...saved,
    hasGithubToken: Boolean(saved.githubToken),
    hasOpenaiKey: Boolean(saved.openaiApiKey),
    hasZhipuKey: Boolean(saved.zhipuApiKey),
    hasBaiduKey: Boolean(saved.baiduAppId && saved.baiduKey),
    hasYoudaoKey: Boolean(saved.youdaoAppKey && saved.youdaoAppSecret),
  };
  updateTranslateUi();
  renderSetupTip();
  closeSettings();
  toast('设置已保存', 'ok');
  // 换引擎 / 填了 Key 后清除「额度熔断」，让新配置立刻生效
  state.zhFatalAt = 0;
  state.zhFatalError = '';
  state.zhErrorShown = '';
  state.forceNext = true;
  load({ reset: true });
}

/* ---------------- 启动 ---------------- */

init().catch((err) => {
  console.error(err);
  showNotice(`初始化失败：${esc(err.message)}`, 'error');
});

// 关于入口
el('btnSettings').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  dom.aboutModal.hidden = false;
});
