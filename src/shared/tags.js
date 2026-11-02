/**
 * 标签体系：给每个仓库自动打上「形态 + 用途」两类中文标签。
 * 标签同时带英文别名与 GitHub 搜索条件，所以：
 *   - 卡片上显示中文标签（点击可搜索）
 *   - 搜索栏输入标签名（中文或英文别名）时，直接按标签构造在线查询
 *   - 内置精选库可以按标签过滤（离线也能用）
 */

// 形态类标签：这个项目「是什么形状」的产物
const FORM_IDS = ['desktop-app', 'mobile-app', 'web-app', 'cli', 'browser-extension', 'ide-plugin', 'github-action', 'self-hosted', 'library', 'template'];

// 「应用」分类认这些形态（成品应用，可直接下载使用）
const APP_FORM_IDS = ['desktop-app', 'mobile-app', 'web-app', 'cli', 'browser-extension', 'ide-plugin'];

// 明确是「装在自己机器上就能用」的形态：带这些标签的项目即使同时是库，也归到「应用」
const STRONG_APP_FORM_IDS = ['desktop-app', 'browser-extension', 'ide-plugin'];

const TAGS = [
  {
    id: 'desktop-app',
    label: '桌面应用',
    kind: 'form',
    query: 'topic:desktop-app',
    desc: 'Windows / macOS / Linux 上可安装的桌面程序',
    terms: ['desktop app', 'desktop-app', 'desktop application', 'electron', 'tauri', 'wails', 'qt', 'gtk', 'wpf', 'winforms', 'javafx', 'menubar', 'system tray', '桌面应用', '桌面客户端'],
  },
  {
    id: 'mobile-app',
    label: '移动应用',
    kind: 'form',
    query: 'topic:android topic:ios',
    desc: 'Android / iOS 手机上可安装的应用',
    terms: ['android', 'ios', 'mobile app', 'mobile-app', 'flutter', 'react native', 'react-native', 'swiftui', 'jetpack compose', 'expo', 'capacitor', 'cordova', '移动应用', '手机应用'],
  },
  {
    id: 'web-app',
    label: 'Web 应用',
    kind: 'form',
    query: 'topic:web-app',
    desc: '浏览器里直接使用的完整站内应用',
    terms: ['web app', 'webapp', 'website', 'spa', 'single page application', 'dashboard', 'admin panel', 'next.js', 'nuxt', 'sveltekit', 'remix', 'web 应用', '网页应用', '站点'],
  },
  {
    id: 'cli',
    label: '命令行工具',
    kind: 'form',
    query: 'topic:cli',
    desc: '在终端里运行的命令行程序',
    terms: ['cli', 'command-line', 'command line', 'terminal', 'tui', 'shell', 'console app', '命令行', '终端工具'],
  },
  {
    id: 'browser-extension',
    label: '浏览器扩展',
    kind: 'form',
    query: 'topic:browser-extension',
    desc: 'Chrome / Firefox 等浏览器插件',
    terms: ['chrome extension', 'firefox extension', 'browser extension', 'userscript', 'tampermonkey', 'addon', '浏览器扩展', '浏览器插件'],
  },
  {
    id: 'ide-plugin',
    label: '编辑器插件',
    kind: 'form',
    query: 'topic:vscode-extension',
    desc: 'VS Code / Neovim / JetBrains 插件',
    terms: ['vscode', 'vs code extension', 'neovim', 'vim plugin', 'intellij', 'jetbrains', 'emacs', 'sublime text', '编辑器插件', 'vscode 插件'],
  },
  {
    id: 'github-action',
    label: 'GitHub Action',
    kind: 'form',
    query: 'topic:github-actions',
    desc: 'GitHub 工作流里可直接调用的 Action',
    terms: ['github action', 'github-action', 'gh action', 'workflow action'],
  },
  {
    id: 'self-hosted',
    label: '可自托管',
    kind: 'form',
    query: 'topic:self-hosted',
    desc: '一条命令部署到自己服务器上的服务',
    terms: ['self-hosted', 'self hosted', 'docker compose', 'docker-compose', 'helm chart', '自托管', '私有部署'],
  },
  {
    id: 'library',
    label: '库与 SDK',
    kind: 'form',
    query: 'topic:sdk',
    desc: '给开发者调用的库、SDK 或框架',
    terms: ['library', 'sdk', 'framework', 'api client', 'bindings', 'wrapper', 'toolkit', '库', '框架', '工具包'],
  },
  {
    id: 'template',
    label: '模板与脚手架',
    kind: 'form',
    query: 'topic:template',
    desc: '开箱即用的项目模板 / 起步套件',
    terms: ['template', 'boilerplate', 'starter kit', 'starter template', 'scaffold', '模板', '脚手架', '起步套件'],
  },
  {
    id: 'ai',
    label: 'AI 与大模型',
    kind: 'use',
    query: 'topic:llm',
    desc: '大模型、推理、AI 应用与工具链',
    terms: ['ai', 'llm', 'gpt', 'chatgpt', 'machine learning', 'deep learning', 'neural network', 'transformer', 'diffusion', 'agent', 'rag', 'embedding', 'inference', 'fine-tuning', 'artificial intelligence', '大模型', '人工智能', '深度学习', '机器学习', '推理', '智能体'],
  },
  {
    id: 'data',
    label: '数据与数据库',
    kind: 'use',
    query: 'topic:database',
    desc: '数据库、SQL、数据分析与 ETL',
    terms: ['database', 'sql', 'analytics', 'etl', 'pandas', 'data science', 'data pipeline', 'query engine', 'orm', 'dataframe', '数据库', '数据分析', '数据管道'],
  },
  {
    id: 'devops',
    label: 'DevOps 与运维',
    kind: 'use',
    query: 'topic:devops',
    desc: '容器、CI/CD、监控与部署',
    terms: ['kubernetes', 'docker', 'ci/cd', 'cicd', 'monitoring', 'terraform', 'ansible', 'deployment', 'observability', 'prometheus', 'grafana', 'nginx', 'devops', '运维', '部署'],
  },
  {
    id: 'security',
    label: '安全与隐私',
    kind: 'use',
    query: 'topic:security',
    desc: '渗透测试、密钥、漏洞与加固',
    terms: ['security', 'penetration', 'vulnerability', 'encryption', 'password manager', 'vpn', 'proxy', 'malware', 'zero trust', '审计', '安全', '加密', '隐私'],
  },
  {
    id: 'automation',
    label: '自动化与爬虫',
    kind: 'use',
    query: 'topic:automation',
    desc: '脚本、工作流、爬虫与定时任务',
    terms: ['automation', 'scraper', 'crawler', 'workflow', 'scheduler', 'bot', '自动化', '爬虫', '工作流', '定时任务'],
  },
  {
    id: 'media',
    label: '图形与多媒体',
    kind: 'use',
    query: 'topic:image-processing',
    desc: '音视频、图像、3D 与渲染',
    terms: ['video', 'audio', 'image processing', '3d', 'render', 'rendering', 'animation', 'ffmpeg', 'graphics', 'shader', '视频', '音频', '图像', '动画', '渲染', '多媒体'],
  },
  {
    id: 'learning',
    label: '学习与教程',
    kind: 'use',
    query: 'topic:tutorial',
    desc: '教程、路线图、面试与开源书',
    terms: ['tutorial', 'course', 'books', 'interview', 'algorithms', 'data structures', 'awesome', 'roadmap', '教程', '学习', '面试', '算法', '书单'],
  },
  {
    id: 'productivity',
    label: '笔记与效率',
    kind: 'use',
    query: 'topic:productivity',
    desc: '笔记、待办、日历与效率工具',
    terms: ['notes', 'note-taking', 'todo', 'task management', 'productivity', 'calendar', 'kanban', 'whiteboard', '笔记', '待办', '效率', '看板', '白板'],
  },
  {
    id: 'chat',
    label: '通讯与协作',
    kind: 'use',
    query: 'topic:messaging',
    desc: '聊天、邮件与团队协作',
    terms: ['chat', 'messaging', 'email', 'instant messaging', 'collaboration', '聊天', '通讯', '协作', '邮件'],
  },
  {
    id: 'game',
    label: '游戏与引擎',
    kind: 'use',
    query: 'topic:game-development',
    desc: '游戏、游戏引擎与开发框架',
    terms: ['game engine', 'game development', 'godot', 'unity', 'game', '游戏', '游戏引擎'],
  },
  {
    id: 'iot',
    label: '物联网与硬件',
    kind: 'use',
    query: 'topic:iot',
    desc: '嵌入式、单片机与智能家居',
    terms: ['iot', 'arduino', 'raspberry pi', 'esp32', 'home assistant', 'embedded', 'firmware', '物联网', '嵌入式', '硬件'],
  },
  {
    id: 'crypto',
    label: '区块链与 Web3',
    kind: 'use',
    query: 'topic:blockchain',
    desc: '公链、钱包与智能合约',
    terms: ['blockchain', 'ethereum', 'web3', 'solana', 'bitcoin', 'smart contract', 'wallet', '区块链', '智能合约'],
  },
];

