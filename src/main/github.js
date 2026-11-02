/**
 * GitHub REST API 客户端（只在主进程里跑，避免渲染进程的跨域/限流问题）。
 * 自带磁盘缓存 + 速率限制跟踪。
 */
const API_BASE = 'https://api.github.com';
const UA = 'StarHub-Desktop/1.0';

class GithubError extends Error {
  constructor(message, { status = 0, rateLimited = false, resetAt = 0 } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
    this.expose = true;
  }
}

function mapRepo(item) {
  if (!item) return null;
  const topics = Array.isArray(item.topics) ? item.topics : [];
  return {
    fullName: item.full_name,
    name: item.name,
    owner: item.owner ? item.owner.login : item.full_name.split('/')[0],
    ownerAvatar: item.owner ? item.owner.avatar_url : '',
    htmlUrl: item.html_url,
    description: item.description || '',
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    language: item.language || '未知',
    topics: topics.slice(0, 8),
    license: item.license ? item.license.spdx_id : '',
    updatedAt: item.updated_at,
    pushedAt: item.pushed_at,
    createdAt: item.created_at,
    homepage: item.homepage || '',
    archived: Boolean(item.archived),
    openIssues: item.open_issues_count || 0,
    defaultBranch: item.default_branch || 'main',
  };
}

/**
 * 把 README 中的相对图片/链接改写为 raw.githubusercontent.com 绝对地址，
 * 这样渲染进程可以直接显示图片。
 */
function rewriteReadmeLinks(markdown, fullName, branch) {
  if (!markdown) return '';
  const rawBase = `https://raw.githubusercontent.com/${fullName}/${branch}/`;
  const blobBase = `https://github.com/${fullName}/blob/${branch}/`;
  const isRelative = (url) =>
    !/^(https?:|mailto:|data:|#|ftp:|mailto:|\/\/)/i.test(url.trim());

  let out = markdown.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\s*[^)]*\))/g, (m, pre, url, post) => {
    if (!isRelative(url)) return m;
    return `${pre}${rawBase}${url.replace(/^\.?\//, '').replace(/^\.\//, '')}${post}`;
  });

  out = out.replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (m, pre, url, post) => {
    if (!isRelative(url)) return m;
    return `${pre}${rawBase}${url.replace(/^\.?\//, '')}${post}`;
  });

  out = out.replace(/(<a[^>]+href=["'])([^"']+)(["'])/gi, (m, pre, url, post) => {
    if (!isRelative(url)) return m;
    return `${pre}${blobBase}${url.replace(/^\.?\//, '')}${post}`;
  });

  return out;
}

class GithubApi {
  constructor({ cache, store }) {
    this.cache = cache;
    this.store = store;
    this.rate = { core: null, search: null, updatedAt: 0 };
  }

  _headers(accept) {
    const token = (this.store.getSettings().githubToken || '').trim();
    const headers = {
      'User-Agent': UA,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  _trackRate(res, bucket) {
    try {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const limit = res.headers.get('x-ratelimit-limit');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining !== null) {
        this.rate[bucket] = {
          remaining: Number(remaining),
          limit: Number(limit || 0),
          resetAt: Number(reset || 0) * 1000,
        };
        this.rate.updatedAt = Date.now();
      }
    } catch (_) {
      /* ignore */
    }
  }

  getRateLimit() {
    return { ...this.rate, hasToken: Boolean((this.store.getSettings().githubToken || '').trim()) };
  }

  async request(url, { ttl = 10 * 60 * 1000, accept, force = false, bucket = 'core' } = {}) {
    const cacheKey = `gh:${accept || 'json'}:${url}`;
    if (!force) {
      const hit = this.cache.get(cacheKey);
      if (hit !== null && hit !== undefined) return hit;
    }
    const res = await fetch(url, { headers: this._headers(accept) });
    this._trackRate(res, bucket);

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body && body.message ? body.message : '';
      } catch (_) {
        /* ignore */
      }
      const rateLimited =
        res.status === 403 &&
        (/rate limit/i.test(detail) || /abuse/i.test(detail));
      const resetHeader = res.headers.get('x-ratelimit-reset');
      throw new GithubError(
        rateLimited
          ? `GitHub 接口调用额度已用完${detail ? `（${detail}）` : ''}`
          : `GitHub 接口请求失败：${res.status} ${detail || res.statusText}`,
        {
          status: res.status,
          rateLimited,
          resetAt: Number(resetHeader || 0) * 1000,
        },
      );
    }

