# StarHub · GitHub 高星项目库（桌面端）

把 GitHub 上 Star 数高、口碑好的开源项目 / 仓库聚合到一个桌面客户端里：按用途分类、按 Star 或下载量排序、应用内直接预览 README、自动把任意外语项目汉化成中文、显示原站地址，并支持收藏与点赞。

基于 Electron 33 + 原生 HTML/CSS/JS 构建，运行时只依赖 GitHub 官方 REST API 与可选的翻译接口，所有本地数据（收藏、点赞、缓存、配置）只存在本机。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. 按用途分类 | 14 个分类：**全部**（不限定分类的汇总视图）、AI 与大模型、前端与网站、后端与 API、移动与跨端、桌面客户端、**应用**、开发工具与终端、DevOps 与云原生、数据与数据库、学习与教程、安全与隐私、自动化与爬虫、图形与多媒体，外加「高星精选」全站榜；每个分类带 GitHub 搜索条件与离线兜底。「全部」在线查询为 `stars:>1000`（不限定 topic），离线则汇总整个精选库。「应用」是跨分类视图：在线模式按 `topic:app` 拉取，内置精选库用标签判定（桌面 / 移动 / Web / 命令行 / 浏览器扩展 / 编辑器插件），把成品应用集中在一起，而不混入框架与类库 |
| 2. 按 Star 数 / 下载量 / 首字母排序 | 排序项：Star 最多、下载量最高、**首字母 A-Z**、最近更新、新晋热门；下载量 = 最近 10 个 Release 的全部附件 `download_count` 累计。GitHub 不提供全站下载量排序与首字母排序，因此先取 Star 最高的一批仓库再在本地重排（界面会提示这一点） |
| 3. 应用内预览 | 详情抽屉内直接渲染 README（Markdown → HTML，DOMPurify 消毒），支持原文 / 中文预览切换，相对图片与相对链接会自动改写到 `raw.githubusercontent.com` / `github.com` 绝对地址 |
| 4. 外语自动汉化 | 自动识别源语言（英语 / 日语 / 韩语 / 俄语 / 阿拉伯语 / 泰语 / 西班牙语 / 法语 / 德语 / 葡萄牙语 / 意大利语），翻译成简体中文；列表简介与 README 正文都能自动汉化，结果落盘缓存。五层引擎：AI 翻译（任意 OpenAI 兼容接口，质量最好、无额度上限）→ 百度翻译（填 APP ID + 密钥，按字符计费，源语种用 `auto` 自动识别）→ 有道翻译（填应用 ID + 应用密钥，v3 签名，按字符计费）→ MyMemory 免费接口（无需 Key）→ 离线术语表（断网可用，只覆盖英文标题与术语） |
| 5. 显示原站地址 | 卡片上「原站」按钮、详情页「原站地址」行 + 「打开原站 / 复制链接」，外链一律走系统浏览器 |
| 6. 收藏与点赞 | 卡片与详情页都可一键收藏 / 点赞，即时写入 `library.json`，侧边栏显示数量并能单独筛选；收藏为心形、点赞为拇指，选中后实心高亮 |
| 7. 标签与标签搜索 | 每个仓库自动打上中文标签（形态类：桌面应用 / 移动应用 / Web 应用 / 命令行工具 / 浏览器扩展 / 编辑器插件 / GitHub Action / 可自托管 / 库与 SDK / 模板与脚手架；用途类：AI 与大模型 / 数据与数据库 / DevOps / 安全 / 自动化 / 图形与多媒体 / 学习 / 笔记与效率 / 通讯 / 游戏 / 物联网 / 区块链），最多 6 个。搜索框里输入标签名（中文或英文别名，如「桌面应用」「cli」「docker」）会给出标签建议，点击建议或卡片上的标签即按该标签筛选，结果仍可按 Star / 下载量 / 首字母排序 |
| 8. 亮 / 暗主题 | 标题栏右上角一个按钮切换亮色与暗色（暗色显示月亮、亮色显示太阳），配色覆盖侧边栏、工具栏、卡片、详情抽屉、README 正文、弹窗与状态栏；窗口底色和右上角系统按钮（最小化 / 最大化 / 关闭）同步换色。选择写入 `settings.json` 的 `theme` 字段，同时用 `localStorage` 做首屏上色，重启后保持上次的选择 |


另外附带一个 **内置精选库（108 个仓库）**：人工整理的中文名称与简介，Star 数为离线快照，断网或接口额度用尽时依然可以浏览、分类、按标签筛选、收藏。

## 运行

```powershell
npm install          # 安装依赖后自动执行 postinstall，复制 marked / DOMPurify 到 renderer/vendor
npm start            # 启动应用
npm run dev          # 启动并打开开发者工具
```

如果 `npm install` 在受限网络下无法下载 Electron，可手动安装并解压 Electron 到 `node_modules/electron/dist`（保持 `path.txt` 内容为 `electron.exe`，不要带 BOM），再执行 `node scripts/prepare-vendor.js`。

## 打包安装包（Windows 安装向导）

```powershell
npm run dist:installer
```

