/**
 * StarHub 主进程：窗口、IPC、数据聚合（分类 / 排序 / 预览 / 汉化 / 收藏点赞）。
 */
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { DiskCache } = require('./cache');
const { GithubApi, GithubError } = require('./github');
const { Translator } = require('./translate');
const { StarHistory } = require('./star-history');
const curated = require('./curated');
const { CATEGORIES, TOP_CATEGORY, SORTS, LANGUAGES, LANG_COLORS } = require('../shared/categories');
const { buildTags, findTag, listTags } = require('../shared/tags');

app.setName('StarHub');
if (process.platform === 'win32') app.setAppUserModelId('com.starhub.desktop');

// 数据目录：可用 STARHUB_USER_DATA 显式指定；
// 自检（--smoke / --preview）默认写入工程内的临时目录，避免污染真实的 %APPDATA%\StarHub
const appRoot = path.join(__dirname, '..', '..');
const isSelfCheck = process.argv.includes('--smoke') || process.argv.includes('--preview');
if (process.env.STARHUB_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STARHUB_USER_DATA));
} else if (isSelfCheck) {
  app.setPath('userData', path.join(appRoot, '.userdata-smoke'));
}

let mainWindow = null;
let store = null;
let cache = null;
let api = null;
let translator = null;
let starHistory = null;

function allCategories() {
  return [TOP_CATEGORY, ...CATEGORIES];
}

function initServices() {
  const userData = app.getPath('userData');
  store = new Store(userData);
  cache = new DiskCache(path.join(userData, 'cache'), { maxFiles: 4000 });
  api = new GithubApi({ cache, store });
  translator = new Translator({ cache, store });
  starHistory = new StarHistory(userData);
}

function decorate(repo) {
  if (!repo) return repo;
  const zh = curated.zhInfo(repo.fullName);
  const downloadsHit = cache.get(`gh:downloads:${repo.fullName}:10`);
  const withZh = {
    ...repo,
    zhName: repo.zhName || (zh && zh.zhName) || '',
    zhDesc: repo.zhDesc || (zh && zh.zhDesc) || '',
    category: repo.category || (zh && zh.category) || '',
  };
  return {
    ...withZh,
    tags: repo.tags && repo.tags.length ? repo.tags : buildTags(withZh),
    downloads: repo.downloads != null ? repo.downloads : downloadsHit ? downloadsHit.downloads : null,
    favorited: store.isFavorite(repo.fullName),
    liked: store.isLiked(repo.fullName),
  };
}

function categoryFor(id) {
  if (!id) return TOP_CATEGORY;
  return allCategories().find((c) => c.id === id) || TOP_CATEGORY;
}

function oneYearAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function onlineQuery(params) {
  const { categoryId, keyword, tag, sort, language, minStars } = params;
  const category = categoryFor(categoryId);
  const parts = [];
  if (tag) {
    // 标签搜索：直接用标签自带的 GitHub 查询条件
    parts.push(tag.query);
  } else if (keyword) {
    parts.push(keyword);
  } else {
    parts.push(category.query);
  }
  if (language && language !== 'all') parts.push(`language:${language}`);
  if (minStars) parts.push(`stars:>${minStars}`);
  if (sort === 'new') parts.push(`created:>${oneYearAgo()}`);
  return parts.join(' ');
}

function alphaCompare(a, b) {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

function sortSpec(sort) {
  return SORTS.find((s) => s.id === sort) || SORTS[0];
}

function attachLocalState(items) {
  return items.map((item) => ({
    ...item,
    favorited: store.isFavorite(item.fullName),
    liked: store.isLiked(item.fullName),
  }));
}

/* ---------------- Star 增速（近 7 日 / 近 30 日） ---------------- */

const GROWTH_WORKERS = 3;

/**
 * 取一组仓库的增速：
 *   1) 有 GitHub Token 时优先按星标时间采样（立即可用，每仓库 1 次请求，缓存 6 小时）
 *   2) 没有 Token（或采样失败）时退回本机每日快照
 */
async function collectGrowth(items, { sample = true } = {}) {
  const out = {};
  if (!items.length) return out;
  const hasToken = Boolean((store.getSettings().githubToken || '').trim());
  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      const repo = queue.shift();
      let best = null;
      if (sample && hasToken) {
        try {
          const sampled = await api.getStarGrowth(repo.fullName, repo.stars);
          if (sampled && sampled.available) best = sampled;
        } catch (_) {
          /* 采样失败时退回本机快照 */
        }
      }
      if (!best) {
        const snap = starHistory.growth(repo.fullName, repo.stars);
        if (snap && snap.available) best = snap;
      }
      out[repo.fullName] = best;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GROWTH_WORKERS, queue.length) }, () => worker()),
  );
  return out;
}

function growthMatches(growth, growth7, growth30) {
  if (!growth) return false;
  const pass7 = !growth7 || (Number(growth.growth7) || 0) >= growth7;
  const pass30 = !growth30 || (Number(growth.growth30) || 0) >= growth30;
  return pass7 && pass30;
}

