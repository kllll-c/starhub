/**
 * 汉化引擎（翻译层）：
 *   1. ai       —— 调用任意 OpenAI 兼容接口（DeepSeek / Kimi / 通义 / OpenAI…），质量最好，支持 Markdown 结构化翻译
 *   2. zhipu    —— 智谱开放平台 GLM（OpenAI 兼容接口，glm-4.6v-flash 有免费额度）
 *   3. agnes    —— Agnes AI（OpenAI 兼容接口，agnes-2.5-flash / agnes-3.0-pro 等可切换）
 *   4. baidu    —— 百度翻译开放平台（需 APP ID + 密钥，按字符计费，支持 auto 识别源语种）
 *   5. youdao   —— 有道智云文本翻译（需应用 ID + 应用密钥，v3 签名，标准版按字符计费）
 *   6. mymemory —— 免费在线接口，无需 API Key，适合翻译仓库简介（有每日额度）
 *   7. offline  —— 离线术语表，翻译标题与常见技术名词
 * 所有结果都会落盘缓存，同一个仓库/README 只会翻译一次。
 */
const crypto = require('crypto');

const MARKDOWN_MAX_CHARS = 6000;

// OpenAI 兼容通道（AI 翻译 / 智谱）：按 3200 字一批，默认 2 路并发；
// 命中限流或并发被拒时自动退回串行再补一次，单批漏翻的段落会逐条补翻。
const CHAT_BATCH_CHARS = 3200;
const CHAT_WORKERS = 2;
const CHAT_MAX_ATTEMPTS = 3;
const CHAT_FILL_LIMIT = 12;

/* ---------------- 语种识别 ---------------- */

// 按 Unicode 区段统计各文字系统，用于判断「这段文字是什么语言」以及「是否已经是中文」
const SCRIPT_RE = {
  han: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
  kana: /[\u3040-\u30ff\u31f0-\u31ff]/g,
  hangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g,
  cyrillic: /[\u0400-\u04ff\u0500-\u052f]/g,
  arabic: /[\u0600-\u06ff\u0750-\u077f]/g,
  thai: /[\u0e00-\u0e7f]/g,
  latin: /[A-Za-z\u00c0-\u024f]/g,
};

const LANG_LABELS = {
  zh: '中文',
  en: '英语',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  pt: '葡萄牙语',
  it: '意大利语',
  ja: '日语',
  ko: '韩语',
  ru: '俄语',
  ar: '阿拉伯语',
  th: '泰语',
  auto: '未知语言',
};

// 拉丁字母语言的常见虚词：用来区分英 / 西 / 法 / 德 / 葡 / 意，避免把西语 README 当成英文翻译
const LATIN_HINTS = {
  en: ['the', 'and', 'with', 'for', 'this', 'that', 'from', 'your', 'you', 'are', 'can', 'will', 'using', 'use', 'about'],
  es: ['para', 'con', 'una', 'del', 'los', 'las', 'que', 'más', 'también', 'puede', 'de', 'y', 'es', 'son', 'está', 'desde', 'porque'],
  fr: ['les', 'des', 'pour', 'avec', 'une', 'dans', 'est', 'sont', 'vous', 'nous', 'et', 'de', 'sur', 'pas', 'cette', 'être'],
  de: ['der', 'die', 'das', 'und', 'für', 'mit', 'eine', 'auf', 'ist', 'nicht', 'ein', 'auch', 'kann', 'wird', 'sich'],
  pt: ['para', 'com', 'você', 'uma', 'das', 'não', 'muito', 'também', 'pode', 'dos', 'de', 'que', 'são', 'está', 'sobre'],
  it: ['per', 'con', 'che', 'della', 'sono', 'più', 'questo', 'anche', 'può', 'degli', 'di', 'una', 'nel', 'sul', 'essere'],
};

function detectLatinLanguage(text) {
  const tokens = (text || '').toLowerCase().match(/[\u00c0-\u024fA-Za-z]+/g) || [];
  if (tokens.length < 3) return 'en';
  const set = new Set(tokens);
  let best = 'en';
  let bestScore = 1; // 至少要命中 2 个不同虚词才认为不是英语
  for (const [code, words] of Object.entries(LATIN_HINTS)) {
    const hits = words.reduce((sum, w) => sum + (set.has(w) ? 1 : 0), 0);
    if (hits > bestScore) {
      bestScore = hits;
      best = code;
    }
  }
  return best;
}

/**
 * 判断一段文字的语言。
 * 返回 { code, label, isChinese }：isChinese 为 true 时说明已经是中文，不需要再翻译。
 */