产物：`dist-installer/StarHub-Setup-1.0.0-x64.exe`（约 83 MB）。脚本会自动完成三件事：

1. `scripts/make-icon.js` 生成应用图标 `build/icon.ico`（16/24/32/48/64/128/256 多尺寸，蓝色渐变圆角方块 + 白色五角星，纯 Node 绘制，不依赖图形库）；
2. 把 `使用说明.txt` 写入 `build/`，随安装包放到安装目录根下；
3. 调用 electron-builder（配置见 `electron-builder.yml`）产出 NSIS 安装包。

安装包特性：向导式安装、可自选安装目录、默认按当前用户安装（`%LOCALAPPDATA%\Programs\StarHub`，不需要管理员权限）、自动创建桌面与开始菜单快捷方式、控制面板可卸载、卸载时保留 `%APPDATA%\StarHub` 里的设置 / 收藏 / 缓存。

打包过程会下载 Electron 运行时与 NSIS 工具；脚本已默认走 npmmirror 镜像，镜像不可用时可删掉 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 两处环境变量改用 GitHub。`dist-installer/win-unpacked/` 是未压缩的同版本目录（可用于免安装验证）。

## 打包便携版

```powershell
npm run pack
```

产物：`dist/StarHub-win32-x64/StarHub.exe`（绿色版，整个目录复制即可运行，无需安装）。

打包前请先关闭已经打开的 StarHub——运行中的程序会锁定 `dist` 里的运行时文件（如 `icudtl.dat`），脚本会提示你关闭后重试。

脚本会同时在产物目录生成 **`使用说明.txt`**（运行方式、三选一的汉化引擎配置步骤、GitHub Token、数据位置、常见问题），发给别人时可以一起发，对方照着做就能开箱即用。

> 发给他人的注意事项：翻译凭据只保存在各自电脑的 `%APPDATA%\StarHub\settings.json`，**不会打进安装包**。对方首次打开会看到列表上方的「汉化引擎还没配置」引导条，点「去配置（3 步）」或「获取百度 APP ID」按提示填写即可；不填则使用 MyMemory 免费额度（README 自动汉化只翻前 2500 字符）。

## 自检与预览

```powershell
node node_modules\electron\cli.js . --smoke    # 分步自检 + 截图，数据写入工程内 .userdata-smoke，不影响真实配置
node node_modules\electron\cli.js . --preview  # 只截图整窗与侧边栏
```

如需把自检数据放到别处，用环境变量 `STARHUB_USER_DATA` 指定绝对路径。

该脚本只复制 Electron 运行时与应用代码（`src/`、`renderer/`），不打包 `node_modules`——渲染层用的是 `renderer/vendor` 里的本地脚本，主进程只用 Electron 内置模块。

## 配置（可选）

点击标题栏「设置」：

- **GitHub Personal Access Token**：匿名调用每小时只有 60 次、搜索每分钟 10 次；填入 Token 后提升到每小时 5000 次。Token 只保存在本机 `settings.json`，界面上以 `••••••` 掩码显示。
- **翻译引擎**：
  - `AI 翻译（推荐）`：填 Base URL、API Key、模型名（DeepSeek / Kimi / 通义 / OpenAI 等任意 OpenAI 兼容 `/chat/completions` 接口）。
  - `百度翻译`：填百度翻译开放平台的 **APP ID** 与 **密钥**（接口地址 `https://fanyi-api.baidu.com/api/trans/vip/translate` 已内置，无需填写）。源语种用 `auto` 由百度自动识别，标准版 QPS 为 1，程序内置 1.1 秒请求间隔并针对 52001 / 54003 / 54005 自动重试；54001 签名错误、54004 余额不足等会直接以中文提示原因。
  - `有道翻译`：填网易有道智云的 **应用 ID** 与 **应用密钥**（接口地址 `https://openapi.youdao.com/api` 与 v3 签名已内置，无需填写）。源语种按识别结果传 `from`、目标固定 `zh-CHS`，同样内置 1.1 秒间隔与 411 / 412 / 206 重试；108 应用 ID 无效、202 签名失败、401 欠费等错误码会转成中文提示。凭据需成对填写，缺任一项都会回退到免费翻译。
  - `MyMemory（免费）`：无需 Key，有每日额度，适合翻译简介；长 README 可能触发 429，失败时自动退回离线术语表。
  - `离线术语表`：只用内置标题词典与术语表，完全不联网。
- **自动汉化**：两个开关——「自动汉化列表简介」（加载列表后自动翻译缺中文的简介）、「自动汉化 README」（打开详情即在后台翻译）；源语言自动识别。
  - AI 翻译：整篇自动汉化，无每日额度。
  - 百度翻译：自动模式先翻 README 前 5000 个字符（按字符计费，避免一次开详情就耗掉大量额度），剩余内容点「重新汉化」再翻。
  - 有道翻译：与百度相同，自动模式先翻前 5000 个字符（按字符计费），剩余内容点「重新汉化」再翻。
  - MyMemory：自动模式先翻 README 前 2500 个字符（保护每日约 5000 词的免费额度），剩余内容点「重新汉化」再翻；额度用尽后自动熔断 10 分钟，避免反复失败。