function growthFiltersNote(growth7, growth30, { hasToken, missing, total }) {
  if (!growth7 && !growth30) return '';
  const window = [growth7 ? `近 7 日 ≥ ${growth7}` : '', growth30 ? `近 30 日 ≥ ${growth30}` : '']
    .filter(Boolean)
    .join(' 且 ');
  const parts = [`Star 增速筛选（${window}）`];
  if (missing) {
    parts.push(
      hasToken
        ? `${missing}/${total} 个仓库暂时取不到增速（接口失败或超出采样上限），已从结果中排除`
        : `${missing}/${total} 个仓库没有历史数据：GitHub 匿名接口不提供星标时间，可在设置里填写 Token 立即采样，或保持使用一段时间让本机每日快照积累历史`,
    );
  }
  if (hasToken) parts.push('增速按最近一页星标（最多 100 条）采样，超过 100 显示为 ≥100');
  return parts.join(' · ');
}

async function listRepos(params = {}) {
  const {
    source = 'online',
    categoryId = 'top',
    keyword = '',
    sort = 'stars',
    language = 'all',
    minStars = 0,
    growth7 = 0,
    growth30 = 0,
    page = 1,
    pageSize = 24,
    force = false,
  } = params;

  // 标签搜索：搜索框里输入中文标签名或英文别名即可命中标签
  const kw = (keyword || '').trim();
  const tagHit = kw ? findTag(kw) : null;
  const tag = tagHit ? tagHit.tag : null;
  const tagInfo = tag
    ? { id: tag.id, label: tag.label, kind: tag.kind, desc: tag.desc, exact: tagHit.exact }
    : null;

  if (source === 'curated') {
    const data = curated.list({
      category: categoryId === 'top' ? 'all' : categoryId,
      // 命中标签时以标签为准（标签已包含含义，不再做关键词模糊匹配）
      keyword: tag ? '' : kw,
      tag: tag ? tag.label : '',
      sort,
      page,
      pageSize,
    });
    let items = data.items;
    if (language && language !== 'all') items = items.filter((r) => r.language === language);
    if (minStars) items = items.filter((r) => r.stars >= minStars);
    const notes = [`内置精选库（${curated.totalCount} 个仓库，中文资料人工整理，Star 数为离线快照）`];
    if (tag) notes.push(`标签「${tag.label}」命中 ${data.total} 个仓库`);
    if (sort === 'alpha') notes.push('按仓库名首字母 A→Z 排列');
    let growth = {};
    if (growth7 || growth30) {
      // 内置库的 Star 是离线快照，不能当作「当前值」写进历史，只用已有快照估算
      growth = await collectGrowth(items, { sample: false });
      const total = items.length;
      const missing = items.filter((r) => !growth[r.fullName]).length;
      items = items.filter((r) => growthMatches(growth[r.fullName], growth7, growth30));
      notes.push(
        growthFiltersNote(growth7, growth30, { hasToken: false, missing, total }).replace(
          'Star 增速筛选',
          '内置库 Star 增速筛选',
        ),
      );
    }
    return {
      ...data,
      items: attachLocalState(
        items.map((r) => ({ ...decorate(r), growth: growth[r.fullName] || null })),
      ),
      source: 'curated',
      query: '',
      tag: tagInfo,
      rate: api.getRateLimit(),
      note: notes.filter(Boolean).join(' · '),
    };
  }

  const q = onlineQuery({ categoryId, keyword: kw, tag, sort, language, minStars });
  const spec = sortSpec(sort);
  const alpha = sort === 'alpha';
  // 首字母排序无法由 GitHub 接口完成：先拉一批（最多 100）再本地按仓库名排序
  const search = await api.search({
    q,
    sort: spec.api.sort,
    order: spec.api.order,
    page: alpha ? 1 : page,
    perPage: alpha ? 100 : pageSize,
    force,
  });

  let list = search.items;
  let hasMore = search.items.length === pageSize && page * pageSize < Math.min(search.total, 1000);
  if (alpha) {
    const start = (page - 1) * pageSize;
    list = search.items.slice().sort(alphaCompare).slice(start, start + pageSize);
    hasMore = start + pageSize < search.items.length;
  }

  // 记录当天的 Star 快照（本机历史，供没有 Token 时估算增速）
  starHistory.recordMany(search.items);

  const notes = [];
  if (tag) notes.push(tagHit.exact ? `标签「${tag.label}」：${tag.desc}` : `按标签「${tag.label}」搜索（${tag.desc}）`);
  if (spec.postSort === 'downloads') {
    notes.push('GitHub 不提供全站下载量排序：这里先取 Star 最高的仓库，再按 Release 附件下载量排序');
  }
  if (alpha) notes.push(`首字母排序基于 Star 最高的 ${search.items.length} 个结果，按仓库名 A→Z 排列`);

  let growth = {};
  if (growth7 || growth30) {
    growth = await collectGrowth(list);
    const total = list.length;
    const hasToken = Boolean((store.getSettings().githubToken || '').trim());
    const missing = list.filter((r) => !growth[r.fullName]).length;
    list = list.filter((r) => growthMatches(growth[r.fullName], growth7, growth30));
    notes.push(growthFiltersNote(growth7, growth30, { hasToken, missing, total }));
  }

  return {
    items: attachLocalState(
      list.map((r) => ({ ...decorate(r), growth: growth[r.fullName] || null })),
    ),
    total: search.total,
    page,
    pageSize,
    hasMore,
    source: 'online',
    query: q,
    tag: tagInfo,
    rate: api.getRateLimit(),
    note: notes.filter(Boolean).join(' · '),
  };
}

