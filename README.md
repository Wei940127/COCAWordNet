# COCAWordNet 🔥

**以词网络记单词** —— 基于 BNC/COCA 10000 词族表的交互式词网学习应用。

不是按列表背单词，而是把每个单词和它有关系的词（同义词、反义词、同族派生、语义相关词……）连成一张可交互的网络。点一个词，网就往外扩一圈——像滚雪球一样成片地记，而不是孤立地背。

![preview](screenshot.png)

## ✨ 特性

- **词关系网络**：10,000 个词头、158,000+ 条关系边（平均每词 15.8 个相关词），力导向图交互，点击节点无限扩展
  - 同义词 / 反义词 / 上位词 / 下位词（来自 WordNet）
  - 同族派生：act → action, actor, acting（来自 Paul Nation 官方词族表）
  - 语义相关：dog → cat, pet, horse（来自 GloVe 词向量）
  - 七种关系线采用烟花配色，全图 15 色唯一，掌握度颜色不混淆
- **词典信息**：每个词带音标、中文释义、英文释义、考纲标签（四六级/考研/托福/雅思/GRE）
- **美式发音**：真人美音（有道词典接口），离线自动回退浏览器语音合成；快捷键 P
- **词根词缀拆解**：1,369 个词有构词分析（前缀/词根/后缀分段染色 + 中文释义），如 impossible = im-(不) + poss(能够) + ible(可…的)；并给出同根词网（vision → television, advise, supervise…）
- **高频搭配**：6,718 个词有从 1,700 万词维基语料统计的真实搭配，如 make → make sure / make up，点击即发音
- **掌握度三态**：未学 / 学习中 / 已掌握，节点变色 + 顶部进度条，localStorage 自动保存
- **进度地图**：按 1k–10k 词频层的进度热力图，自动标出短板层，点击直接开刷
- **进度导入导出**：学习进度可一键导出为 JSON 文件备份，换浏览器/换电脑随时恢复
- **搜索联想**：支持词族成员跳转，搜 government 直达词头 govern（24,000+ 条别名映射）
- **可装成 App**：支持「添加到主屏幕」（PWA），拥有独立图标、全屏无浏览器边框运行；Service Worker 预缓存整个词库，**断网也能用**

## 🚀 快速开始

### 方式一：本地直接打开
下载本仓库（`Code ▾` → `Download ZIP`），解压后**双击 `index.html`** 即可，无需安装任何东西。

### 方式二：部署到 GitHub Pages（推荐，手机也能用）
1. Fork 或使用本仓库模板创建你自己的仓库
2. 仓库页 → `Settings` → `Pages` → `Source` 选 `Deploy from a branch`，Branch 选 `main` / `(root)`，保存
3. 一分钟后访问 `https://wei940127.github.io/COCAWordNet/`

也可以用任何静态托管（Vercel / Netlify / Cloudflare Pages），直接导入仓库即可，无需构建。

### 方式三：装到 iPad / iPhone（当作 App 用，推荐）
无需 App Store、无需越狱、无需签名。用 Safari 打开线上地址后「添加到主屏幕」即可，效果等同原生 App：

1. 在 iPad 上用 **Safari**（必须是 Safari，Chrome / 微信内置浏览器不支持添加到主屏幕）打开
   `https://wei940127.github.io/COCAWordNet/`
2. 等待首次加载完成（约 7MB 词库，会显示进度圈；之后从缓存秒开）
3. 点击 Safari 地址栏右侧的 **分享按钮 ⬆**（若无地址栏，先轻点屏幕顶部唤出）
4. 在弹出菜单中下滑，选择 **「添加到主屏幕」**
5. 右上角点 **「添加」**

主屏幕上会出现 **COCAWordNet** 图标。之后：
- 从图标进入即 **全屏运行**，没有地址栏和标签页，和 App 一样
- **断网也能用**（首次打开后词库已缓存到本地；仅「真人美音」需要联网，断网会自动回退为系统语音合成）
- 学习进度存在 iPad 本地，不会被清理；换设备时用「进度地图 → 导出/导入」迁移

> 想同步到 iPhone？同一地址重复上面步骤即可。Android 用 Chrome 打开会直接提示「安装应用」。

### 本地起服务（可选）
```bash
python -m http.server 8765
# 打开 http://127.0.0.1:8765
```

## 📖 使用指南

| 操作 | 说明 |
|---|---|
| **点击节点** | 选中该词，网络向外扩展一层相关词 |
| **点击图例中的关系名** | 只显示/隐藏某类关系线 |
| **搜索框** | 输入单词（支持词族成员联想），回车跳转 |
| **词频层按钮 1k–10k** | 筛选某一千词范围的词，分层攻关 |
| **右侧详情面板** | 释义、音标（可点发音）、词族、词根拆解、搭配 |
| **点击搭配 / 同根词按钮** | 直接发音 / 跳进词网继续扩展 |
| **进度地图（M）** | 1k–10k 逐层进度 + 短板提示；弹窗底部可**导出/导入进度**（JSON 文件，可备份或迁移到其他设备） |
| **◎ 聚焦 / ✕ 清空** | 收回网络到当前词 / 重置画布 |
| **分享链接** | 选中词后地址栏会带上 `#单词`（如 `index.html#technology`），打开即直接展开该词的网络 |

**快捷键**

- `N` —— 随机跳到下一个未掌握的词
- `F` —— 聚焦当前词
- `P` —— 播放当前词的美音
- `M` —— 打开进度地图

**学习进度**保存在浏览器 localStorage 中，换浏览器/设备不会同步；如需备份，可从 DevTools → Application → Local Storage 导出 `coca10000.*` 键值。

## 🗂 数据来源与致谢

| 数据 | 来源 |
|---|---|
| 10,000 词族表 | [Paul Nation's BNC/COCA word family lists](https://www.wgtn.ac.nz/lals/resources/paul-nations-resources/paul-nations-resources) (Victoria University of Wellington), v2.0.0 |
| 同义词/反义词/上下位词 | [WordNet](https://wordnet.princeton.edu/) (Princeton University) |
| 语义相关词 | [GloVe](https://nlp.stanford.edu/projects/glove/) 6B 50d 词向量 (Stanford NLP) |
| 释义/音标/中文翻译 | [ECDICT](https://github.com/skywind3000/ECDICT) 开源英汉词典 |
| 搭配语料 | [text8](http://mattmahoney.net/dc/textdata.html) (Wikipedia corpus) |
| 美式真人发音 | 有道词典在线接口（离线回退 Web Speech API） |
| 图形渲染 | [D3.js](https://d3js.org/) v7（已本地化，无 CDN 依赖） |

## 🛠 技术说明

- 纯静态单页应用：`index.html + app.js + style.css + data.js + d3.min.js`（图标 `favicon.ico` / `icon.png`），零依赖、零构建
- `data.js`（约 7MB）为预计算的 JSON 数据：词表、关系边、词典、构词、搭配
- 离线 / 可安装：`sw.js`（Service Worker）预缓存应用外壳与整个词库，`manifest.webmanifest` + `apple-touch-icon.png` 提供「添加到主屏幕」能力（PWA）
- 学习状态（掌握度）存于 localStorage，不上传任何数据
- 建议使用 Chrome / Edge / Firefox 现代浏览器；iPad 上请用 Safari 添加到主屏幕

## 📄 License

MIT —— 详见 [LICENSE](LICENSE)。词表与词典数据版权归各数据来源所有，仅用于学习用途。
