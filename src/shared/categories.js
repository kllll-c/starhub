/**
 * 分类定义（8~12 个类别，覆盖 GitHub 上主流的「好用的高星项目」）。
 * query 使用 GitHub 搜索语法，可以在「在线发现」模式下直接拉取对应类别的仓库。
 */

const CATEGORIES = [
  {
    id: 'all',
    name: '全部',
    emoji: '🌐',
    blurb: '不限定分类，汇总所有高星项目，可再用标签、语言、排序与最低 Star 筛选',
    query: 'stars:>1000',
    fallbackQuery: '',
  },
  {
    id: 'ai',
    name: 'AI · 大模型',
    emoji: '🤖',
    blurb: '大语言模型、推理框架、AI 应用与工具链',
    query: 'topic:llm stars:>1000',
    fallbackQuery: 'topic:artificial-intelligence stars:>3000',
  },
  {
    id: 'web',
    name: '前端与网站',
    emoji: '🎨',
    blurb: '框架、构建工具、UI 组件与站点生成器',
    query: 'topic:frontend stars:>1000',
    fallbackQuery: 'topic:web stars:>5000',
  },
  {
    id: 'backend',
    name: '后端与 API',
    emoji: '🛠️',
    blurb: '服务端框架、中间件、接口与微服务',
    query: 'topic:backend stars:>1000',
    fallbackQuery: 'topic:api stars:>2000',
  },
  {
    id: 'mobile',
    name: '移动与跨端',
    emoji: '📱',
    blurb: 'Android / iOS 原生与跨平台方案',
    query: 'topic:android stars:>1000',
    fallbackQuery: 'topic:ios stars:>1000',
  },
  {
    id: 'desktop',
    name: '桌面客户端',
    emoji: '💻',
    blurb: 'Electron / Tauri 等桌面应用与效率工具',
    query: 'topic:desktop-app stars:>1000',
    fallbackQuery: 'topic:electron stars:>1000',
  },
  {
    id: 'app',
    name: '应用',
    emoji: '📦',
    blurb: '各类可直接使用的成品应用：桌面端、移动端、网页端、命令行与浏览器扩展',
    query: 'topic:app stars:>1000',
    fallbackQuery: 'topic:application stars:>2000',
  },
  {
    id: 'devtools',
    name: '开发工具与终端',
    emoji: '⌨️',
    blurb: '编辑器、命令行、Shell 与开发者利器',
    query: 'topic:cli stars:>1000',
    fallbackQuery: 'topic:developer-tools stars:>1000',
  },
  {
    id: 'devops',
    name: 'DevOps 与云原生',
    emoji: '🚀',
    blurb: '容器、编排、CI/CD、监控与运维',
    query: 'topic:devops stars:>1000',
    fallbackQuery: 'topic:kubernetes stars:>1000',
  },
  {
    id: 'data',
    name: '数据与数据库',
    emoji: '🗄️',
    blurb: '数据库、数据管道、分析与可视化引擎',
    query: 'topic:database stars:>1000',
    fallbackQuery: 'topic:data-science stars:>3000',
  },
  {
    id: 'learning',
    name: '学习与教程',
    emoji: '📚',
    blurb: '开源书、路线图、面试与入门教程',
    query: 'topic:tutorial stars:>1000',
    fallbackQuery: 'topic:awesome stars:>5000',
  },
  {
    id: 'security',
    name: '安全与隐私',
    emoji: '🛡️',
    blurb: '渗透测试、密钥管理、漏洞扫描与加固',
    query: 'topic:security stars:>800',
    fallbackQuery: 'topic:privacy stars:>800',
  },
  {
    id: 'automation',
    name: '自动化与爬虫',
    emoji: '🕹️',
    blurb: '工作流编排、脚本自动化与数据抓取',
    query: 'topic:automation stars:>800',
    fallbackQuery: 'topic:webscraping stars:>800',
  },
  {
    id: 'media',
    name: '图形与多媒体',
    emoji: '🖼️',
    blurb: '3D、绘图、音视频处理与游戏引擎',
    query: 'topic:visualization stars:>800',
    fallbackQuery: 'topic:game-development stars:>800',
  },
];

const TOP_CATEGORY = {
  id: 'top',
  name: '高星精选',
  emoji: '⭐',
  blurb: '全站 Star 最多的项目（>1 万星）',
  query: 'stars:>10000',
};

const SORTS = [
  { id: 'stars', label: 'Star 最多', api: { sort: 'stars', order: 'desc' } },
  { id: 'downloads', label: '下载量最高', api: { sort: 'stars', order: 'desc' }, postSort: 'downloads' },
  { id: 'alpha', label: '首字母 A-Z', api: { sort: 'stars', order: 'desc' }, localSort: 'alpha' },
  { id: 'updated', label: '最近更新', api: { sort: 'updated', order: 'desc' } },
  { id: 'new', label: '新晋热门', api: { sort: 'stars', order: 'desc' }, createdAfterYears: 1 },
];

const LANGUAGES = [
  { id: 'all', label: '全部语言' },
  { id: 'TypeScript', label: 'TypeScript' },
  { id: 'JavaScript', label: 'JavaScript' },
  { id: 'Python', label: 'Python' },
  { id: 'Go', label: 'Go' },
  { id: 'Rust', label: 'Rust' },
  { id: 'Java', label: 'Java' },
  { id: 'C++', label: 'C++' },
  { id: 'C#', label: 'C#' },
  { id: 'PHP', label: 'PHP' },
  { id: 'Swift', label: 'Swift' },
  { id: 'Kotlin', label: 'Kotlin' },
];

const LANG_COLORS = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Ruby: '#701516',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Jupyter: '#DA5B0B',
  'Jupyter Notebook': '#DA5B0B',
  MDX: '#fcb32c',
  Zig: '#ec915c',
};

module.exports = { CATEGORIES, TOP_CATEGORY, SORTS, LANGUAGES, LANG_COLORS };
