/**
 * 内置精选库：离线可用，自带人工整理的中文名与中文简介。
 * 在线模式下拉到的仓库如果在内置库里，也会自动补上中文信息。
 */
const raw = require('../data/curated.json');
const { buildTags, isAppRepo } = require('../shared/tags');

// 分类 → 预置标签，让内置库的仓库也有稳定的中文标签
const CATEGORY_TAGS = {
  ai: 'AI 与大模型',
  web: 'Web 应用',
  backend: '库与 SDK',
  mobile: '移动应用',
  desktop: '桌面应用',
  app: '桌面应用',
  devtools: '命令行工具',
  devops: 'DevOps 与运维',
  data: '数据与数据库',
  learning: '学习与教程',
  security: '安全与隐私',
  automation: '自动化与爬虫',
  media: '图形与多媒体',
};

const byFullName = new Map();
const items = raw.items.map((entry) => {
  const [owner, name] = entry.full_name.split('/');
  const repo = {
    fullName: entry.full_name,
    name,
    owner,
    ownerAvatar: `https://github.com/${owner}.png?size=64`,
    htmlUrl: `https://github.com/${entry.full_name}`,
    description: '',
    stars: entry.stars || 0,
    forks: 0,
    language: entry.language || '未知',
    topics: entry.tags || [],
    license: '',
    updatedAt: '',
    createdAt: '',
    homepage: '',
    archived: false,
    zhName: entry.name_zh || '',
    zhDesc: entry.desc_zh || '',
    category: entry.category,
    curated: true,
    source: 'curated',
    downloads: null,
    preTags: CATEGORY_TAGS[entry.category] ? [CATEGORY_TAGS[entry.category]] : [],
  };
  repo.tags = buildTags(repo);
  byFullName.set(repo.fullName, repo);
  return repo;
});

function get(fullName) {
  return byFullName.get(fullName) || null;
}

function zhInfo(fullName) {
  const item = byFullName.get(fullName);
  if (!item) return null;
  return { zhName: item.zhName, zhDesc: item.zhDesc, category: item.category };
}

function list({ category = 'all', keyword = '', tag = '', sort = 'stars', page = 1, pageSize = 24 } = {}) {
  let result = items.slice();
  if (category === 'app') {
    // 「应用」分类：把所有成品应用（桌面 / 移动 / Web / CLI / 扩展 / 编辑器插件）都归到这里
    result = result.filter((r) => isAppRepo(r));
  } else if (category && category !== 'all') {
    result = result.filter((r) => r.category === category);
  }
  if (tag) {
    const wanted = tag.toLowerCase();
    result = result.filter(
      (r) =>
        (r.tags || []).some((t) => t.toLowerCase() === wanted) ||
        (r.topics || []).some((t) => t.toLowerCase() === wanted),
    );
  }
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(
      (r) =>
        r.fullName.toLowerCase().includes(kw) ||
        (r.zhDesc || '').toLowerCase().includes(kw) ||
        (r.zhName || '').toLowerCase().includes(kw) ||
        (r.topics || []).some((t) => t.toLowerCase().includes(kw)) ||
        (r.tags || []).some((t) => t.toLowerCase().includes(kw)),
    );
  }
  if (sort === 'alpha') {
    result.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  } else if (sort === 'updated') {
    result.sort((a, b) => a.fullName.localeCompare(b.fullName));
  } else {
    result.sort((a, b) => b.stars - a.stars);
  }
  const total = result.length;
  const start = (page - 1) * pageSize;
  return {
    items: result.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
  };
}

function categoryCounts() {
  const counts = {};
  for (const item of items) {
    counts[item.category] = (counts[item.category] || 0) + 1;
  }
  // 「全部」是不过滤分类的汇总视图
  counts.all = items.length;
  // 「应用」是跨分类视图：统计内置库里所有成品应用
  counts.app = items.filter((r) => isAppRepo(r)).length;
  return counts;
}

function tagCounts() {
  const counts = {};
  for (const item of items) {
    for (const tag of item.tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return counts;
}

module.exports = {
  list,
  get,
  zhInfo,
  categoryCounts,
  tagCounts,
  totalCount: items.length,
  updatedAt: raw.updatedAt,
  note: raw.note,
};