// 这些错误重试也不会成功（额度用尽 / 限流 / 凭据错误），命中后立刻停止后续批量请求
const FATAL_TRANSLATE_ERROR = /额度|quota|429|限流|rate limit|签名|未配置|欠费|应用 ID 无效/i;

/**
 * 批量汉化简介：并发出网（默认 3 路），遇到额度/限流错误立即停止后续请求，
 * 并把失败原因原样返回给渲染层，避免「静默失败」导致整页都是英文。
 */
async function translateMissingDescriptions(items) {
  const settings = store.getSettings();
  if (!settings.autoTranslate) return { items: {}, error: '自动汉化已在设置中关闭', fatal: true };
  if (settings.translationProvider === 'off') {
    return { items: {}, error: '当前为离线术语表模式，无法在线汉化简介', fatal: true };
  }

  const targets = (items || []).filter((it) => it && it.fullName && it.description);
  const out = {};
  let lastError = '';
  let fatal = false;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    while (!fatal && cursor < targets.length) {
      const item = targets[cursor];
      cursor += 1;
      try {
        const res = await translator.translateText(item.description);
        if (!res) {
          failed += 1;
          continue;
        }
        if (res.error) {
          lastError = res.error;
          if (FATAL_TRANSLATE_ERROR.test(res.error)) fatal = true;
        }
        if (res.text && res.text !== item.description && res.engine !== 'none') {
          out[item.fullName] = {
            zhDesc: res.text,
            engine: res.engine,
            partial: Boolean(res.partial),
            offline: res.engine === 'offline',
          };
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        lastError = err.message;
        if (FATAL_TRANSLATE_ERROR.test(err.message)) fatal = true;
      }
    }
  };

  const workers = Math.min(3, targets.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return {
    items: out,
    error: lastError,
    fatal,
    failed,
    total: targets.length,
  };
}

// 主题配色：窗口底色与系统标题栏（右上角最小化/最大化/关闭）需要跟随亮暗主题
const THEME_COLORS = {
  dark: { background: '#0a0d13', bar: '#0a0d13', symbol: '#8b949e' },
  light: { background: '#eef2f8', bar: '#f4f7fc', symbol: '#3a4a63' },
};

function currentTheme() {
  return store && store.getSettings().theme === 'light' ? 'light' : 'dark';
}

function applyWindowTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, theme: next };
  const colors = THEME_COLORS[next];
  mainWindow.setBackgroundColor(colors.background);
  mainWindow.setTitleBarOverlay({ color: colors.bar, symbolColor: colors.symbol, height: 46 });
  return { ok: true, theme: next };
}

// 更新提示：只读 GitHub Releases 接口拿最新版本号，不下载文件、不上报任何用户数据
const UPDATE_SOURCE = {
  owner: 'kllll-c',
  repo: 'starhub',
  page: 'https://github.com/kllll-c/starhub/releases/latest',
};

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^[vV]/, '');
}

// 只比较 x.y.z 的数字位（0.10.0 > 0.9.1），缺失按 0 处理，预发布后缀忽略
function compareVersions(a, b) {
  const toParts = (v) => normalizeVersion(v).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pa = toParts(a);
  const pb = toParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function buildUpdatePayload(release, current) {
  const latest = normalizeVersion(release.tag || release.name || '');
  const assets = (release.assets || []).filter((a) => a && a.name);
  const setup = assets.find((a) => /setup.*\.exe$/i.test(a.name)) || assets[0] || null;
  return {
    ok: true,
    current,
    latest,
    hasUpdate: latest ? compareVersions(latest, current) > 0 : false,
    name: release.name || release.tag || '',
    pageUrl: release.pageUrl || UPDATE_SOURCE.page,
    downloadUrl: setup ? setup.url : release.pageUrl || UPDATE_SOURCE.page,
    downloadName: setup ? setup.name : '',
    downloadSize: setup ? setup.size : 0,
    publishedAt: release.publishedAt || '',
    notes: String(release.notes || '').replace(/\r/g, '').trim().slice(0, 300),
  };
}

let updateCache = { at: 0, data: null };

/**
 * 查询最新 Release。非强制检查有 10 分钟进程内缓存；
 * mockLatest 只在自检（--smoke / --preview）时生效，用于验证提示条渲染。
 */
async function checkUpdate({ force = false, mockLatest = '' } = {}) {
  const current = app.getVersion();
  const now = Date.now();
  if (!force && updateCache.data && now - updateCache.at < 10 * 60 * 1000) {
    return { ...updateCache.data, cached: true };
  }
  if (isSelfCheck && mockLatest) {
    return buildUpdatePayload(
      {
        tag: mockLatest,
        name: `StarHub ${normalizeVersion(mockLatest)}`,
        publishedAt: new Date().toISOString(),
        notes: '自检注入的模拟版本',
      },
      current,
    );
  }
  const apiUrl = `https://api.github.com/repos/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/releases/latest`;
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'StarHub-UpdateCheck', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) {
      return { ok: true, current, latest: '', hasUpdate: false, pageUrl: UPDATE_SOURCE.page };
    }
    if (!res.ok) {
      const hint =
        res.status === 403 || res.status === 429
          ? 'GitHub 接口额度已用完，稍后会自动重试'
          : `GitHub 返回 ${res.status}`;
      return { ok: false, current, error: `检查更新失败：${hint}` };
    }
    const release = await res.json();
    const payload = buildUpdatePayload(
      {
        tag: release.tag_name,
        name: release.name,
        notes: release.body,
        publishedAt: release.published_at,
        pageUrl: release.html_url,
        assets: (release.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          url: a.browser_download_url,
        })),
      },
      current,
    );
    updateCache = { at: now, data: payload };
    return payload;
  } catch (err) {
    const message = err && err.name === 'TimeoutError' ? '请求超时' : err.message;
    return { ok: false, current, error: `检查更新失败：${message}` };
  }
}