    let data;
    if (accept && accept.includes('raw')) {
      data = await res.text();
    } else {
      data = await res.json();
    }
    this.cache.set(cacheKey, data, ttl);
    return data;
  }

  async search({ q, sort = 'stars', order = 'desc', page = 1, perPage = 24, force = false }) {
    const params = new URLSearchParams({
      q,
      sort,
      order,
      per_page: String(perPage),
      page: String(page),
    });
    const url = `${API_BASE}/search/repositories?${params.toString()}`;
    const data = await this.request(url, {
      ttl: 8 * 60 * 1000,
      force,
      bucket: 'search',
    });
    return {
      total: data.total_count || 0,
      incomplete: Boolean(data.incomplete_results),
      items: (data.items || []).map(mapRepo).filter(Boolean),
    };
  }

  async getRepo(fullName, { force = false } = {}) {
    const data = await this.request(`${API_BASE}/repos/${fullName}`, {
      ttl: 3 * 60 * 60 * 1000,
      force,
    });
    return mapRepo(data);
  }

  async getReadme(fullName, { force = false } = {}) {
    const repo = await this.getRepo(fullName);
    const branch = repo.defaultBranch || 'main';
    const cacheKey = `gh:readme:${fullName}:${branch}`;
    if (!force) {
      const hit = this.cache.get(cacheKey);
      if (hit) return hit;
    }
    let markdown = '';
    try {
      markdown = await this.request(`${API_BASE}/repos/${fullName}/readme`, {
        ttl: 6 * 60 * 60 * 1000,
        accept: 'application/vnd.github.raw',
        force,
      });
    } catch (err) {
      if (err.status === 404) {
        markdown = '';
      } else {
        throw err;
      }
    }
    const payload = {
      fullName,
      branch,
      markdown: rewriteReadmeLinks(markdown || '', fullName, branch),
      htmlUrl: `https://github.com/${fullName}#readme`,
      hasReadme: Boolean(markdown),
    };
    this.cache.set(cacheKey, payload, 6 * 60 * 60 * 1000);
    return payload;
  }

  /**
   * 下载量：GitHub 官方没有仓库级下载数，
   * 这里统计最近若干次 Release 附件的累计下载次数（npm 包月下载量等另行展示）。
   */
  async getDownloads(fullName, { force = false, releases = 10 } = {}) {
    const cacheKey = `gh:downloads:${fullName}:${releases}`;
    if (!force) {
      const hit = this.cache.get(cacheKey);
      if (hit) return hit;
    }
    let list = [];
    try {
      list = await this.request(`${API_BASE}/repos/${fullName}/releases?per_page=${releases}`, {
        ttl: 24 * 60 * 60 * 1000,
        force,
      });
    } catch (err) {
      if (err.status === 404) {
        list = [];
      } else {
        throw err;
      }
    }
    const total = Array.isArray(list)
      ? list.reduce(
          (sum, release) =>
            sum +
            (release.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
          0,
        )
      : 0;
    const payload = {
      fullName,
      downloads: total,
      releaseCount: Array.isArray(list) ? list.length : 0,
      latestTag: Array.isArray(list) && list[0] ? list[0].tag_name : '',
      partial: Array.isArray(list) && list.length >= releases,
      fetchedAt: Date.now(),
    };
    this.cache.set(cacheKey, payload, 24 * 60 * 60 * 1000);
    return payload;
  }

  /**
   * 批量取下载量，带并发上限（默认 4），失败不阻断其他仓库。
   */
  async getDownloadsBatch(fullNames, { force = false, concurrency = 4 } = {}) {
    const results = {};
    const queue = fullNames.slice();
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          const r = await this.getDownloads(name, { force });
          results[name] = { downloads: r.downloads, ended: true };
        } catch (err) {
          results[name] = { downloads: null, error: err.message, ended: true };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, fullNames.length) }, () => worker()),
    );
    return results;
  }

  async getLanguages(fullName) {
    return this.request(`${API_BASE}/repos/${fullName}/languages`, {
      ttl: 24 * 60 * 60 * 1000,
    });
  }
}

module.exports = { GithubApi, GithubError, mapRepo, rewriteReadmeLinks, API_BASE };