function detectLanguage(text) {
  const t = (text || '').trim();
  if (!t) return { code: 'auto', label: LANG_LABELS.auto, isChinese: false };
  const counts = {};
  for (const [key, re] of Object.entries(SCRIPT_RE)) {
    counts[key] = (t.match(re) || []).length;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return { code: 'auto', label: LANG_LABELS.auto, isChinese: false };

  // 有假名是日语、有谚文是韩语（日/韩里都会出现汉字，必须优先判断）
  if (counts.kana > 0) return { code: 'ja', label: LANG_LABELS.ja, isChinese: false };
  if (counts.hangul > 0) return { code: 'ko', label: LANG_LABELS.ko, isChinese: false };
  const ratio = (n) => n / total;
  if (ratio(counts.cyrillic) >= 0.3) return { code: 'ru', label: LANG_LABELS.ru, isChinese: false };
  if (ratio(counts.arabic) >= 0.3) return { code: 'ar', label: LANG_LABELS.ar, isChinese: false };
  if (ratio(counts.thai) >= 0.3) return { code: 'th', label: LANG_LABELS.th, isChinese: false };
  if (ratio(counts.han) >= 0.6) return { code: 'zh', label: LANG_LABELS.zh, isChinese: true };
  if (ratio(counts.latin) >= 0.5) {
    const code = detectLatinLanguage(t);
    return { code, label: LANG_LABELS[code] || LANG_LABELS.en, isChinese: false };
  }
  return { code: 'auto', label: LANG_LABELS.auto, isChinese: false };
}


/* ---------------- 百度翻译开放平台 ---------------- */

const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

// 百度翻译的语种代码与通用写法不同（日 jp、韩 kor、法 fra、西 spa、意 ita…）
const BAIDU_LANG = {
  zh: 'zh',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  ru: 'ru',
  ar: 'ara',
  th: 'tha',
  es: 'spa',
  fr: 'fra',
  de: 'de',
  pt: 'pt',
  it: 'ita',
  auto: 'auto',
};

const BAIDU_ERRORS = {
  52001: '请求超时，请稍后重试',
  52002: '百度翻译服务异常，请稍后重试',
  52003: '未授权用户：APP ID 不正确或未开通通用翻译服务',
  54000: '必填参数为空：请检查 APP ID 与密钥',
  54001: '签名错误：密钥不正确，请核对 APP ID 与密钥是否成对',
  54003: '访问频率限流（标准版 QPS 为 1），稍后会自动重试',
  54004: '账户余额不足，免费额度已用完',
  54005: '长文本请求过于频繁（限流），稍后会自动重试',
  58000: '客户端 IP 非法，请在百度控制台配置 IP 白名单',
  58001: '译文语言方向不支持',
  58002: '服务当前已关闭，请到百度控制台开启',
  90107: '认证未通过或未生效',
};

// 标准版 QPS=1，用最小间隔控制请求节奏，避免 54003
const BAIDU_MIN_INTERVAL = 1100;
let baiduLastCallAt = 0;

async function baiduThrottle() {
  const wait = baiduLastCallAt + BAIDU_MIN_INTERVAL - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  baiduLastCallAt = Date.now();
}

/* ---------------- 有道智云文本翻译 ---------------- */

const YOUDAO_ENDPOINT = 'https://openapi.youdao.com/api';

// 有道 v3 接口的语种代码：简体中文是 zh-CHS，其余多为 ISO 短码
const YOUDAO_LANG = {
  zh: 'zh-CHS',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  ar: 'ar',
  // 有道未提供泰语，交给服务端 auto 识别，避免直接返回 102（不支持的语言类型）
  th: 'auto',
  es: 'es',
  fr: 'fr',
  de: 'de',
  pt: 'pt',
  it: 'it',
  auto: 'auto',
};

const YOUDAO_ERRORS = {
  101: '缺少必填参数',
  102: '不支持的语言类型',
  103: '翻译文本过长',
  104: '不支持的 API 类型',
  105: '不支持的签名类型',
  106: '不支持的响应类型',
  108: '应用 ID 无效（请核对有道控制台里的应用 ID）',
  110: '无相关服务（请确认已开通「文本翻译」服务）',
  111: '开发者账号无效',
  113: '待翻译内容为空',
  202: '签名检验失败（应用密钥不正确或与 App Key 不匹配）',
  203: '访问 IP 不在可访问列表（有道控制台里限制了 IP）',
  205: '请求的接口与绑定的接口不匹配',
  206: '时间戳无效（本机时间与网络时间偏差过大）',
  301: '辞典查询失败',
  302: '翻译查询失败',
  303: '服务端异常，请稍后重试',
  401: '账户已欠费，请到有道控制台充值',
  411: '访问频率受限（QPS 超限），稍后会自动重试',
  412: '长请求过于频繁（限流），稍后会自动重试',
};

// 有道标准版默认 QPS 较严，用 1.1 秒最小间隔自我保护
const YOUDAO_MIN_INTERVAL = 1100;
let youdaoLastCallAt = 0;

async function youdaoThrottle() {
  const wait = youdaoLastCallAt + YOUDAO_MIN_INTERVAL - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  youdaoLastCallAt = Date.now();
}

/**
 * 有道 v3 签名规则：sign = sha256(appKey + input + salt + curtime + appSecret)，
 * 其中 input 在原文长度 > 20 时取「前10 + 长度 + 后10」。
 */
function youdaoInput(q) {
  const s = String(q);
  return s.length <= 20 ? s : `${s.slice(0, 10)}${s.length}${s.slice(-10)}`;
}

function youdaoSign(appKey, q, salt, curtime, appSecret) {
  return crypto.createHash('sha256').update(appKey + youdaoInput(q) + salt + curtime + appSecret).digest('hex');
}

const HEADING_MAP = {
  installation: '安装',
  install: '安装',
  'install requirements': '安装依赖',
  'getting started': '快速开始',
  'quick start': '快速开始',
  'quickstart': '快速开始',
  usage: '使用方法',
  'basic usage': '基本用法',
  'how to use': '如何使用',
  examples: '示例',
  example: '示例',
  demo: '在线演示',
  features: '功能特性',
  'key features': '核心特性',
  highlights: '亮点',
  'what is': '项目简介',
  'what is this': '项目简介',
  screenshot: '界面截图',
  screenshots: '界面截图',
  'preview': '效果预览',
  requirements: '环境要求',
  prerequisites: '前置条件',
  'prerequisites and installation': '前置条件与安装',
  configuration: '配置',
  config: '配置',
  'configuration file': '配置文件',
  'environment variables': '环境变量',
  documentation: '文档',
  docs: '文档',
  api: 'API 接口',
  'api reference': 'API 参考',
  'api documentation': 'API 文档',
  'command line options': '命令行参数',
  'command line': '命令行',
  cli: '命令行工具',
  faq: '常见问题',
  troubleshooting: '故障排查',
  'known issues': '已知问题',
  contributing: '参与贡献',
  'how to contribute': '如何贡献',
  contribution: '贡献指南',
  'contributing guidelines': '贡献指南',
  license: '许可证',
  licenses: '许可证',
  'code of conduct': '行为准则',
  changelog: '更新日志',
  'release notes': '发布说明',
  roadmap: '路线图',
  todo: '待办事项',
  'to do': '待办事项',
  credits: '致谢',
  acknowledgements: '致谢',
  'acknowledgments': '致谢',
  sponsors: '赞助者',
  sponsorships: '赞助',
  'support': '支持我们',
  'support us': '支持我们',
  'star history': 'Star 趋势',
  'star history chart': 'Star 趋势图',
  benchmark: '性能测试',
  benchmarks: '性能测试',
  performance: '性能',
  security: '安全性',
  'security policy': '安全策略',
  'project structure': '项目结构',
  structure: '项目结构',
  'directory structure': '目录结构',
  architecture: '架构设计',
  'how it works': '工作原理',
  'under the hood': '实现原理',
  'build': '构建',
  'build from source': '从源码构建',
  building: '构建',
  'building from source': '从源码构建',
  testing: '测试',
  'run tests': '运行测试',
  'development': '开发',
  'local development': '本地开发',
  'contributors': '贡献者',
  'related': '相关项目',
  'related projects': '相关项目',
  'alternatives': '替代方案',
  'comparison': '对比',
  'why': '为什么选择',
  'why this project': '为什么选择本项目',
  'why use': '为什么使用',
  'use cases': '使用场景',
  'how to install': '如何安装',
  'how to run': '如何运行',
  'how to build': '如何构建',
  'how to deploy': '如何部署',
  'deploy': '部署',
  'deployment': '部署',
  'docker': 'Docker',
  'docker compose': 'Docker Compose',
  'run locally': '本地运行',
  'run with docker': '使用 Docker 运行',
  'download': '下载',
  'downloads': '下载',
  'releases': '版本发布',
  'packages': '软件包',
  'news': '动态',
  'community': '社区',
  'contact': '联系我们',
  'credits and acknowledgements': '致谢',
  'license and credits': '许可证与致谢',
  'table of contents': '目录',
  'contents': '目录',
  'overview': '概览',
  'introduction': '简介',
  'about': '关于',
  'background': '背景',
  'motivation': '动机',
  'design': '设计',
  'design principles': '设计原则',
  'limitations': '局限性',
  'migration': '迁移',
  'upgrade': '升级',
  'upgrading': '升级',
  'uninstall': '卸载',
  'support matrix': '支持矩阵',
  'version': '版本',
  'versions': '版本',
  'notes': '说明',
  'warning': '警告',
  'notes and tips': '提示',
  'tips': '小技巧',
  'tutorial': '教程',
  'tutorials': '教程',
  'guides': '指南',
  'guide': '指南',
  'resources': '资源',
  'awesome': '精选清单',
  'references': '参考资料',
  'citation': '引用',
  'cite': '引用',
};

const GLOSSARY = {
  repository: '仓库',
  repositories: '仓库',
  framework: '框架',
  library: '库',
  toolkit: '工具包',
  'command-line': '命令行',
  'command line': '命令行',
  'open source': '开源',
  'open-source': '开源',
  'self-hosted': '可自托管',
  'self hosted': '可自托管',
  'free and open source': '免费开源',
  'blazing fast': '极速',
  'high performance': '高性能',
  'high-performance': '高性能',
  'cross-platform': '跨平台',
  'batteries included': '开箱即用',
  'out of the box': '开箱即用',
  'easy to use': '易于使用',
  'getting started': '快速开始',
  'machine learning': '机器学习',
  'deep learning': '深度学习',
  'neural network': '神经网络',
  'large language model': '大语言模型',
  'large language models': '大语言模型',
  'artificial intelligence': '人工智能',
  'natural language processing': '自然语言处理',
  'computer vision': '计算机视觉',
  database: '数据库',
  api: '接口',
  server: '服务端',
  client: '客户端',
  plugin: '插件',
  plugins: '插件',
  extension: '扩展',
  extensions: '扩展',
  theme: '主题',
  themes: '主题',
  template: '模板',
  templates: '模板',
  generator: '生成器',
  compiler: '编译器',
  runtime: '运行时',
  engine: '引擎',
  pipeline: '流水线',
  workflow: '工作流',
  automation: '自动化',
  deployment: '部署',
  container: '容器',
  containers: '容器',
  kubernetes: 'Kubernetes',
  docker: 'Docker',
  monitoring: '监控',
  dashboard: '仪表盘',
  analytics: '分析',
  visualization: '可视化',
  'real-time': '实时',
  'realtime': '实时',
  'web-based': '基于网页',
  'web app': 'Web 应用',
  'desktop app': '桌面应用',
  'mobile app': '移动应用',
  'user interface': '用户界面',
  ui: '界面',
  'rest api': 'REST 接口',
  graphql: 'GraphQL',
  authentication: '身份认证',
  authorization: '权限控制',
  encryption: '加密',
  'vulnerability scanner': '漏洞扫描器',
  'penetration testing': '渗透测试',
  scraper: '爬虫',
  crawler: '爬虫',
  'data pipeline': '数据管道',
  'data science': '数据科学',
  'data analysis': '数据分析',
  benchmark: '基准测试',
  benchmarks: '基准测试',
  documentation: '文档',
  tutorial: '教程',
  tutorials: '教程',
  courses: '课程',
  books: '书籍',
  roadmap: '路线图',
  algorithms: '算法',
  'data structures': '数据结构',
  'design patterns': '设计模式',
  interview: '面试',
  'full-stack': '全栈',
  'front-end': '前端',
  'back-end': '后端',
  'boilerplate': '脚手架',
  'starter kit': '起步套件',
  'starter template': '起步模板',
  'component library': '组件库',
  components: '组件',
  'state management': '状态管理',
  bundler: '打包工具',
  'build tool': '构建工具',
  'static site generator': '静态站点生成器',
  'server-side rendering': '服务端渲染',
  'edge computing': '边缘计算',
  'cloud native': '云原生',
  microservices: '微服务',
  serverless: '无服务',
  observability: '可观测性',
  telemetry: '遥测',
  logging: '日志',
  tracing: '链路追踪',
  metrics: '指标',
  'load balancing': '负载均衡',
  'reverse proxy': '反向代理',
  'message queue': '消息队列',
  cache: '缓存',
  storage: '存储',
  'object storage': '对象存储',
  embeddings: '向量嵌入',
  'vector database': '向量数据库',
  inference: '推理',
  'fine-tuning': '微调',
  training: '训练',
  transformer: 'Transformer',
  diffusion: '扩散模型',
  'image generation': '图像生成',
  multimodal: '多模态',
  agent: '智能体',
  agents: '智能体',
  'ai agent': 'AI 智能体',
  prompt: '提示词',
  rag: '检索增强生成',
  'retrieval-augmented generation': '检索增强生成',
  chatbot: '聊天机器人',
  voice: '语音',
  speech: '语音',
  audio: '音频',
  video: '视频',
  images: '图片',
  graphics: '图形',
  rendering: '渲染',
  shader: '着色器',
  animation: '动画',
  editor: '编辑器',
  terminal: '终端',
  shell: 'Shell',
  keyboard: '键盘',
  shortcuts: '快捷键',
  config: '配置',
  configuration: '配置',
  'environment variables': '环境变量',
  install: '安装',
  installation: '安装',
  usage: '使用方法',
  features: '功能',
  feature: '功能',
  recently: '最近',
  updated: '更新',
  'pull request': '拉取请求',
  'pull requests': '拉取请求',
  issue: '问题',
  issues: '问题',
  branch: '分支',
  commit: '提交',
  merge: '合并',
  release: '发布',
  'changelog': '更新日志',
  license: '许可证',
  contributor: '贡献者',
  contributors: '贡献者',
  community: '社区',
  sponsor: '赞助者',
  star: '星标',
  stars: '星标',
  fork: '派生',
  forks: '派生',
  leaderboard: '排行榜',
  ranking: '排名',
  'best practices': '最佳实践',
  'code quality': '代码质量',
  lint: '代码检查',
  linter: '代码检查工具',
  formatter: '格式化工具',
  testing: '测试',
  'unit test': '单元测试',
  'unit tests': '单元测试',
  'end-to-end': '端到端',
  debug: '调试',
  debugging: '调试',
  profiling: '性能分析',
  'memory safety': '内存安全',
  iot: '物联网',
  'home automation': '智能家居',
  'game engine': '游戏引擎',
  'game development': '游戏开发',
  '3d': '3D',
  webgl: 'WebGL',
  webrtc: 'WebRTC',
  'video editing': '视频剪辑',
  'image processing': '图像处理',
  ffmpeg: 'FFmpeg',
  kanban: '看板',
  whiteboard: '白板',
  notes: '笔记',
  'note-taking': '笔记记录',
  productivity: '效率',
  'time management': '时间管理',
  calendar: '日历',
  email: '邮件',
  'file sharing': '文件共享',
  'file transfer': '文件传输',
  proxy: '代理',
  vpn: 'VPN',
  'password manager': '密码管理器',
  secrets: '密钥',
  'access control': '访问控制',
  sso: '单点登录',
  'single sign-on': '单点登录',
  'identity provider': '身份提供方',
  'openid connect': 'OpenID Connect',
  saml: 'SAML',
  'zero trust': '零信任',
  'web security': 'Web 安全',
  malware: '恶意软件',
  exploit: '漏洞利用',
  'reverse engineering': '逆向工程',
  'static analysis': '静态分析',
  'code scanning': '代码扫描',
  'supply chain': '供应链',
  'sbom': '软件物料清单',
  'policy engine': '策略引擎',
};

function normalizeKey(s) {
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[`*_#:!?.()[\]"'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function translateHeadingByGlossary(headingText) {
  const key = normalizeKey(headingText);
  if (!key) return null;
  if (HEADING_MAP[key]) return HEADING_MAP[key];
  const words = key.split(' ');
  if (words.length <= 4 && GLOSSARY[key]) return GLOSSARY[key];
  // 简单词级替换（仅当整行长度较短时）
  let replaced = headingText;
  let hits = 0;
  for (const [en, zh] of Object.entries(GLOSSARY)) {
    if (en.length < 4) continue;
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    replaced = replaced.replace(re, () => {
      hits += 1;
      return zh;
    });
  }
  return hits ? replaced : null;
}

function offlineTranslateMarkdown(markdown) {
  const lines = markdown.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const heading = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/);
    if (heading) {
      const zh = translateHeadingByGlossary(heading[2].replace(/\s*#+\s*$/, ''));
      if (zh) return heading[1] + zh;
      return line;
    }
    return line;
  });
  return out.join('\n');
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function protectInline(text) {
  const slots = [];
  const push = (s) => {
    slots.push(s);
    return `@@${slots.length - 1}@@`;
  };
  const out = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, push)
    .replace(/\[[^\]]*\]\([^)]*\)/g, push)
    .replace(/\[[^\]]*\]\[[^\]]*\]/g, push)
    .replace(/<[^>\n]+>/g, push)
    .replace(/`[^`\n]*`/g, push)
    .replace(/(https?:\/\/|mailto:)[^\s)<>"']+/g, push);
  return { text: out, slots };
}

function restoreInline(text, slots) {
  let out = text;
  for (let i = 0; i < slots.length; i += 1) {
    const pattern = new RegExp(`@\\s*@\\s*${i}\\s*@\\s*@`, 'g');
    out = out.replace(pattern, slots[i]);
  }
  return out;
}

/**
 * 判断一行 Markdown 是否是「值得翻译的正文」。
 * 支持任意外语：英文、日文、韩文、俄文、阿拉伯文等；已经是中文的行直接跳过。
 */
function looksLikeProse(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[-=*_|: ]{3,}$/.test(t)) return false;
  const lang = detectLanguage(t);
  if (lang.isChinese) return false;
  if (lang.code === 'auto') return false;
  const letters = (
    t.match(
      /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/g,
    ) || []
  ).length;
  return letters >= 3;
}

/**
 * 把 README 切分为「代码块 / 正文行」两类片段。
 */
function splitMarkdown(md) {
  const lines = md.split('\n');
  const segments = [];
  let inFence = false;
  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence) inFence = !inFence;
    segments.push({ line, isCode: isFence || inFence });
  }
  return segments;
}

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = -1;
    // 中英日俄等常见断句符号都作为切分点
    for (const sep of ['\n', '. ', '! ', '? ', '; ', '。', '！', '？', '，', '、', ', ', '؛ ']) {
      const idx = rest.lastIndexOf(sep, maxLen);
      if (idx > maxLen * 0.4) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function stripCodeFence(text) {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return m ? m[1] : t;
}

class Translator {
  constructor({ cache, store }) {
    this.cache = cache;
    this.store = store;
    this.offlineOnly = false;
  }

  get provider() {
    const s = this.store.getSettings();
    const p = s.translationProvider || 'mymemory';
    if (p === 'openai' && !(s.openaiApiKey || '').trim()) {
      return { name: 'mymemory', fallbackFrom: 'openai', reason: '未填写 AI 翻译 API Key，已回退到免费在线翻译' };
    }
    if (p === 'zhipu' && !(s.zhipuApiKey || '').trim()) {
      return { name: 'mymemory', fallbackFrom: 'zhipu', reason: '未填写智谱 API Key，已回退到免费在线翻译' };
    }
    if (p === 'agnes' && !(s.agnesApiKey || '').trim()) {
      return { name: 'mymemory', fallbackFrom: 'agnes', reason: '未填写 Agnes API Key，已回退到免费在线翻译' };
    }
    if (p === 'baidu' && (!(s.baiduAppId || '').trim() || !(s.baiduKey || '').trim())) {
      return { name: 'mymemory', fallbackFrom: 'baidu', reason: '未填写百度翻译 APP ID 或密钥，已回退到免费在线翻译' };
    }
    if (p === 'youdao' && (!(s.youdaoAppKey || '').trim() || !(s.youdaoAppSecret || '').trim())) {
      return { name: 'mymemory', fallbackFrom: 'youdao', reason: '未填写有道翻译的应用 ID 或应用密钥，已回退到免费在线翻译' };
    }
    if (p === 'off') return { name: 'off' };
    return { name: p };
  }

  _cacheKey(kind, text) {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    return `tr:${this.provider.name}:${kind}:${hash}`;
  }

  _cached(key) {
    return this.cache.get(key);
  }

  async _myMemoryChunk(text, source = 'en') {
    const s = this.store.getSettings();
    const langpair = `${source}|zh-CN`;
    const params = new URLSearchParams({ q: text, langpair });
    if (s.myMemoryEmail) params.set('de', s.myMemoryEmail);
    const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('MyMemory 免费翻译额度已用完（每日约 5000 词，按出口 IP 计算）');
      }
      throw new Error(`免费翻译接口返回 ${res.status}`);
    }
    const data = await res.json();
    const status = data.responseStatus;
    if (status && Number(status) !== 200) {
      const detail = data.responseDetails || '';
      if (/quota|limit|429|available free translations/i.test(detail) || Number(status) === 429) {
        throw new Error('MyMemory 免费翻译额度已用完（每日约 5000 词，按出口 IP 计算）');
      }
      // 某些小语种没有 zh-CN 直译对，退回「英语 → 中文」再试一次
      if (source !== 'en' && /language pair|not supported|unsupported|invalid/i.test(detail)) {
        const err = new Error(`免费翻译接口不支持 ${source} → 中文（${detail}）`);
        err.retryWithEnglish = true;
        throw err;
      }
      throw new Error(detail || '免费翻译接口额度已用尽');
    }
    const translated = data.responseData && data.responseData.translatedText;
    if (!translated) throw new Error('免费翻译接口没有返回内容');
    if (source !== 'en' && /MYMEMORY WARNING/i.test(translated)) {
      throw new Error('MyMemory 免费翻译额度已用完（每日约 5000 词，按出口 IP 计算）');
    }
    return decodeEntities(translated);
  }

  async _myMemoryChunkWithRetry(text, source = 'en', attempt = 0) {
    try {
      return await this._myMemoryChunk(text, source);
    } catch (err) {
      if (err.retryWithEnglish) return this._myMemoryChunk(text, 'en');
      if (attempt >= 2 || /额度|quota/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return this._myMemoryChunkWithRetry(text, source, attempt + 1);
    }
  }

  async translateTextWithMyMemory(text, source = 'en') {
    const chunks = chunkText(text, 450);
    const results = [];
    for (const chunk of chunks) {
      results.push(await this._myMemoryChunkWithRetry(chunk, source));
      await new Promise((r) => setTimeout(r, 120));
    }
    return results.join('');
  }

  /**
   * 调用一次百度翻译，返回按行拆分的译文数组（q 里的 \n 会被百度按行返回）。
   */
  async _baiduChunk(text, source = 'auto') {
    const s = this.store.getSettings();
    const appid = (s.baiduAppId || '').trim();
    const key = (s.baiduKey || '').trim();
    if (!appid || !key) throw new Error('未配置百度翻译 APP ID 或密钥');
    const salt = String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const sign = crypto.createHash('md5').update(appid + text + salt + key).digest('hex');
    const body = new URLSearchParams({
      q: text,
      from: BAIDU_LANG[source] || 'auto',
      to: 'zh',
      appid,
      salt,
      sign,
    });
    await baiduThrottle();
    const res = await fetch(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`百度翻译接口返回 ${res.status}`);
    const data = await res.json();
    if (data.error_code) {
      const code = String(data.error_code);
      const err = new Error(`百度翻译失败：${BAIDU_ERRORS[code] || data.error_msg || `错误码 ${code}`}`);
      err.baiduCode = code;
      err.retryable = ['52001', '54003', '54005'].includes(code);
      err.fatal = ['52003', '54000', '54001', '54004', '90107', '58000'].includes(code);
      throw err;
    }
    const list = data.trans_result || [];
    if (!list.length) throw new Error('百度翻译没有返回内容');
    return list.map((item) => (item.dst || '').trim()).filter(Boolean);
  }

  async _baiduChunkWithRetry(text, source = 'auto', attempt = 0) {
    try {
      return await this._baiduChunk(text, source);
    } catch (err) {
      if (err.fatal || !err.retryable || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return this._baiduChunkWithRetry(text, source, attempt + 1);
    }
  }

  async translateTextWithBaidu(text, source = 'auto') {
    const chunks = chunkText(text, 1800);
    const results = [];
    for (const chunk of chunks) {
      const lines = await this._baiduChunkWithRetry(chunk, source);
      results.push(lines.join(''));
    }
    return results.join('');
  }

  /**
   * 调用一次有道文本翻译，返回按行拆分的译文数组。
   */
  async _youdaoChunk(text, source = 'auto') {
    const s = this.store.getSettings();
    const appKey = (s.youdaoAppKey || '').trim();
    const appSecret = (s.youdaoAppSecret || '').trim();
    if (!appKey || !appSecret) throw new Error('未配置有道翻译的应用 ID 或应用密钥');
    const salt = crypto.randomUUID();
    const curtime = String(Math.floor(Date.now() / 1000));
    const sign = youdaoSign(appKey, text, salt, curtime, appSecret);
    const body = new URLSearchParams({
      q: text,
      from: YOUDAO_LANG[source] || 'auto',
      to: 'zh-CHS',
      appKey,
      salt,
      sign,
      signType: 'v3',
      curtime,
    });
    await youdaoThrottle();
    const res = await fetch(YOUDAO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`有道翻译接口返回 ${res.status}`);
    const data = await res.json();
    const code = String(data.errorCode || '');
    if (code && code !== '0') {
      const err = new Error(`有道翻译失败：${YOUDAO_ERRORS[code] || `错误码 ${code}`}`);
      err.youdaoCode = code;
      err.retryable = ['411', '412', '303', '206'].includes(code);
      err.fatal = ['108', '111', '202', '401', '203', '110', '205'].includes(code);
      throw err;
    }
    const joined = (data.translation || []).join('');
    if (!joined) throw new Error('有道翻译没有返回内容');
    return joined.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async _youdaoChunkWithRetry(text, source = 'auto', attempt = 0) {
    try {
      return await this._youdaoChunk(text, source);
    } catch (err) {
      if (err.fatal || !err.retryable || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return this._youdaoChunkWithRetry(text, source, attempt + 1);
    }
  }

  async translateTextWithYoudao(text, source = 'auto') {
    const chunks = chunkText(text, 1800);
    const results = [];
    for (const chunk of chunks) {
      const lines = await this._youdaoChunkWithRetry(chunk, source);
      results.push(lines.join(''));
    }
    return results.join('');
  }

  /**
   * 按行批量翻译（README 正文）：每组最多 20 行、约 2000 字符，
   * 组内用换行连接，译完按换行拆回，行数对不上时退化为整段译文。
   */
  async translateBlocksWithYoudao(blocks, sourceLang = 'auto') {
    const out = new Array(blocks.length).fill('');
    const groups = [];
    let current = [];
    let currentChars = 0;
    blocks.forEach((text, index) => {
      if (current.length && (currentChars + text.length > 2000 || current.length >= 20)) {
        groups.push(current);
        current = [];
        currentChars = 0;
      }
      current.push({ text, index });
      currentChars += text.length + 1;
    });
    if (current.length) groups.push(current);

    for (const group of groups) {
      const payload = group.map((g) => g.text).join('\n');
      const lines = await this._youdaoChunkWithRetry(payload, sourceLang);
      if (lines.length === group.length) {
        group.forEach((g, i) => {
          out[g.index] = lines[i];
        });
      } else {
        out[group[0].index] = lines.join(' ');
      }
    }
    return out;
  }

  /**
   * 按行批量翻译（README 正文）：百度对 q 有 6000 字节上限，
   * 这里按字节约 2800 字节、最多 20 行一组，组内换行保留原文结构。
   */
  async translateBlocksWithBaidu(blocks, sourceLang = 'auto') {
    const out = new Array(blocks.length).fill('');
    const groups = [];
    let current = [];
    let currentBytes = 0;
    blocks.forEach((text, index) => {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (current.length && (currentBytes + bytes > 2800 || current.length >= 20)) {
        groups.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push({ text, index });
      currentBytes += bytes + 1;
    });
    if (current.length) groups.push(current);

    for (const group of groups) {
      const payload = group.map((g) => g.text).join('\n');
      const lines = await this._baiduChunkWithRetry(payload, sourceLang);
      if (lines.length === group.length) {
        group.forEach((g, i) => {
          out[g.index] = lines[i];
        });
      } else {
        // 行数对不上（百度把小段落合并/拆分）时退化成整段译文，避免错位
        out[group[0].index] = lines.join(' ');
      }
    }
    return out;
  }

  /**
   * OpenAI 兼容通道的配置：AI 翻译使用用户自定义地址，智谱 / Agnes 使用官方地址。
   */
  _chatConfig(provider) {
    const s = this.store.getSettings();
    if (provider === 'zhipu') {
      const model = (s.zhipuModel || 'glm-4.6v-flash').trim() || 'glm-4.6v-flash';
      return {
        base: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: (s.zhipuApiKey || '').trim(),
        model,
        // glm-4.6v-flash 高峰期经常 429（模型访问量过大），限流时临时改用 glm-4v-flash 兜底
        fallbackModel: model !== 'glm-4v-flash' ? 'glm-4v-flash' : '',
        label: '智谱',
      };
    }
    if (provider === 'agnes') {
      return {
        base: (s.agnesBaseUrl || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, ''),
        apiKey: (s.agnesApiKey || '').trim(),
        model: (s.agnesModel || 'agnes-2.5-flash').trim() || 'agnes-2.5-flash',
        label: 'Agnes',
      };
    }
    return {
      base: (s.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: (s.openaiApiKey || '').trim(),
      model: (s.openaiModel || 'gpt-4o-mini').trim() || 'gpt-4o-mini',
      label: 'AI 翻译',
    };
  }

  async translateBlocksWithOpenAI(blocks, sourceLang = 'auto') {
    return this._translateBlocksWithChat(blocks, sourceLang, this._chatConfig('openai'));
  }

  async translateBlocksWithZhipu(blocks, sourceLang = 'auto') {
    return this._translateBlocksWithChat(blocks, sourceLang, this._chatConfig('zhipu'));
  }

  async translateBlocksWithAgnes(blocks, sourceLang = 'auto') {
    return this._translateBlocksWithChat(blocks, sourceLang, this._chatConfig('agnes'));
  }

  /**
   * 拉取同一家服务的可用模型列表（OpenAI 兼容的 GET /models），供设置面板切换模型。
   * Agnes：GET https://apihub.agnes-ai.com/v1/models
   */
  async listModels(provider) {
    const cfg = this._chatConfig(provider);
    if (!cfg.apiKey) throw new Error(`请先填写${cfg.label} API Key`);
    const res = await fetch(`${cfg.base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${cfg.label}模型列表接口返回 ${res.status}：${body.slice(0, 160)}`);
    }
    const data = await res.json();
    const raw = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    const ids = raw
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
      .filter(Boolean)
      .map((id) => String(id));
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }

  /** 构造一次 chat/completions 请求体。 */
  _chatPayload(texts, cfg, sourceLabel, modelName) {
    return {
      model: modelName || cfg.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            `你是开源项目本地化译者。把用户给出的 JSON 数组里的每个段落翻译成简体中文（源语言可能是${sourceLabel}，也可能是混合语言的段落，请自动识别并只输出中文译文）。` +
            '要求：保留 Markdown 结构、代码、命令、URL、徽章和 @@数字@@ 占位符；技术专有名词（如 React、Docker、Kubernetes）保持英文；' +
            '不要添加解释或前后缀。只输出 JSON：{"items": ["译文1", "译文2", ...]}，数组长度必须与输入一致。',
        },
        { role: 'user', content: JSON.stringify(texts) },
      ],
    };
  }

  /** 解析模型返回的 {"items":[...]}，兼容代码围栏与裸数组。 */
  _parseChatItems(content) {
    const text = stripCodeFence(content || '');
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.items)) return parsed.items;
    } catch (_) {
      /* 继续尝试裸数组 */
    }
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) return arr;
      } catch (_) {
        /* 忽略 */
      }
    }
    return [];
  }

  /** 发一次请求，网络错误与 HTTP 错误都带上可重试标记。 */
  async _chatOnce(texts, cfg, sourceLabel, modelName) {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(this._chatPayload(texts, cfg, sourceLabel, modelName)),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${cfg.label}接口返回 ${res.status}：${body.slice(0, 200)}`);
      err.status = res.status;
      err.retryAfter = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
      throw err;
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    const items = this._parseChatItems(content);
    if (!items.length) throw new Error(`${cfg.label}返回格式无法解析`);
    return items;
  }

  /** 429 / 5xx / 网络超时视为可重试；401、余额不足、格式错误等直接失败。 */
  _isRetryableError(err) {
    const status = Number(err && err.status);
    return Boolean(
      status === 429 ||
        (status >= 500 && status <= 599) ||
        /fetch failed|network|timeout|timed out|abort|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|格式无法解析/i.test(
          (err && err.message) || '',
        ),
    );
  }

  /**
   * 带退避重试的请求：429 / 5xx / 网络超时可以重试，
   * 其余（签名错误、余额不足、格式错误）直接抛出，避免白等。
   * 智谱主模型重试后仍失败时，再换 fallbackModel（glm-4v-flash）试一次。
   */
  async _chatWithRetry(texts, cfg, sourceLabel) {
    const models = [cfg.model];
    if (cfg.fallbackModel && cfg.fallbackModel !== cfg.model) models.push(cfg.fallbackModel);
    let lastError = null;
    for (const model of models) {
      const attempts = model === cfg.model ? CHAT_MAX_ATTEMPTS : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await this._chatOnce(texts, cfg, sourceLabel, model);
        } catch (err) {
          lastError = err;
        }
        // 非限流类错误（401 / 余额不足 / 模型无权访问）换模型也没用，直接抛出
        if (!this._isRetryableError(lastError)) throw lastError;
        if (attempt < attempts) {
          const retryAfter = Number(lastError.retryAfter);
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : 1200 * attempt;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    throw lastError;
  }

  /**
   * OpenAI 兼容通道的批量翻译：
   * - 完全相同的段落只翻译一次，再按索引回填（模型遇到重复项容易把数组压短）
   * - 2 路并发，长 README 的等待时间大约减半
   * - 并发失败（限流 / 连接被拒）时退回串行补一次
   */
  async _translateBlocksWithChat(blocks, sourceLang, cfg) {
    if (!cfg.apiKey) throw new Error(`未配置${cfg.label} API Key`);
    const sourceLabel = LANG_LABELS[sourceLang] || '任意语言';
    const results = new Array(blocks.length).fill('');

    const uniques = [];
    const seen = new Map();
    blocks.forEach((text, index) => {
      if (seen.has(text)) {
        uniques[seen.get(text)].indices.push(index);
        return;
      }
      seen.set(text, uniques.length);
      uniques.push({ text, indices: [index] });
    });

    // 按长度分批，减少请求次数
    const batches = [];
    let current = [];
    let currentLen = 0;
    uniques.forEach((block) => {
      if (current.length && currentLen + block.text.length > CHAT_BATCH_CHARS) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(block);
      currentLen += block.text.length;
    });
    if (current.length) batches.push(current);

    const hasMissing = (batch) => batch.some((b) => b.indices.some((i) => !results[i]));

    const translateBatch = async (batch) => {
      const todo = batch.filter((b) => b.indices.some((i) => !results[i]));
      if (!todo.length) return;
      const items = await this._chatWithRetry(todo.map((b) => b.text), cfg, sourceLabel);
      const filled = new Set();
      todo.forEach((block, i) => {
        const text = items[i];
        if (typeof text === 'string' && text.trim()) {
          block.indices.forEach((idx) => {
            results[idx] = text;
          });
          filled.add(block);
        }
      });
      // 模型偶尔会把多段合并 / 漏段：对缺失的段落逐条补翻，避免半篇英文
      const missing = todo.filter((b) => !filled.has(b)).slice(0, CHAT_FILL_LIMIT);
      for (const block of missing) {
        try {
          const [text] = await this._chatWithRetry([block.text], cfg, sourceLabel);
          if (typeof text === 'string' && text.trim()) {
            block.indices.forEach((idx) => {
              results[idx] = text;
            });
          }
        } catch (_) {
          /* 补翻失败就保留原文，交给上层决定是否降级 */
        }
      }
    };

    const queue = batches.slice();
    const failures = [];
    const worker = async () => {
      while (queue.length) {
        const batch = queue.shift();
        try {
          await translateBatch(batch);
        } catch (err) {
          failures.push({ batch, err });
        }
      }
    };
    const workers = Math.min(CHAT_WORKERS, Math.max(1, batches.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    // 并发失败的批次再串行补一次；仍然失败就把错误抛给上层（会退回离线术语表）
    for (const { batch, err } of failures) {
      if (!hasMissing(batch)) continue;
      // 401 / 余额不足等确定性错误，串行重试也没用，直接抛出
      if (!this._isRetryableError(err)) throw err;
      try {
        await translateBatch(batch);
      } catch (_) {
        throw err;
      }
    }
    return results;
  }

  /**
   * 翻译单段文本（仓库简介等），源语言自动识别（英 / 日 / 韩 / 俄 / 西 / 法 / 德…）。
   */
  async translateText(text, { force = false } = {}) {
    const raw = (text || '').trim();
    if (!raw) return { text: '', engine: 'none', cached: false };
    const lang = detectLanguage(raw);
    if (lang.isChinese) {
      return { text: raw, engine: 'none', cached: true, sourceLang: 'zh', sourceLabel: LANG_LABELS.zh };
    }
    const provider = this.provider;
    if (provider.name === 'off') {
      const zh = translateHeadingByGlossary(raw);
      return {
        text: zh || raw,
        engine: 'offline',
        cached: false,
        partial: !zh,
        sourceLang: lang.code,
        sourceLabel: lang.label,
      };
    }
    const key = this._cacheKey('text', raw);
    if (!force) {
      const hit = this._cached(key);
      if (hit) return { ...hit, cached: true };
    }
    let engine = provider.name;
    try {
      let translated;
      if (provider.name === 'openai') {
        const [out] = await this.translateBlocksWithOpenAI([raw], lang.code);
        translated = out;
      } else if (provider.name === 'zhipu') {
        const [out] = await this.translateBlocksWithZhipu([raw], lang.code);
        translated = out;
      } else if (provider.name === 'agnes') {
        const [out] = await this.translateBlocksWithAgnes([raw], lang.code);
        translated = out;
      } else if (provider.name === 'baidu') {
        translated = await this.translateTextWithBaidu(raw, lang.code);
      } else if (provider.name === 'youdao') {
        translated = await this.translateTextWithYoudao(raw, lang.code);
      } else {
        translated = await this.translateTextWithMyMemory(raw, lang.code);
      }
      const result = {
        text: translated || raw,
        engine,
        cached: false,
        fallbackFrom: provider.fallbackFrom,
        note: provider.reason,
        sourceLang: lang.code,
        sourceLabel: lang.label,
      };
      this.cache.set(key, result, 30 * 24 * 60 * 60 * 1000);
      return result;
    } catch (err) {
      const zh = translateHeadingByGlossary(raw);
      return {
        text: zh || raw,
        engine: 'offline',
        partial: !zh,
        cached: false,
        error: err.message,
        sourceLang: lang.code,
        sourceLabel: lang.label,
      };
    }
  }

  /**
   * 翻译 README Markdown，保留代码块与链接结构。
   */
  async translateMarkdown(markdown, { force = false, maxChars = MARKDOWN_MAX_CHARS } = {}) {
    const raw = (markdown || '').trim();
    if (!raw) return { markdown: '', engine: 'none', cached: false };
    // 取开头一段判断源语言（英 / 日 / 韩 / 俄 / 西 / 法 / 德…）
    const lang = detectLanguage(raw.slice(0, 2000));
    const provider = this.provider;
    if (provider.name === 'off') {
      return {
        markdown: offlineTranslateMarkdown(raw),
        engine: 'offline',
        cached: false,
        degraded: true,
        sourceLang: lang.code,
        sourceLabel: lang.label,
        note: '当前为离线术语表模式，仅汉化了标题与技术名词',
      };
    }
    const key = this._cacheKey('md', raw);
    if (!force) {
      const hit = this._cached(key);
      if (hit) return { ...hit, cached: true };
    }

    const segments = splitMarkdown(raw);
    // 收集需要翻译的行索引：先屏蔽链接/代码/HTML，再用屏蔽后的文本判断是否值得翻译
    const candidates = [];
    let usedChars = 0;
    segments.forEach((seg, index) => {
      if (seg.isCode) return;
      if (/^\s*\|/.test(seg.line)) return; // 表格行容易破坏结构，保持原样
      const protectedText = protectInline(seg.line);
      if (!looksLikeProse(protectedText.text)) return;
      if (usedChars + seg.line.length > maxChars) return;
      const prefixMatch = protectedText.text.match(/^(\s{0,3}(?:#{1,6}|>|[-*+]|\d{1,2}\.)\s+)/);
      const prefix = prefixMatch ? prefixMatch[1] : '';
      const body = prefix ? protectedText.text.slice(prefix.length) : protectedText.text;
      if (!body.trim()) return;
      candidates.push({ index, text: body, prefix, slots: protectedText.slots });
      usedChars += seg.line.length;
    });

    if (!candidates.length) {
      const result = {
        markdown: raw,
        engine: provider.name,
        cached: false,
        sourceLang: lang.code,
        sourceLabel: lang.label,
        note: '这段 README 没有可翻译的正文内容',
      };
      return result;
    }

    let engine = provider.name;
    const translatedTexts = new Array(candidates.length).fill(null);
    try {
      if (provider.name === 'openai') {
        const outs = await this.translateBlocksWithOpenAI(candidates.map((c) => c.text), lang.code);
        outs.forEach((t, i) => {
          if (t) translatedTexts[i] = t;
        });
      } else if (provider.name === 'zhipu') {
        const outs = await this.translateBlocksWithZhipu(candidates.map((c) => c.text), lang.code);
        outs.forEach((t, i) => {
          if (t) translatedTexts[i] = t;
        });
      } else if (provider.name === 'agnes') {
        const outs = await this.translateBlocksWithAgnes(candidates.map((c) => c.text), lang.code);
        outs.forEach((t, i) => {
          if (t) translatedTexts[i] = t;
        });
      } else if (provider.name === 'baidu') {
        // 百度支持按行批量：一次请求翻译整组正文行，返回顺序与输入一致
        const outs = await this.translateBlocksWithBaidu(candidates.map((c) => c.text), lang.code);
        outs.forEach((t, i) => {
          if (t) translatedTexts[i] = t;
        });
      } else if (provider.name === 'youdao') {
        // 有道同样支持按行批量：组内换行连接，译完按行拆回
        const outs = await this.translateBlocksWithYoudao(candidates.map((c) => c.text), lang.code);
        outs.forEach((t, i) => {
          if (t) translatedTexts[i] = t;
        });
      } else {
        // MyMemory：把相邻的正文行合并成 ≤450 字符的块，减少请求数并保留换行结构
        const groups = [];
        let current = [];
        candidates.forEach((candidate, outIdx) => {
          const prev = current[current.length - 1];
          const adjacent = prev && candidate.index === prev.index + 1;
          const currentLen = current.reduce((sum, item) => sum + item.text.length + 1, 0);
          if (current.length && (!adjacent || currentLen + candidate.text.length > 440)) {
            groups.push(current);
            current = [];
          }
          current.push({ ...candidate, outIdx });
        });
        if (current.length) groups.push(current);

        const translateGroup = async (group) => {
          const text = group.map((item) => item.text).join('\n');
          const parts = [];
          for (const chunk of chunkText(text, 450)) {
            parts.push(await this._myMemoryChunkWithRetry(chunk, lang.code));
            await new Promise((r) => setTimeout(r, 40));
          }
          const translated = parts.join('');
          const lines = translated.split('\n');
          if (lines.length === group.length) {
            group.forEach((item, k) => {
              translatedTexts[item.outIdx] = lines[k];
            });
          } else {
            translatedTexts[group[0].outIdx] = translated.replace(/\n+/g, ' ');
          }
        };

        const queue = groups.slice();
        const workers = Array.from(
          { length: Math.min(3, Math.max(1, queue.length)) },
          async () => {
            while (queue.length) {
              const group = queue.shift();
              await translateGroup(group);
            }
          },
        );
        await Promise.all(workers);
      }
    } catch (err) {
      return {
        markdown: offlineTranslateMarkdown(raw),
        engine: 'offline',
        degraded: true,
        cached: false,
        sourceLang: lang.code,
        sourceLabel: lang.label,
        note: `在线翻译失败：${err.message}。已退回到离线术语表（仅汉化标题），在设置中切换为 AI 翻译可解除额度限制。`,
      };
    }

    const outLines = segments.map((s) => s.line);
    let restoredCount = 0;
    candidates.forEach((c, i) => {
      const t = translatedTexts[i];
      if (!t) return;
      const restoredBody = restoreInline(t.trim(), c.slots);
      if (/@@\s*\d+\s*@@/.test(restoredBody)) return; // 占位符被翻译破坏时保留原文
      outLines[c.index] = `${c.prefix}${restoredBody}`;
      restoredCount += 1;
    });

    const result = {
      markdown: outLines.join('\n'),
      engine,
      cached: false,
      fallbackFrom: provider.fallbackFrom,
      note: provider.reason || '',
      sourceLang: lang.code,
      sourceLabel: lang.label,
      translatedLines: restoredCount,
      truncated: usedChars >= maxChars,
    };
    this.cache.set(key, result, 30 * 24 * 60 * 60 * 1000);
    return result;
  }
}

module.exports = {
  Translator,
  detectLanguage,
  offlineTranslateMarkdown,
  HEADING_MAP,
  GLOSSARY,
};