const TAG_BY_ID = new Map(TAGS.map((t) => [t.id, t]));
const TAG_BY_LABEL = new Map(TAGS.map((t) => [t.label, t]));

// 预编译英文术语的边界正则，避免每次打标都重新构造
const termRegExp = new Map();
function termMatches(haystack, term) {
  const t = term.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(t)) return haystack.includes(t);
  let re = termRegExp.get(t);
  if (!re) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    termRegExp.set(t, re);
  }
  return re.test(haystack);
}

function haystackOf(repo) {
  if (!repo) return '';
  return [
    repo.name || '',
    repo.fullName || '',
    repo.description || '',
    repo.zhDesc || '',
    repo.zhName || '',
    Array.isArray(repo.topics) ? repo.topics.join(' ') : '',
    repo.language || '',
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * 给仓库打标签：形态类优先，其次用途类，最多 6 个。
 * 支持 repo.preTags（人工/分类映射的标签）作为高优先级标签。
 */
function buildTagIds(repo) {
  if (!repo) return [];
  const haystack = haystackOf(repo);
  const form = [];
  const use = [];
  const seen = new Set();

  for (const label of repo.preTags || []) {
    const tag = TAG_BY_LABEL.get(label);
    if (!tag || seen.has(tag.id)) continue;
    seen.add(tag.id);
    (tag.kind === 'form' ? form : use).push(tag.id);
  }

  if (haystack) {
    for (const tag of TAGS) {
      if (form.length + use.length >= 6) break;
      if (seen.has(tag.id)) continue;
      const hit = tag.terms.some((term) => termMatches(haystack, term));
      if (!hit) continue;
      seen.add(tag.id);
      (tag.kind === 'form' ? form : use).push(tag.id);
    }
  }
  return form.concat(use).slice(0, 6);
}

function buildTags(repo) {
  return buildTagIds(repo).map((id) => TAG_BY_ID.get(id).label);
}

function isAppRepo(repo) {
  const ids = buildTagIds(repo);
  if (!ids.some((id) => APP_FORM_IDS.includes(id))) return false;
  // 「库与 SDK / 模板」类项目大多是开发者依赖，只有同时是明确的成品形态
  // （桌面应用 / 浏览器扩展 / 编辑器插件）时才归到「应用」，避免把 React、Vue、Vite 这类框架混进来
  const libraryLike = ids.includes('library') || ids.includes('template');
  if (libraryLike && !ids.some((id) => STRONG_APP_FORM_IDS.includes(id))) return false;
  return true;
}

function normalize(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 搜索栏输入是否命中某个标签（支持中文标签名与英文别名）。
 * 模糊匹配只对中文生效：英文仓库名（react / electron / vite 等）继续走普通关键词搜索，
 * 否则「输入 react」会被误判成「移动应用」标签。
 */
function findTag(keyword) {
  const kw = normalize(keyword);
  if (!kw) return null;
  let exact = TAGS.find((t) => normalize(t.label) === kw);
  if (exact) return { tag: exact, exact: true };
  exact = TAGS.find((t) => t.terms.some((term) => normalize(term) === kw));
  if (exact) return { tag: exact, exact: true };
  if (kw.length < 2 || !/[\u4e00-\u9fff]/.test(kw)) return null;
  const compact = kw.replace(/\s+/g, '');
  const fuzzy = TAGS.find((t) => {
    const label = normalize(t.label);
    return (
      label.includes(kw) ||
      label.replace(/\s+/g, '').includes(compact) ||
      t.terms.some((term) => {
        const text = normalize(term);
        return text.includes(kw) || text.replace(/\s+/g, '').includes(compact);
      })
    );
  });
  return fuzzy ? { tag: fuzzy, exact: false } : null;
}

function listTags() {
  return TAGS.map(({ id, label, kind, query, desc, terms }) => ({
    id,
    label,
    kind,
    query,
    desc,
    terms: terms.slice(0, 6),
  }));
}

module.exports = {
  TAGS,
  FORM_IDS,
  APP_FORM_IDS,
  TAG_BY_ID,
  buildTags,
  buildTagIds,
  isAppRepo,
  findTag,
  listTags,
};