function createWindow() {
  const theme = currentTheme();
  const colors = THEME_COLORS[theme];
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.bar,
      symbolColor: colors.symbol,
      height: 46,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  const smoke = process.argv.includes('--smoke');
  if (smoke) {
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] 进程崩溃', details);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      console.error('[renderer] 加载失败', code, description);
    });
  }

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (smoke) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const outDir = path.join(app.getPath('userData'), 'smoke');
      fs.mkdirSync(outDir, { recursive: true });
      const shot = async (name) => {
        const image = await mainWindow.webContents.capturePage();
        const file = path.join(outDir, name);
        fs.writeFileSync(file, image.toPNG());
        console.log('[smoke] 截图:', file);
      };
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (err) {
          console.error(`[smoke] 步骤失败「${name}」:`, err && err.message ? err.message : err);
        }
      };

      console.log('[smoke] 数据目录:', app.getPath('userData'), '· 启动主题:', currentTheme(), '· 设置主题:', store.getSettings().theme);

      await step('列表', async () => {
        await wait(9000);
        await shot('screenshot-list.png');
        const listDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({cards: document.querySelectorAll(".card").length, title: document.getElementById("headTitle").textContent, rate: document.getElementById("statusRate").textContent, theme: document.documentElement.dataset.theme, lsTheme: (function(){try{return localStorage.getItem("starhub.theme")}catch(e){return "err"}})(), zhBadges: document.querySelectorAll(".card .repo-name .zh-badge").length, zhButtons: document.querySelectorAll("[data-act=zh-desc]").length, errBadges: document.querySelectorAll(".zh-badge.err").length, setupTipVisible: !document.getElementById("setupTip").hidden, setupTipButtons: document.querySelectorAll("#setupTip [data-act]").length, setupTipBox: (function(){var r=document.getElementById("setupTip").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];})(), setupTipText: document.getElementById("setupTip").textContent.replace(/\\s+/g," ").trim().slice(0,60), notice: document.getElementById("notice").textContent.trim().slice(0,140), firstDescs: [...document.querySelectorAll(".card-desc")].slice(0,4).map(n=>n.textContent.trim().slice(0,50))})',
        );
        console.log('[smoke] 列表状态:', listDebug);
      });

      await step('收藏点赞', async () => {
        const ensureOn = async (act) => {
          for (let i = 0; i < 3; i += 1) {
            const already = await mainWindow.webContents.executeJavaScript(
              `(function(){var b=document.querySelector('.card [data-act="${act}"]'); if(!b) return 'no-btn'; if(b.classList.contains('on')) return true; b.click(); return false;})()`,
            );
            if (already === true) return true;
            await wait(900);
          }
          return false;
        };
        await ensureOn('fav');
        await ensureOn('like');
        const libDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({fav: document.getElementById("countFavorites").textContent, like: document.getElementById("countLikes").textContent, favOn: document.querySelector(".card [data-act=fav]").classList.contains("on"), likeOn: document.querySelector(".card [data-act=like]").classList.contains("on"), favFill: getComputedStyle(document.querySelector(".card .ico-heart")).fill, likeFill: getComputedStyle(document.querySelector(".card .ico-thumb")).fill, imgFailed: document.querySelectorAll(".img-failed").length})',
        );
        console.log('[smoke] 收藏/点赞状态:', libDebug);
      });

      await step('详情与预览', async () => {
        await mainWindow.webContents.executeJavaScript('document.querySelector(".card").click(); true');
        await wait(16000);
        await shot('screenshot-detail.png');
        const detailDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({drawerOpen: !document.getElementById("drawer").hidden, name: (document.getElementById("drawerName")||{}).textContent, hasReadme: !!document.getElementById("readmeNote"), readmeChars: (document.getElementById("readmeBox")||{}).textContent?.length, favLabel: (document.querySelector(".detail-actions [data-act=fav] .act-label")||{}).textContent, favOn: (document.querySelector(".detail-actions [data-act=fav]")||{classList:{contains:()=>null}}).classList.contains("on"), bodyMsg: document.getElementById("drawerBody").textContent.trim().slice(0,90)})',
        );
        console.log('[smoke] 详情状态:', detailDebug);
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnCloseDrawer").click(); true');
        await wait(1000);
      });

      await step('内置精选', async () => {
        await mainWindow.webContents.executeJavaScript(
          'document.querySelector(\'.nav-item[data-tab="curated"]\').click(); true',
        );
        await wait(2500);
        await shot('screenshot-curated.png');
        const curatedDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({cards: document.querySelectorAll(".card").length, title: document.getElementById("headTitle").textContent, blurb: document.getElementById("headBlurb").textContent, source: document.getElementById("statusSource").textContent, imgFailed: document.querySelectorAll(".img-failed").length})',
        );
        console.log('[smoke] 内置精选:', curatedDebug);
      });

      await step('应用分类与标签搜索', async () => {
        // 「全部」汇总视图
        await mainWindow.webContents.executeJavaScript(
          'var a=document.querySelector(\'.nav-item[data-tab="all"]\'); if(a) a.click(); true',
        );
        await wait(2200);
        await shot('screenshot-all.png');
        const allDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({title: document.getElementById("headTitle").textContent, blurb: document.getElementById("headBlurb").textContent, cards: document.querySelectorAll(".card").length, footer: document.getElementById("footerNote").textContent.trim(), navCount: document.querySelector(\'.nav-item[data-tab="all"] .nav-count\').textContent})',
        );
        console.log('[smoke] 全部分类:', allDebug);

        await mainWindow.webContents.executeJavaScript(
          'var b=document.querySelector(\'.nav-item[data-tab="app"]\'); if(b) b.click(); true',
        );
        await wait(2200);
        await shot('screenshot-app.png');
        const appDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({title: document.getElementById("headTitle").textContent, blurb: document.getElementById("headBlurb").textContent, cards: document.querySelectorAll(".card").length, cardTags: document.querySelectorAll(".card .tag-btn").length})',
        );
        console.log('[smoke] 应用分类:', appDebug);

        await mainWindow.webContents.executeJavaScript(
          'var i=document.getElementById("searchInput"); i.value="桌面应用"; i.dispatchEvent(new Event("input")); true',
        );
        await wait(3000);
        await shot('screenshot-tag-search.png');
        const tagDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({hints: document.querySelectorAll("#searchHints .tag-hint").length, notice: document.getElementById("notice").textContent.trim().slice(0,80), meta: document.getElementById("headMeta").textContent.trim(), status: document.getElementById("statusSource").textContent, cards: document.querySelectorAll(".card").length})',
        );
        console.log('[smoke] 标签搜索:', tagDebug);

        await mainWindow.webContents.executeJavaScript(
          'var s=document.getElementById("sortSelect"); s.value="alpha"; s.dispatchEvent(new Event("change")); true',
        );
        await wait(3000);
        const alphaDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({sort: document.getElementById("sortSelect").value, names: [...document.querySelectorAll(".card .repo-name")].slice(0,6).map(n=>n.textContent.replace("中文","").trim())})',
        );
        console.log('[smoke] 首字母排序:', alphaDebug);
      });

      await step('下载量排序', async () => {
        await mainWindow.webContents.executeJavaScript(
          'var s=document.getElementById("sortSelect"); s.value="downloads"; s.dispatchEvent(new Event("change")); true',
        );
        await wait(15000);
        await shot('screenshot-downloads.png');
        const dlDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({metrics: [...document.querySelectorAll(".card")].slice(0,3).map(c=>c.querySelectorAll(".metric")[0].textContent.trim()), note: document.getElementById("notice").textContent.trim().slice(0,60)})',
        );
        console.log('[smoke] 下载量排序:', dlDebug);
      });

      await step('亮暗主题切换', async () => {
        // 先确保处于暗色，避免上一次运行留下的亮色让断言方向反掉
        const startTheme = await mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme');
        if (startTheme !== 'dark') {
          await mainWindow.webContents.executeJavaScript('document.getElementById("btnTheme").click(); true');
          await wait(400);
        }
        const before = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({theme: document.documentElement.dataset.theme, iconShown: getComputedStyle(document.querySelector("#btnTheme .ico-theme-moon")).display, title: document.getElementById("btnTheme").title, bodyBg: getComputedStyle(document.body).backgroundColor})',
        );
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnTheme").click(); true');
        await wait(400);
        await shot('screenshot-theme-light.png');
        const after = await mainWindow.webContents.executeJavaScript(
          '(async () => JSON.stringify({theme: document.documentElement.dataset.theme, iconShown: getComputedStyle(document.querySelector("#btnTheme .ico-theme-sun")).display, title: document.getElementById("btnTheme").title, bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color, cardBg: getComputedStyle(document.querySelector(".card")).backgroundImage.slice(0, 34), overlayIpc: await window.starhub.setTheme("light")}))()',
        );
        console.log('[smoke] 主题切换:', before, '=>', after);
        let detailLight = 'skipped';
        try {
          // 侧边栏/详情在亮色下的可读性（列表可能为空，做存在性判断）
          const hasCard = await mainWindow.webContents.executeJavaScript('!!document.querySelector(".card")');
          if (hasCard) {
            await mainWindow.webContents.executeJavaScript('document.querySelector(".card").click(); true');
            await wait(3000);
            await shot('screenshot-theme-light-detail.png');
            detailLight = await mainWindow.webContents.executeJavaScript(
              // README 可能因为接口额度不足没加载，取不到元素时跳过而不是抛错
              'JSON.stringify({drawer: getComputedStyle(document.getElementById("drawer")).backgroundColor, readmeColor: (function(){var r=document.getElementById("readmeBox"); return r ? getComputedStyle(r).color : "no-readme";})()})',
            );
            await mainWindow.webContents.executeJavaScript(
              'var d=document.getElementById("btnCloseDrawer"); if(d && !document.getElementById("drawer").hidden) d.click(); true',
            );
            await wait(400);
          } else {
            detailLight = 'no-card';
          }
        } catch (err) {
          // 详情截图只是附加检查，失败不影响主题结论，也绝不能因此漏掉「切回暗色」
          detailLight = `error: ${err && err.message}`;
        }
        console.log('[smoke] 亮色详情:', detailLight);
        // 切回暗色，保证后续截图与最终状态是默认主题
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnTheme").click(); true');
        await wait(400);
        const back = await mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme');
        console.log('[smoke] 主题已切回:', back);
      });

      await step('设置面板', async () => {
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnSettings").click(); true');
        await wait(900);
        await shot('screenshot-settings.png');
        const setDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({hint: document.querySelector(".form-hint").textContent.trim().slice(0,80), provider: document.getElementById("inputProvider").value, providers: [...document.getElementById("inputProvider").options].map(o=>o.value), auto: document.getElementById("inputAutoTranslate").checked, autoReadme: document.getElementById("inputAutoReadme").checked, baiduFields: !!(document.getElementById("inputBaiduAppId") && document.getElementById("inputBaiduKey")), youdaoFields: !!(document.getElementById("inputYoudaoAppKey") && document.getElementById("inputYoudaoSecret")), zhipuFields: !!(document.getElementById("inputZhipuApiKey") && document.getElementById("inputZhipuModel")), visibleEngines: [...document.querySelectorAll(".engine-panel")].filter(p=>!p.hidden).map(p=>p.dataset.engine), modalVisible: !document.getElementById("settingsModal").hidden && document.getElementById("settingsModal").offsetHeight > 0, cacheText: document.getElementById("cacheStatsText").textContent})',
        );
        console.log('[smoke] 设置面板:', setDebug);
        // 切换引擎下拉：只展开选中的引擎面板
        const switchDebug = await mainWindow.webContents.executeJavaScript(
          '(function(){ var s=document.getElementById("inputProvider"); s.value="zhipu"; s.dispatchEvent(new Event("change")); return JSON.stringify({visible: [...document.querySelectorAll(".engine-panel")].filter(p=>!p.hidden).map(p=>p.dataset.engine), zhipuKey: !!document.getElementById("inputZhipuApiKey").offsetHeight}); })()',
        );
        console.log('[smoke] 引擎面板切换:', switchDebug);
        await shot('screenshot-settings-zhipu.png');
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnCloseSettings").click(); true');
        await wait(600);
      });

      await step('Star 增速筛选', async () => {
        await mainWindow.webContents.executeJavaScript(
          'var s=document.getElementById("growth7Select"); s.value="100"; s.dispatchEvent(new Event("change")); true',
        );
        await wait(9000);
        await shot('screenshot-growth.png');
        const growthDebug = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({g7: document.getElementById("growth7Select").value, g30: document.getElementById("growth30Select").value, cards: document.querySelectorAll(".card").length, chips: [...document.querySelectorAll("#headMeta .chip")].map(n=>n.textContent.trim()), notice: document.getElementById("notice").textContent.trim().slice(0,120), empty: document.getElementById("emptyDesc").textContent.trim().slice(0,50), apiError: document.getElementById("empty").hidden ? "" : "shown"})',
        );
        console.log('[smoke] Star 增速筛选:', growthDebug);
        // 复位，避免影响后续截图
        await mainWindow.webContents.executeJavaScript(
          'var s=document.getElementById("growth7Select"); s.value="0"; s.dispatchEvent(new Event("change")); true',
        );
        await wait(4000);
      });

      await step('更新提示', async () => {
        // 1) 真实接口：GitHub Releases 最新版本（当前 1.0.0，应判定为已是最新）
        const real = await mainWindow.webContents.executeJavaScript(
          'window.starhub.checkUpdate({ force: true })',
        );
        console.log(
          '[smoke] 更新接口:',
          JSON.stringify({
            ok: real.ok,
            current: real.current,
            latest: real.latest,
            hasUpdate: real.hasUpdate,
            download: real.downloadName,
            size: real.downloadSize,
            error: real.error,
          }),
        );
        // 2) 注入模拟版本，验证提示条渲染（mockLatest 仅在自检时生效）
        const shown = await mainWindow.webContents.executeJavaScript(
          '(function(){ return window.starhub.checkUpdate({ force: true, mockLatest: "9.9.9" }).then(function(r){ state.update = r; renderUpdateTip(); return JSON.stringify({shown: !document.getElementById("updateTip").hidden, text: document.getElementById("updateTip").textContent.replace(/\\s+/g," ").trim(), buttons: document.querySelectorAll("#updateTip [data-act]").length, bg: getComputedStyle(document.getElementById("updateTip")).backgroundImage.slice(0,42)}); }); })()',
        );
        console.log('[smoke] 更新提示条:', shown);
        await shot('screenshot-update-tip.png');
        // 3) 点「跳过此版本」：提示条隐藏并记住版本号
        const skipped = await mainWindow.webContents.executeJavaScript(
          '(function(){ var b=document.querySelector("#updateTip [data-act=update-skip]"); if(!b) return "no-btn"; b.click(); return JSON.stringify({hidden: document.getElementById("updateTip").hidden, meta: localStorage.getItem("starhub.updateCheck")}); })()',
        );
        console.log('[smoke] 跳过此版本:', skipped);
        // 4) 关于弹窗的版本行与「检查更新」按钮
        const about = await mainWindow.webContents.executeJavaScript(
          '(function(){ document.getElementById("btnAbout").click(); return JSON.stringify({version: document.getElementById("aboutVersion").textContent, text: document.getElementById("aboutUpdateText").textContent, hasBtn: !!document.getElementById("btnCheckUpdate")}); })()',
        );
        console.log('[smoke] 关于弹窗:', about);
        await wait(600);
        await shot('screenshot-about.png');
        await mainWindow.webContents.executeJavaScript('document.getElementById("btnCloseAbout").click(); true');
        await wait(400);
      });

      app.quit();
    });
  }

  // --preview：只截图（整窗 + 侧边栏），用于快速预览界面，不做交互验证
  if (process.argv.includes('--preview')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const outDir = path.join(app.getPath('userData'), 'preview');
      fs.mkdirSync(outDir, { recursive: true });
      try {
        await wait(9000);
        const full = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'window.png'), full.toPNG());
        const size = full.getSize();
        const sidebar = await mainWindow.webContents.capturePage({ x: 0, y: 46, width: 238, height: 860 - 46 });
        fs.writeFileSync(path.join(outDir, 'sidebar.png'), sidebar.toPNG());
        console.log('[preview] 整窗尺寸:', JSON.stringify(size), '侧边栏:', JSON.stringify(sidebar.getSize()), '输出:', outDir);
        const ui = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({theme: document.documentElement.dataset.theme, bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color, cardBg: (function(){var c=document.querySelector(".card"); return c ? getComputedStyle(c).backgroundImage.slice(0,34) : "no-card";})()})',
        );
        console.log('[preview] 主题:', ui);
      } catch (err) {
        console.error('[preview] 失败:', err);
      }
      app.quit();
    });
  }
}

function openExternalSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: '只允许打开 http/https 链接' };
  } catch (_) {
    return { ok: false, error: '链接格式不正确' };
  }
}

function registerIpc() {
  ipcMain.handle('app:init', () => {
    const settings = store.getSettings();
    return {
      categories: allCategories().filter((c) => c.id !== 'top'),
      topCategory: TOP_CATEGORY,
      sorts: SORTS.map(({ id, label }) => ({ id, label })),
      languages: LANGUAGES,
      langColors: LANG_COLORS,
      curated: {
        total: curated.totalCount,
        updatedAt: curated.updatedAt,
        note: curated.note,
        counts: curated.categoryCounts(),
        tagCounts: curated.tagCounts(),
      },
      tags: listTags(),
      settings: {
        ...settings,
        githubToken: settings.githubToken ? '••••••' : '',
        hasGithubToken: Boolean(settings.githubToken),
        hasOpenaiKey: Boolean(settings.openaiApiKey),
        openaiApiKey: '',
        hasZhipuKey: Boolean(settings.zhipuApiKey),
        zhipuApiKey: '',
        hasBaiduKey: Boolean(settings.baiduAppId && settings.baiduKey),
        baiduKey: '',
        hasYoudaoKey: Boolean(settings.youdaoAppKey && settings.youdaoAppSecret),
        youdaoAppSecret: '',
      },
      rate: api.getRateLimit(),
      library: store.getLibrary(),
      version: app.getVersion(),
    };
  });

  ipcMain.handle('tags:list', () => listTags());

  ipcMain.handle('repos:list', async (_event, params) => {
    try {
      return await listRepos(params);
    } catch (err) {
      if (err instanceof GithubError && err.rateLimited) {
        return {
          items: [],
          total: 0,
          hasMore: false,
          error: err.message,
          rateLimited: true,
          resetAt: err.resetAt,
          rate: api.getRateLimit(),
        };
      }
      return { items: [], total: 0, hasMore: false, error: err.message, rate: api.getRateLimit() };
    }
  });

  ipcMain.handle('repos:translate-descriptions', async (_event, items) => {
    try {
      return await translateMissingDescriptions(items || []);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('repos:downloads', async (_event, { fullNames = [], force = false } = {}) => {
    try {
      const counts = await api.getDownloadsBatch(fullNames.slice(0, 40), { force, concurrency: 4 });
      return { counts, rate: api.getRateLimit() };
    } catch (err) {
      return { counts: {}, error: err.message, rate: api.getRateLimit() };
    }
  });

  ipcMain.handle('repo:detail', async (_event, { fullName, force }) => {
    try {
      const repo = await api.getRepo(fullName, { force });
      const [downloads, languages] = await Promise.all([
        api.getDownloads(fullName, { force }).catch(() => null),
        api.getLanguages(fullName).catch(() => ({})),
      ]);
      const decorated = decorate(repo);
      store.updateRepoSnapshot(decorated);
      return {
        repo: { ...decorated, downloads: downloads ? downloads.downloads : null },
        downloads,
        languages,
        zh: curated.zhInfo(fullName),
        rate: api.getRateLimit(),
      };
    } catch (err) {
      return { error: err.message, rate: api.getRateLimit() };
    }
  });

  ipcMain.handle('repo:readme', async (_event, { fullName, force }) => {
    try {
      const readme = await api.getReadme(fullName, { force });
      return { ...readme, rate: api.getRateLimit() };
    } catch (err) {
      return { error: err.message, markdown: '', rate: api.getRateLimit() };
    }
  });

  ipcMain.handle('repo:translate-readme', async (_event, { fullName, markdown, force, maxChars }) => {
    try {
      const result = await translator.translateMarkdown(markdown, {
        force,
        ...(maxChars ? { maxChars } : {}),
      });
      return { fullName, ...result };
    } catch (err) {
      return { error: err.message, markdown: '' };
    }
  });

  ipcMain.handle('repo:translate-text', async (_event, { text, force }) => {
    try {
      return await translator.translateText(text, { force });
    } catch (err) {
      return { error: err.message, text };
    }
  });

  ipcMain.handle('library:get', () => store.getLibrary());

  ipcMain.handle('library:toggle', (_event, { kind, repo }) => {
    if (!repo || !repo.fullName) return { error: '缺少仓库信息' };
    const snapshot = {
      fullName: repo.fullName,
      name: repo.name,
      owner: repo.owner,
      ownerAvatar: repo.ownerAvatar,
      htmlUrl: repo.htmlUrl,
      description: repo.description,
      zhName: repo.zhName || '',
      zhDesc: repo.zhDesc || '',
      stars: repo.stars,
      language: repo.language,
      downloads: repo.downloads,
      topics: repo.topics || [],
    };
    if (kind === 'favorite') {
      const r = store.toggleFavorite(snapshot);
      return { ...r, favorites: store.getLibrary().favorites };
    }
    if (kind === 'like') {
      const r = store.toggleLike(snapshot);
      return { ...r, likes: store.getLibrary().likes };
    }
    return { error: '未知的操作类型' };
  });

  ipcMain.handle('settings:get', () => {
    const settings = store.getSettings();
    return settings;
  });

  ipcMain.handle('settings:save', (_event, patch) => {
    const incoming = { ...patch };
    if (incoming.githubToken && incoming.githubToken.includes('•')) delete incoming.githubToken;
    if (incoming.openaiApiKey && incoming.openaiApiKey.includes('•')) delete incoming.openaiApiKey;
    if (incoming.zhipuApiKey && incoming.zhipuApiKey.includes('•')) delete incoming.zhipuApiKey;
    if (incoming.baiduKey && incoming.baiduKey.includes('•')) delete incoming.baiduKey;
    if (incoming.youdaoAppSecret && incoming.youdaoAppSecret.includes('•')) delete incoming.youdaoAppSecret;
    const saved = store.saveSettings(incoming);
    if (incoming.theme) applyWindowTheme(saved.theme);
    return { ok: true, rate: api.getRateLimit(), settings: saved };
  });

  // 标题栏按钮切换亮/暗主题：同步窗口底色与系统按钮的配色
  ipcMain.handle('window:theme', (_event, theme) => applyWindowTheme(theme));

  // 更新提示：查询 GitHub 最新 Release，由渲染层决定是否弹出提示条
  ipcMain.handle('update:check', (_event, { force = false, mockLatest = '' } = {}) =>
    checkUpdate({ force, mockLatest }),
  );

  ipcMain.handle('translate:status', () => {
    const s = store.getSettings();
    return {
      provider: s.translationProvider,
      hasOpenaiKey: Boolean(s.openaiApiKey),
      hasZhipuKey: Boolean(s.zhipuApiKey),
      hasBaiduKey: Boolean(s.baiduAppId && s.baiduKey),
      hasYoudaoKey: Boolean(s.youdaoAppKey && s.youdaoAppSecret),
      model: s.openaiModel,
      hasGithubToken: Boolean(s.githubToken),
    };
  });

  ipcMain.handle('shell:open', (_event, url) => openExternalSafe(url));
  ipcMain.handle('clipboard:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('cache:clear', () => {
    cache.clear();
    return { ok: true, stats: cache.stats() };
  });

  ipcMain.handle('cache:stats', () => cache.stats());
}

app.whenReady().then(() => {
  initServices();
  if (isSelfCheck) {
    console.log(
      '[boot] userData:',
      app.getPath('userData'),
      '· theme:',
      store.getSettings().theme,
      '· settings.json 已存在:',
      fs.existsSync(path.join(app.getPath('userData'), 'settings.json')),
    );
  }
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