- **MyMemory 邮箱**（可选）：填写的邮箱会作为该免费接口的 `de` 参数，提高每日额度。

主题不占用设置面板：点标题栏最左侧的 **亮 / 暗按钮**（暗色时显示月亮、亮色时显示太阳）即可切换，选择会立刻写进 `settings.json`，下次启动直接沿用。

## 让全站内容自动变成中文（推荐配置）

1. 打开「设置」，把「翻译引擎」切到 **AI 翻译**，填入任意 OpenAI 兼容接口的 Base URL / Key / 模型（DeepSeek、Kimi、通义、OpenAI 均可）；或者切到 **百度翻译 / 有道翻译**，只填各自的 APP ID + 密钥（接口地址与签名都已内置）。
2. 勾选「自动汉化列表简介」与「自动汉化 README」。
3. 之后浏览任何分类、任何语种（英 / 日 / 韩 / 俄 / 西 / 法 / 德 / 葡 / 意 / 阿 / 泰）的仓库：列表简介自动变中文，点开详情后 README 也会在后台整篇汉化并自动切到「中文预览」。
4. 翻译结果写入本地缓存（30 天），同一个仓库只翻一次，后续打开秒开中文。

如果暂时不想配 Key，保持默认的 MyMemory 免费引擎也能自动汉化，只是每天约 5000 词的额度会被 README 消耗得比较快（自动模式已做限量与熔断保护）。

## 数据存放

均为 Electron `userData` 目录下的 JSON / 缓存文件（Windows 默认 `%APPDATA%\StarHub`；用 `--user-data-dir` 启动时会写入指定目录）：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 接口 Token、翻译引擎配置、每页数量、亮 / 暗主题等 |
| `library.json` | 收藏与点赞列表（含仓库快照，断网时也能看） |
| `cache/` | GitHub 与翻译结果的磁盘缓存（搜索 8 分钟、仓库 3 小时、README 6 小时、下载量 24 小时、翻译 30 天，最多 4000 个文件） |

设置里的「清空缓存」可随时释放，收藏与点赞不受影响。

## 代码结构

```
src/
  main/
    main.js      主进程：窗口、IPC、列表聚合、汉化调度、--smoke 自检
    preload.js   contextBridge 暴露的最小 API
    github.js    GitHub REST 封装（搜索 / 详情 / README / Release 下载量 / 语言 / 额度）
    translate.js 三层翻译引擎 + Markdown 结构化汉化（保护代码块、表格、链接、行内代码）
    cache.js     磁盘缓存
    store.js     settings.json / library.json 读写（原子写入）
    curated.js   内置精选库查询（分类 / 标签 / 首字母排序）
  data/curated.json   108 个仓库的人工中文资料
  shared/categories.js 分类、排序、语言常量
  shared/tags.js       标签体系（形态 / 用途、英文别名、打标与标签搜索）
renderer/
  index.html / styles.css / app.js   无打包器的渲染层（原生 JS）
  vendor/                            marked.umd.js、purify.min.js（postinstall 复制）
scripts/
  prepare-vendor.js  复制前端依赖
  package-win.js     便携版打包
```

## 安全设计

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染层只能调用 preload 暴露的最小 API。
- 页面带 CSP（`script-src 'self'`，不使用内联事件处理器），README HTML 一律经 DOMPurify 消毒。
- `will-navigate` 与 `setWindowOpenHandler` 只放行 `http(s)` 外链，且用系统浏览器打开。

## 已知限制

- GitHub 搜索最多返回 1000 条结果，超出时界面会提示用关键词缩小范围。
- 「首字母 A-Z」排序无法由 GitHub 接口直接完成：在线模式只在 Star 最高的 100 个结果内重排（界面有提示），内置精选库则按全部结果重排。
- 「应用」分类在在线模式依赖 `topic:app`，标签由仓库名称 / 简介 / topics 自动推断，可能个别项目归类偏严或偏松；标签可在界面上点击，用来做更精确的二次筛选。
- 匿名额度容易用尽（详情页会提示填 Token）；额度耗尽时「内置精选库」仍完全可用。
- 下载量统计依赖各仓库发布 Release 附件，不发 Release 的项目显示「无 Release」。
- 内置精选库为人工整理的快照（Star 数为离线值），联网时会自动按 `full_name` 合并实时中文资料。
- 语种识别按 Unicode 文字区段 + 常见虚词判断：日 / 韩 / 俄 / 阿 / 泰靠字符集即可准确识别；拉丁字母语言（英 / 西 / 法 / 德 / 葡 / 意）靠虚词打分，极短的句子可能仍按英语处理——这类情况用 AI 翻译最稳。离线术语表只覆盖英文标题与术语，无法翻译其他语种正文。
- 百度 / 有道翻译按字符计费且有 QPS 限制（标准版约 1 次/秒），首次打开长 README 会逐组请求、速度比 AI 翻译慢；额度用尽或签名失败时会转成中文错误提示，并退回离线术语表。
