# SimMusic Next 扩展开发文档

一个扩展是一个目录，至少包含清单 `plugin.json` 和一个 JavaScript 入口（默认 `main.js`）：

```text
exampleMusic/
├── plugin.json
└── main.js
```

本文按以下顺序组织：

1. [`plugin.json` 清单](#pluginjson-清单)：扩展是谁、需要什么权限、提供哪些协议 / 菜单 / 播放页。
2. [扩展导出的函数](#扩展导出的函数)：实现各项功能时，入口脚本里需要导出哪些函数，主程序何时调用它们。
3. 各类接口：[全局对象](#全局对象)、[`sim.plugin` 等基础信息](#基础信息接口)、[`sim.permissions`](#simpermissions-接口)、[`sim.fetch`](#simfetch-接口)、[`sim.fs`](#simfs-接口)、[`sim.path`](#simpath-接口)、[`sim.settings`](#simsettings-接口)、[`sim.media`](#simmedia-接口)、[`sim.dialog`](#simdialog-接口)、[`sim.ui`](#simui-接口)、[`sim.sidebar`](#simsidebar-接口)、[`sim.index`](#simindex-接口)、[`sim.shell`](#simshell-接口)、[`sim.clipboard`](#simclipboard-接口)、[`sim.webview`](#simwebview-接口)、[`sim.player`](#simplayer-接口)、[`sim.playPage`](#simplaypage-接口)、[`sim.plugins`](#simplugins-接口)。
4. 页面一侧的接口：[`simHost`](#simhost-接口页面内)、[`simPlayer`](#simplayer-接口播放页内)、[主程序提供的页面资源](#主程序提供的页面资源)。
5. [打包与调试](#打包与调试)。

**运行环境。** 入口脚本按 CommonJS 的写法导出：`module.exports = { ... }` 或 `exports.xxx = ...`。可以使用标准的 ECMAScript 语法与内置对象（`Promise`、`async / await`、`JSON`、`Map` 等），以及本文列出的全局对象和 `sim`。**没有** `require`、`import`、`process`、Node.js 模块，也没有 `window`、`document`、全局 `fetch`、`XMLHttpRequest`；第三方库需要事先打包进入口文件。需要网页界面时用 [`sim.webview`](#simwebview-接口) 打开扩展自己的页面。

**两个目录。** `sim.plugin.dir` 是扩展自己的代码目录（随包附带的文件在这里）；`sim.plugin.dataDir` 是扩展自己的数据目录，读写它不需要任何权限，需要持久保存的文件放在这里。相对路径不会以这两个目录为基准，始终用 `sim.path.join(sim.plugin.dataDir, ...)` 构造绝对路径。

---

# `plugin.json` 清单

清单描述扩展的身份、它请求的权限，以及它向主程序声明的协议、歌曲菜单和播放页。

```json
{
    "id": "exampleMusic",
    "name": "示例音乐",
    "version": "1.0.0",
    "author": "你的名字",
    "description": "一个在线音源。",
    "main": "main.js",
    "permissions": ["network", "sidebar", "trackMenu", "clipboard.write"],
    "hosts": ["api.example.com", "*.cdn.example.com"],
    "schemes": [{ "scheme": "example", "download": true }],
    "trackMenus": [
        { "key": "copyId", "label": "复制单曲 ID", "icon": "ECD5", "selection": "single", "permissions": ["clipboard.write"] }
    ]
}
```

## 字段总览

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 扩展标识，安装后不能更改。匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，不能以 `.` 结尾，不能是 `CON`、`NUL`、`COM1` 等 Windows 保留名 |
| `name` | 建议 | 显示名称；设置页里本扩展的分区标题固定为 `扩展：${name}` |
| `version` | 建议 | 版本字符串；发布更新时递增 |
| `author`、`description` | 否 | 作者与介绍 |
| `main` | 否 | 入口脚本在包内的相对路径，默认 `main.js`。不能是绝对路径，不能含 `\`、`:`、`..` |
| `permissions` | 否 | 请求的权限数组，见[权限](#permissions权限) |
| `hosts` | 否 | 网络域名白名单，见 [hosts](#hosts网络域名白名单) |
| `schemes` | 否 | 本扩展注册的歌曲协议，见 [schemes](#schemes注册歌曲协议) |
| `schemeExtensions` | 否 | 对其他扩展已注册协议的追加，见 [schemeExtensions](#schemeextensions追加已有协议) |
| `capabilities.download` | 否 | `schemes` 各项未写 `download` 时的默认值 |
| `trackMenus` | 否 | 歌曲菜单声明，见 [trackMenus](#trackmenus歌曲菜单) |
| `playPages` | 否 | 本扩展提供的播放页，见 [playPages](#playpages播放页) |

## `permissions`：权限

一项能力必须**在清单中声明**并且**获得用户授权**才可用。用户在安装时可以逐项关闭，之后也可以随时撤销或恢复。权限不足时调用对应接口会抛出异常。

| 权限 | 对应能力 |
| --- | --- |
| `network` | `sim.fetch`；返回 HTTP(S) 的封面、音频、歌词等资源；webview 加载 `http(s)://` 页面 |
| `fs.read` | 读取数据目录以外的文件、目录与音频元数据 |
| `fs.write` | 在数据目录以外创建、修改、删除文件；`sim.media.writeTags` |
| `sidebar` | 侧栏分区与“工具”分组条目（`getSidebar` 等导出函数）、`sim.sidebar.*`、`sim.ui.refresh` |
| `trackMenu` | 歌曲菜单（`trackMenus`、`getTrackActions`、`onTrackAction`），以及下载菜单项 |
| `scheme.extend` | `schemeExtensions`：追加其他扩展的协议 |
| `shell` | `sim.shell.*`：系统文件菜单、打开路径 / URL、在资源管理器中显示、运行本机程序 |
| `clipboard.write` | `sim.clipboard.writeText` |
| `webview` | `sim.webview.*`：面板、独立窗口、离屏页面与 Cookie |
| `player` | `sim.player`、`sim.playPage`，以及播放页里的 `simPlayer` |
| `playPage` | 提供播放页（`playPages`），需同时具有 `player` |
| `plugin` | `sim.plugins.*`：扩展管理 |

不需要任何权限的能力：读写自己的数据目录、`sim.settings`、日志、`sim.dialog`、`sim.ui.toast / alert / invalidateMusic`、`sim.index`、注册自己的协议。

## `hosts`：网络域名白名单

填域名，不是完整 URL。`*.example.com` 匹配所有子域名但**不含** `example.com` 本身，需要时另列一项。省略或为空数组时不限制域名。白名单同时约束 `sim.fetch`、扩展返回的网络资源（封面、音频、歌词地址）以及 webview 加载的远程页面。

```json
{ "permissions": ["network"], "hosts": ["api.example.com", "*.cdn.example.com"] }
```

## `schemes`：注册歌曲协议

歌曲在主程序中以 `{ source, id }` 引用：`source` 是协议名，`id` 是该协议内稳定且唯一的字符串。要提供歌曲，扩展必须注册至少一个协议。

| 字段 | 含义 |
| --- | --- |
| `scheme` | 协议名，匹配 `^[a-z][a-z0-9+.-]*$`。已被其他扩展注册的协议名会使本扩展加载失败 |
| `download` | 该协议的歌曲是否可以下载，默认取 `capabilities.download`，再默认为 `false` |
| `handlers` | 把协议函数映射到入口导出的函数名：`getMusicInfo`、`getDownload`、`getTrackActions`、`onTrackAction`。省略的项使用同名导出函数；显式写出的函数必须存在，否则加载失败 |
| `trackMenus` | 只作用于该协议的歌曲菜单，格式同顶层 `trackMenus` |

只注册一个协议的扩展，返回歌曲引用时可以省略 `source`；注册多个协议时必须填写。

```json
{
    "permissions": ["network", "trackMenu"],
    "schemes": [
        { "scheme": "service-a", "download": true, "handlers": { "getMusicInfo": "serviceAInfo" } },
        { "scheme": "service-b", "handlers": { "getMusicInfo": "serviceBInfo" } }
    ]
}
```

## `schemeExtensions`：追加已有协议

为其他扩展注册的协议覆盖处理函数、改变下载能力或追加歌曲菜单。需要 `scheme.extend` 权限，并且在扩展管理中排在协议提供者**之后**加载（用户可以拖动调整加载顺序）。

格式与 `schemes` 的项相同，区别是：

- `handlers` 必须显式写出，不会自动采用同名导出函数；
- 目标协议尚未注册时本扩展加载失败；未获得 `scheme.extend` 授权时这些声明被忽略；
- 多个扩展追加同一协议时，后加载者的同名处理函数生效；没有被覆盖的部分沿用原协议；
- 追加扩展返回的资源由追加扩展自己的 `network` / `fs.read` 权限与 `hosts` 约束。

```json
{
    "id": "examplePatch",
    "name": "示例协议补充",
    "version": "1.0.0",
    "permissions": ["scheme.extend", "network", "trackMenu"],
    "schemeExtensions": [
        { "scheme": "example", "download": true, "handlers": { "getDownload": "patchedDownload" } }
    ]
}
```

## `trackMenus`：歌曲菜单

在歌曲的右键菜单中添加操作，需要 `trackMenu` 权限。顶层 `trackMenus` 作用于本扩展声明的全部协议；写在某个 `schemes` / `schemeExtensions` 项里的只作用于该协议。

| 字段 | 含义 |
| --- | --- |
| `key` | 菜单项标识，不能为空，不能含 `/` |
| `label` | 显示文字 |
| `icon` | RemixIcon 的十六进制码位，如 `"ECD5"`，可省略 |
| `scenes` | 出现的场合：`"list"`（歌曲列表）、`"play"`（播放页）、`"queue"`（播放队列）。省略表示全部 |
| `selection` | `"single"` 只在选中一首时出现，`"multiple"` 只在选中至少两首时出现；省略不限 |
| `permissions` | 该菜单项依赖的其他权限；任一项未授权时菜单项不出现 |
| `children` | 静态子菜单，项的格式相同 |
| `dynamic` | 为 `true` 时子菜单在展开时由 `getTrackActions` 动态给出 |

- 用户可以在权限管理里逐项开关菜单项，对应的 key 是 `scheme:<协议名>/<菜单路径>`，例如 `scheme:example/quality/lossless`。动态子项跟随其声明的父项。
- 协议声明了 `download: true` 时，主程序自动提供“下载曲目”菜单项（key 为 `scheme:<协议名>/download`）。不要自己声明 key 为 `download` 的项。
- 选中的歌曲来自不同协议时，只显示主程序自己的通用操作。

```json
{
    "permissions": ["trackMenu", "clipboard.write"],
    "trackMenus": [
        { "key": "copyId", "label": "复制单曲 ID", "selection": "single", "permissions": ["clipboard.write"] },
        { "key": "quality", "label": "播放音质", "scenes": ["play"], "selection": "single", "dynamic": true },
        { "key": "share", "label": "分享", "children": [
            { "key": "link", "label": "复制链接" },
            { "key": "text", "label": "复制歌名" }
        ] }
    ]
}
```

## `playPages`：播放页

声明本扩展提供的播放页，需要 `playPage` 与 `player` 两项权限（不需要 `webview`）。用户在“设置 → 播放界面 → 播放页选项”里从所有可用的播放页中选一个使用。一个清单最多声明 16 个。

| 字段 | 含义 |
| --- | --- |
| `id` | 扩展内唯一，匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `name` | 选择界面里显示的名称，必填 |
| `description` | 选择界面里显示的介绍 |
| `preview` | 包内预览图的相对路径（PNG、JPEG、WebP、GIF、SVG，不超过 8 MiB），可省略 |
| `url` | 包内页面的相对路径，可带查询串；不能是远程地址 |
| `background` | 页面底色 `#rrggbb`：页面绘制前的底色，也是窗口按钮区域的底色。省略时为白色，`dark` 时为黑色 |
| `dark` | 深色页面，窗口按钮使用浅色图标 |
| `windowButtons` | 为 `true` 时由页面自己绘制收起、最小化、最大化、关闭按钮，主程序不再把自己的按钮盖在页面右上角 |

```json
{
    "permissions": ["playPage", "player"],
    "playPages": [
        { "id": "vinyl", "name": "唱片机", "description": "一张旋转的唱片。", "preview": "pages/vinyl.png", "url": "pages/vinyl.html", "background": "#101820", "dark": true }
    ]
}
```

页面里能做什么见 [`simPlayer` 接口（播放页内）](#simplayer-接口播放页内)。

---

# 扩展导出的函数

主程序通过调用入口脚本导出的函数来使用扩展。实现某项功能，就导出对应的函数；不需要的不导出。

```js
module.exports = {
    init: async () => { /* ... */ },
    getMusicInfo: async (ids, scene, scheme) => { /* ... */ },
    search: async (keyword, words) => { /* ... */ }
};
```

通用规则：

- 只有**入口脚本顶层执行结束时**已经导出的函数才会被识别，之后再挂到 `module.exports` 上的不算。
- 函数可以返回值，也可以返回 Promise，主程序会等待它完成。返回值必须能表示为 JSON（资源字段可以用 [`File`](#file)）。
- 每个函数都有等待时限（见下表）。**超时会使扩展被停止**，用户需要重新加载它。
- 函数抛出异常或 Promise 被拒绝时，详情写入扩展日志，用户只会看到一句固定的提示。预期内的取消（用户关掉了对话框）直接 `return` 即可。
- 扩展被停用、重新加载、调整加载顺序时会重新启动，`init` 会再次执行；没有“卸载前”的回调，重要数据应在变化时立即保存。

| 功能 | 需要导出的函数 | 需要的清单声明 | 时限 |
| --- | --- | --- | --- |
| 初始化 | `init` | — | 入口顶层 10 秒，`init` 30 秒 |
| 提供歌曲信息、播放与下载 | `getMusicInfo`，可选 `getDownload` | `schemes` | 1 分钟 |
| 搜索 | `search` | `schemes` | 30 秒 |
| 接收系统“打开方式”传来的文件 | `openFiles` | `schemes` | 1 分钟 |
| 侧栏分区与工具条目 | `getSidebar`、`onSidebarOpen`，可选 `onSidebarAdd`、`getSidebarMenu`、`onSidebarMenu` | 权限 `sidebar` | `getSidebar` 20 秒，`getSidebarMenu` 10 秒，其余 10 分钟 |
| 设置项 | `getSettings`，可选 `onSettingChange`、`onAction` | — | 10 秒 / 30 秒 / 1 分钟 |
| 歌曲菜单 | `onTrackAction`，可选 `getTrackActions` | `trackMenus`，权限 `trackMenu` | 1 分钟 / 10 秒 |
| 播放页消息 | `onPlayPageMessage` | `playPages`，权限 `playPage`、`player` | 10 秒 |

## `init`

- **介绍**：扩展每次启动后调用一次（安装、启用、重新加载、应用启动）。用于异步初始化。此时界面可能尚未就绪，不要在这里创建 webview。
- **入参**：`init()`，无参数。
- **出参**：无。返回的 Promise 被拒绝时扩展加载失败。
- **调用示例**
  ```javascript
  let token = "";
  exports.init = async () => {
      token = sim.settings.get("token", "");
      console.log("已加载", sim.plugin.name, sim.plugin.version);
      // 日志：已加载 示例音乐 1.0.0
  };
  ```

## `getMusicInfo`

- **介绍**：提供歌曲的全部信息。主程序按“场景”分批索取：列表里要显示歌曲时索取 `list`，将要播放（包括预取下一首）时索取 `play`，下载时索取 `download`。同一批的 id 属于同一个协议。
- **入参**：`getMusicInfo(ids, scene, scheme)`
  其中，`ids` 是歌曲 id 的字符串数组；`scene` 是 `"list"`、`"play"` 或 `"download"`；`scheme` 是协议名。
- **出参**：信息对象的数组。每个请求的 id 都要有一个对应的对象（按 `id` 字段对应，顺序不限），缺少任何一首都算失败。各场景应包含的字段：

  | 场景 | 字段 |
  | --- | --- |
  | `list` | `id`、`title`、`artist`、`album`、`duration`（秒）、`cover`。五个信息字段缺一不可：没有艺术家 / 专辑时给空串，没有封面时给 `null` |
  | `play` | `id`、`playback`（音频资源），可选 `lyrics`（歌词）、`largeCover`（播放页用的大图）、`format`（音频格式提示）。可以只返回这些新增字段 |
  | `download` | `id`、`download`（音频资源），可选 `ext`（文件扩展名，不带点，如 `"flac"`）、`lyrics`。可以只返回这些新增字段 |

  任何场景都可以带 `extra`：任意 JSON 数据，主程序原样带回歌曲菜单的歌曲对象。

  **资源字段**（`cover`、`largeCover`、`playback`、`download`、`lyrics`）可以是：
  - 一个 [`File`](#file)：`sim.fs.file(path)`、`sim.media.coverFile(path)` 或 `new File(...)`；
  - 一个网络资源 `{ url, headers?, expire? }`：`url` 必须是 HTTP(S) 地址，`headers` 是请求它时附带的请求头，`expire` 是从返回这一刻起的有效**秒数**；
  - `lyrics` 另外可以直接是 LRC 文本。

  关于有效期：标题、艺术家、歌词文本等普通数据会被主程序长期记住，不再重复索取；网络资源在 `expire` 秒内被记住，到期后重新索取；没有 `expire`（且信息对象顶层也没有 `expire` 作为默认值）的地址只用于这一次；`File` 每次需要时都重新索取。带签名的地址应按实际有效期留出余量。

  回退规则：没有 `largeCover` 时使用 `cover`；没有 `download` 时使用 `playback`。

- **调用示例**
  - 在线音源：
    ```javascript
    exports.getMusicInfo = async (ids, scene, scheme) => {
        const songs = await lookupSongs(ids, scene);   // 扩展自己实现的远端查询
        return songs.map(song => ({
            id: String(song.id),
            title: song.title,
            artist: song.artist || "",
            album: song.album || "",
            duration: song.durationSeconds,
            cover: song.smallCover ? { url: song.smallCover, expire: 86400 } : null,
            ...(scene === "play" ? {
                playback: { url: song.playUrl, headers: { Referer: "https://example.com/" }, expire: 270 },
                largeCover: song.largeCover ? { url: song.largeCover, expire: 86400 } : null,
                lyrics: song.lrc || ""
            } : {}),
            ...(scene === "download" ? { download: { url: song.downloadUrl, expire: 270 }, ext: "flac", lyrics: song.lrc || "" } : {})
        }));
    };
    // getMusicInfo(["123"], "list", "example") 返回：
    // [{ id: "123", title: "示例歌曲", artist: "示例歌手", album: "示例专辑", duration: 215.4,
    //    cover: { url: "https://cdn.example.com/123-s.jpg", expire: 86400 } }]
    // 列表中 id 为 123 的一行显示出标题、歌手、专辑、时长和封面
    ```
  - 本地文件（id 就是文件路径）：
    ```javascript
    exports.getMusicInfo = async (ids, scene) => {
        if (scene === "list") {
            const metas = await sim.media.readMetadata(ids);
            return metas.map(meta => ({
                id: meta.path, title: meta.title, artist: meta.artist, album: meta.album, duration: meta.duration,
                cover: meta.hasCover ? sim.media.coverFile(meta.path) : null
            }));
        }
        return ids.map(id => ({ id, playback: sim.fs.file(id), lyrics: sim.media.readLyrics(id) }));
    };
    // getMusicInfo(["D:\\Music\\a.flac"], "play", "example") 返回：
    // [{ id: "D:\\Music\\a.flac", playback: File, lyrics: "[00:01.00]第一句\n[00:05.20]第二句" }]
    ```

## `getDownload`

- **介绍**：可选。单独提供下载资源，优先于 `getMusicInfo` 在 `download` 场景返回的 `download`。主要供[追加已有协议](#schemeextensions追加已有协议)的扩展替换下载来源。协议未声明 `download: true`，或用户关闭了下载菜单项时不会被调用。
- **入参**：`getDownload(track, scheme)`
  其中，`track` 是歌曲对象 `{ source, id, title, artist, album, duration, extra }`；`scheme` 是协议名。
- **出参**：一个资源（`File` 或 `{ url, headers?, expire? }`），或者 `{ download, ext?, lyrics?, expire? }`。
- **调用示例**
  ```javascript
  exports.getDownload = async (track, scheme) => {
      const data = await lookupDownload(track.id);   // 扩展自己实现的查询
      return { download: { url: data.url, expire: 300 }, ext: "flac" };
  };
  // getDownload({ source: "example", id: "123", title: "示例歌曲", ... }, "example") 返回：
  // { download: { url: "https://cdn.example.com/123.flac?sign=...", expire: 300 }, ext: "flac" }
  // 下载页出现该歌曲的下载任务，保存为 .flac 文件
  ```

## `search`

- **介绍**：响应用户的搜索。只需要返回歌曲引用，标题等信息由主程序随后经 `getMusicInfo` 索取。
- **入参**：`search(keyword, words)`
  其中，`keyword` 是用户输入的原文；`words` 是分好的词（去掉首尾空白、转为小写），适合做本地匹配。
- **出参**：歌曲引用数组 `[{ source, id }]`。只注册了一个协议时 `source` 可省略。只搜索本扩展时按返回顺序显示；搜索全部音源时由主程序统一按相关度排序。
- **调用示例**
  ```javascript
  exports.search = async (keyword, words) => {
      const response = await sim.fetch("https://api.example.com/search?q=" + encodeURIComponent(keyword));
      return response.json().songs.map(song => ({ source: "example", id: String(song.id) }));
  };
  // search("晴天 周杰伦", ["晴天", "周杰伦"]) 返回：
  // [{ source: "example", id: "123" }, { source: "example", id: "456" }]
  // 搜索页列出这两首歌
  ```

## `openFiles`

- **介绍**：用户通过系统的“打开方式”或文件右键菜单把文件交给 SimMusic 时调用。主程序按加载顺序依次询问各扩展，第一个返回非空数组的扩展接收这些文件，返回的歌曲立即作为播放队列开始播放。
- **入参**：`openFiles(paths)`
  其中，`paths` 是文件绝对路径数组。
- **出参**：歌曲引用数组；不能处理时返回空数组。
- **调用示例**
  ```javascript
  exports.openFiles = paths => paths
      .filter(path => [".mp3", ".flac"].includes(sim.path.extname(path).toLowerCase()))
      .map(path => ({ source: "example", id: path }));
  // openFiles(["D:\\Music\\a.flac", "D:\\说明.txt"]) 返回：
  // [{ source: "example", id: "D:\\Music\\a.flac" }]
  // 主窗口开始播放 a.flac
  ```

## `getSidebar`

- **介绍**：给出扩展在侧栏里的内容：自己的分区，以及放进主程序“工具”分组的条目。主程序在启动、扩展调用 `sim.sidebar.refresh()`、以及 `onSidebarAdd` / `onSidebarMenu` 结束之后调用它。
- **入参**：`getSidebar()`，无参数。
- **出参**：`{ title, canAdd, items, tools }`
  其中，`title` 是分区标题（为空则不显示分区）；`canAdd` 为 `true` 时标题旁显示“+”按钮；`items` 是分区里的条目 `[{ id, name }]`；`tools` 是放进“工具”分组的条目 `[{ id, name, icon }]`，排在搜索、下载之后，`icon` 是 RemixIcon 十六进制码位。`items` 与 `tools` 的 `id` 不要重复。只想放工具条目时可以不给 `title`。
- **调用示例**
  ```javascript
  exports.getSidebar = () => ({
      title: "示例音乐",
      canAdd: true,
      items: sim.settings.get("lists", []).map(list => ({ id: list.id, name: list.name })),
      tools: [{ id: "store", name: "示例商店", icon: "F450" }]
  });
  // 返回：{ title: "示例音乐", canAdd: true, items: [{ id: "fav", name: "我的收藏" }], tools: [{ id: "store", name: "示例商店", icon: "F450" }] }
  // 侧栏出现“示例音乐”分区（标题旁有“+”），其下有“我的收藏”；“工具”分组末尾多出“示例商店”
  ```

## `onSidebarAdd`

- **介绍**：用户点击分区标题旁的“+”时调用。可以弹出对话框、导入并保存数据。结束后主程序自动重新读取侧栏。
- **入参**：`onSidebarAdd()`，无参数。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onSidebarAdd = async () => {
      const name = await sim.dialog.prompt("新建列表", "列表名称", "");
      if (!name) return;
      const id = String(Date.now());
      sim.settings.set("lists", [...sim.settings.get("lists", []), { id, name, tracks: [] }]);
      sim.sidebar.open(id);
  };
  // 用户输入“通勤”并确定后：侧栏分区里多出“通勤”，主界面切换到这个空列表
  ```

## `onSidebarOpen`

- **介绍**：用户点击本扩展的侧栏条目（分区里的或“工具”分组里的）时调用，`sim.sidebar.open(id)` 也会触发它。
- **入参**：`onSidebarOpen(id)`
  其中，`id` 是 `getSidebar` 给出的条目 id。
- **出参**：两种用法：
  - 返回 `{ title, details, tracks }`，主界面显示这个歌曲列表。`title` 是列表标题；`details` 是标题下方的信息行 `[{ icon?, text }]`，可省略；`tracks` 是歌曲引用数组。
  - 不返回任何值，表示扩展自己处理了这次点击——典型做法是在函数里创建一个 [`sim.webview.panel`](#new-simwebviewpaneloptions)，主界面内容区就显示这个面板。
- **调用示例**
  - 显示歌曲列表：
    ```javascript
    exports.onSidebarOpen = id => {
        const list = sim.settings.get("lists", []).find(item => item.id === id);
        if (!list) return null;
        return {
            title: list.name,
            details: [{ icon: "EDFC", text: list.tracks.length + " 首" }, { text: "来自示例音乐" }],
            tracks: list.tracks.map(trackId => ({ source: "example", id: trackId }))
        };
    };
    // onSidebarOpen("fav") 返回：
    // { title: "我的收藏", details: [{ icon: "EDFC", text: "2 首" }, { text: "来自示例音乐" }],
    //   tracks: [{ source: "example", id: "123" }, { source: "example", id: "456" }] }
    // 主界面显示标题为“我的收藏”的歌曲列表，标题下方一行是“2 首 · 来自示例音乐”
    ```
  - 显示自己的页面：
    ```javascript
    let storePanel = null;
    exports.onSidebarOpen = id => {
        if (id !== "store") return null;
        storePanel = new sim.webview.panel({ url: "ext://pages/store.html" });
        storePanel.onclose = () => { storePanel = null; };
    };
    // 无返回值
    // 主界面内容区显示扩展目录中的 pages/store.html
    ```

## `getSidebarMenu`

- **介绍**：用户右键点击本扩展的侧栏条目时调用，给出右键菜单。不导出则没有菜单。
- **入参**：`getSidebarMenu(id)`
  其中，`id` 是条目 id。
- **出参**：菜单项数组。菜单项为 `{ key, label, icon? }`，分隔线为 `{ separator: true }`。
- **调用示例**
  ```javascript
  exports.getSidebarMenu = id => [
      { key: "refresh", label: "刷新", icon: "F064" },
      { separator: true },
      { key: "remove", label: "移除", icon: "ED74" }
  ];
  // 条目旁弹出菜单：刷新 / ——— / 移除
  ```

## `onSidebarMenu`

- **介绍**：用户点击了 `getSidebarMenu` 给出的菜单项时调用。结束后主程序自动重新读取侧栏。
- **入参**：`onSidebarMenu(id, key)`
  其中，`id` 是条目 id，`key` 是菜单项的 key。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onSidebarMenu = async (id, key) => {
      if (key === "refresh") sim.sidebar.open(id);
      if (key === "remove" && await sim.dialog.confirm("确定移除这个列表？")) {
          sim.settings.set("lists", sim.settings.get("lists", []).filter(list => list.id !== id));
      }
  };
  // onSidebarMenu("fav", "remove")，用户确认后：侧栏中“我的收藏”消失；它正在显示时主界面回到首页
  ```

## `getSettings`

- **介绍**：声明扩展的设置项。它们显示在设置页中本扩展唯一的分区里，标题固定为 `扩展：${name}`。
- **入参**：`getSettings()`，无参数。
- **出参**：设置项数组。通用字段：`type`、`key`、`label`、`default`，可选 `desc`（说明文字）、`badge`（标签）。各类型：

  | `type` | 值 | 附加字段 |
  | --- | --- | --- |
  | `text` | 字符串 | — |
  | `toggle` | 布尔值 | — |
  | `select` | 字符串 | `options`：`[{ value, label }]` |
  | `slider` | 数字 | `min`、`max`；`max` 不超过 4 时步长 0.05，否则为 1 |
  | `color` | 颜色字符串 | — |
  | `button` | 无 | `button`：按钮文字，默认“配置”；点击后调用 `onAction(key)` |

  设置值与 `sim.settings` 是同一份存储：界面上改动 `key` 即写入 `sim.settings` 的同名键。`default` 在设置页第一次读取本函数时才写入，脚本里读取时仍应给 `sim.settings.get` 传默认值。
- **调用示例**
  ```javascript
  exports.getSettings = () => [
      { type: "text", key: "apiEndpoint", label: "API 地址", default: "" },
      { type: "toggle", key: "translation", label: "显示翻译", default: true },
      { type: "select", key: "quality", label: "音质", default: "standard", options: [
          { value: "standard", label: "标准" }, { value: "lossless", label: "无损" }
      ] },
      { type: "slider", key: "parallel", label: "并行请求数", default: 4, min: 1, max: 16 },
      { type: "color", key: "accent", label: "强调色", default: "#1E9FFF" },
      { type: "button", key: "login", label: "账号", button: "登录" }
  ];
  // 设置页出现“扩展：示例音乐”分区，依次是输入框、开关、下拉框、滑块、取色器和一个“登录”按钮
  ```

## `onSettingChange`

- **介绍**：用户在设置页改动了本扩展的设置项后调用。新值此时已经保存。拖动滑块期间会被连续调用，不要在这里做昂贵的操作。脚本自己调用 `sim.settings.set` **不会**触发它。
- **入参**：`onSettingChange(key, value)`
  其中，`key` 是设置项的 key，`value` 是新值。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onSettingChange = (key, value) => {
      if (key === "quality") sim.index.clear(["playback"]);
      if (key === "translation") sim.index.clear(["lyrics"]);
  };
  // onSettingChange("quality", "lossless")：之后播放的歌曲重新索取播放地址；正在播放的这一首不受影响
  ```

## `onAction`

- **介绍**：用户点击了 `type: "button"` 的设置项时调用。
- **入参**：`onAction(key)`
  其中，`key` 是该设置项的 key。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onAction = async key => {
      if (key !== "login") return;
      const token = await sim.dialog.prompt("登录", "粘贴 Token", sim.settings.get("token", ""));
      if (!token) return;
      sim.settings.set("token", token);
      sim.ui.toast("已保存");
  };
  // 点击“登录”：弹出输入框；确定后界面底部提示“已保存”
  ```

## `getTrackActions`

- **介绍**：给出 `dynamic: true` 的歌曲菜单项的子菜单。可能被多次调用（展开菜单时、执行操作前复核时），不要在里面产生副作用。
- **入参**：`getTrackActions(tracks, scene, parentKey, scheme)`
  其中，`tracks` 是选中的歌曲对象数组 `[{ source, id, title, artist, album, duration, extra }]`；`scene` 是 `"list"`、`"play"` 或 `"queue"`；`parentKey` 是被展开的父项路径（如 `"quality"`）；`scheme` 是协议名。
- **出参**：菜单项数组 `[{ key, label, icon? }]`。
- **调用示例**
  ```javascript
  exports.getTrackActions = async (tracks, scene, parentKey, scheme) => {
      if (parentKey !== "quality") return [];
      return [{ key: "standard", label: "标准" }, { key: "lossless", label: "无损" }];
  };
  // getTrackActions([{ source: "example", id: "123", ... }], "play", "quality", "example") 返回：
  // [{ key: "standard", label: "标准" }, { key: "lossless", label: "无损" }]
  // “播放音质”展开出“标准”“无损”两个子项
  ```

## `onTrackAction`

- **介绍**：用户点击了本扩展的歌曲菜单项时调用。
- **入参**：`onTrackAction(key, tracks, scene, scheme)`
  其中，`key` 是菜单项的路径，子菜单用 `/` 连接（如 `"quality/lossless"`、`"share/link"`）；`tracks`、`scene`、`scheme` 同 `getTrackActions`。歌曲对象里没有播放或下载地址。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onTrackAction = (key, tracks, scene, scheme) => {
      if (key === "copyId") {
          sim.clipboard.writeText(tracks[0].id);
          sim.ui.toast("已复制");
      }
      if (key.startsWith("quality/")) {
          sim.settings.set("quality", key.split("/")[1]);
          sim.index.clear(["playback"]);
          sim.ui.toast("切换歌曲后生效");
      }
  };
  // onTrackAction("copyId", [{ source: "example", id: "123", ... }], "list", "example")：
  // 剪贴板内容变为 123，界面底部提示“已复制”
  ```

## `onPlayPageMessage`

- **介绍**：本扩展的播放页调用 `simPlayer.postMessage(data)` 时调用。用 [`sim.playPage.postMessage`](#simplaypagepostmessage) 回复。
- **入参**：`onPlayPageMessage(pageId, data)`
  其中，`pageId` 是清单 `playPages` 里的 `id`，`data` 是页面发来的数据。
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onPlayPageMessage = (pageId, data) => {
      if (data.type === "getSettings") sim.playPage.postMessage({ type: "settings", values: sim.settings.all() });
      if (data.type === "saveSetting") sim.settings.set(data.key, data.value);
  };
  // onPlayPageMessage("vinyl", { type: "getSettings" })：播放页收到 message 事件，数据为 { type: "settings", values: { ... } }
  ```

---

# 全局对象

除 `sim` 之外，入口脚本里还可以直接使用以下全局对象。

## `console`

- **介绍**：写入本扩展的运行日志（在扩展管理中该扩展的“日志”里查看，保留最近 200 条）。对象参数会被转成 JSON。不要把 Cookie、Token 等写进日志。
- **入参**：`console.log(...args)`、`console.info(...args)`、`console.warn(...args)`、`console.error(...args)`
- **出参**：无。
- **调用示例**
  ```javascript
  console.log("加载完成", { count: 3 });
  // 日志：12:30:05 加载完成 {"count":3}
  console.warn("接口较慢");
  // 日志：12:30:05 [warn] 接口较慢
  console.error("请求失败", 500);
  // 日志：12:30:05 [error] 请求失败 500
  ```

## `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`

- **介绍**：定时器。与浏览器的区别：回调不接收额外参数（`setTimeout(fn, ms, a, b)` 里的 `a`、`b` 不会传给 `fn`）。扩展停用或重新加载时，它的定时器全部自动取消。
- **入参**：`setTimeout(fn, ms)`、`setInterval(fn, ms)`、`clearTimeout(id)`、`clearInterval(id)`
  其中，`fn` 是回调函数，`ms` 是毫秒数，`id` 是前两者的返回值。
- **出参**：`setTimeout` / `setInterval` 返回定时器 id（数字）；另外两个无返回值。
- **调用示例**
  ```javascript
  const id = setInterval(() => console.log("位置", sim.player.position()), 1000);
  // 3
  setTimeout(() => clearInterval(id), 5000);
  // 4
  // 日志每秒多一条“位置 …”，5 秒后停止
  ```

## `File`

- **介绍**：文件对象，用来把文件内容交给主程序（作为 `getMusicInfo` 的资源字段、`sim.fs.writeFile` 的数据），或读取主程序交来的文件（如 `sim.player.cover()`、`sim.player.playback()` 的结果）。可以用 `instanceof File` 判断。有三种来源：
  - `sim.fs.file(path)`：引用磁盘上的文件，不把内容读进内存，适合音频等大文件；
  - `sim.media.coverFile(path)`：引用某个音频文件的封面；
  - `new File(parts, name, options)`：在内存中组装，最多 128 MiB。
- **入参**：`new File(parts, name, options)`
  其中，`parts` 是内容片段的数组，每个片段可以是字符串、`ArrayBuffer`、TypedArray 或另一个 `File`；`name` 是文件名；`options` 可选，`{ type }` 为 MIME 类型。
- **出参**：`File` 对象，成员如下：

  | 成员 | 说明 |
  | --- | --- |
  | `name` | 文件名 |
  | `size` | 字节数 |
  | `type` | MIME 类型（`new File` 与 `sim.player.cover()` 的结果有） |
  | `path`、`lastModified` | 磁盘文件的绝对路径、修改时间的毫秒时间戳（`sim.fs.file` / `sim.media.coverFile` 与 `sim.player.playback()` 的结果有） |
  | `await file.text()` | 把内容读为文本 |
  | `await file.arrayBuffer()` | 把内容读为 `ArrayBuffer` |

- **调用示例**
  ```javascript
  const lrc = new File(["[00:00.00]示例歌词\n", "[00:05.00]第二句"], "lyrics.lrc", { type: "text/plain" });
  lrc.size;
  // 42
  await lrc.text();
  // "[00:00.00]示例歌词\n[00:05.00]第二句"

  const audio = sim.fs.file("D:\\Music\\a.flac");
  audio instanceof File;
  // true
  (await audio.arrayBuffer()).byteLength;
  // 31457280
  ```

---

# 基础信息接口

`sim.plugin`、`sim.platform`、`sim.log` 提供扩展自身的信息与日志。

## `sim.plugin`

- **介绍**：本扩展的信息，只读对象。
- **入参**：无（属性）。
- **出参**：`{ id, name, version, dataDir, dir }`
  其中，`dataDir` 是扩展的数据目录；`dir` 是扩展的代码目录（随应用内嵌的扩展为空串）。
- **调用示例**
  ```javascript
  sim.plugin;
  // { id: "exampleMusic", name: "示例音乐", version: "1.0.0",
  //   dataDir: "D:\\SimMusicNext\\data\\plugin-data\\exampleMusic",
  //   dir: "D:\\SimMusicNext\\data\\plugins\\exampleMusic" }
  ```

## `sim.platform`

- **介绍**：当前操作系统。
- **入参**：无（属性）。
- **出参**：字符串，`"windows"` 或 `"linux"`。
- **调用示例**
  ```javascript
  const helper = sim.path.join(sim.plugin.dir, sim.platform === "windows" ? "helper.exe" : "helper");
  // "D:\\SimMusicNext\\data\\plugins\\exampleMusic\\helper.exe"
  ```

## `sim.log`

- **介绍**：写入扩展日志，等同于 `console.log`。
- **入参**：`sim.log(...args)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.log("正在播放", "示例歌曲");
  // 日志：12:30:05 正在播放 示例歌曲
  ```

---

# `sim.permissions` 接口

`sim.permissions` 用于查询本扩展当前的授权状态，以便在权限被用户撤销时优雅降级，而不是等接口抛出异常。

## `sim.permissions.has`

- **介绍**：某项权限当前是否可用（已在清单声明且用户已授权）。同步。
- **入参**：`sim.permissions.has(name)`
  其中，`name` 是权限名，如 `"network"`。
- **出参**：布尔值。
- **调用示例**
  ```javascript
  sim.permissions.has("clipboard.write");
  // true
  sim.permissions.has("shell");
  // false（清单里没有声明，或用户已撤销）
  ```

## `sim.permissions.menuAllowed`

- **介绍**：某个歌曲菜单项当前是否可用：`trackMenu` 权限、该项及其各级父项的逐项开关、该项声明的依赖权限全部满足。同步。
- **入参**：`sim.permissions.menuAllowed(key)`
  其中，`key` 是完整的菜单 key：`scheme:<协议名>/<菜单路径>`。动态子项应查询它声明的父项；下载菜单项是 `scheme:<协议名>/download`。
- **出参**：布尔值。
- **调用示例**
  ```javascript
  sim.permissions.menuAllowed("scheme:example/copyId");
  // true
  sim.permissions.menuAllowed("scheme:example/download");
  // false（用户关闭了“下载曲目”）
  ```

---

# `sim.fetch` 接口

`sim.fetch` 为扩展提供 HTTP(S) 请求。需要 `network` 权限，目标域名受清单 `hosts` 约束。

## `sim.fetch`

- **介绍**：发起一次请求，异步。它**不是**浏览器的 Fetch API：响应正文在 Promise 完成时已经全部读完，读取正文的方法都是同步的；没有流式响应、`AbortSignal`、`FormData` 和自动的 Cookie 管理。单次请求超时 60 秒，正文最多读取 64 MiB。HTTP 4xx / 5xx 不会使 Promise 被拒绝，需要自己检查 `ok`；网络错误、域名不在 `hosts` 中才会被拒绝 / 抛出。
- **入参**：`sim.fetch(url, options)`
  其中，`url` 是 HTTP(S) 地址；`options` 可选：`method`（默认 `"GET"`）、`headers`（对象，值为字符串）、`body`（字符串）。默认的 `User-Agent` 是 `SimMusicNext/0.1`，可在 `headers` 里覆盖。
- **出参**：Promise，完成值为响应对象：

  | 成员 | 说明 |
  | --- | --- |
  | `ok` | 状态码是否在 200–299 |
  | `status` | 状态码 |
  | `statusText` | 完整状态行文字，如 `"200 OK"` |
  | `url` | 跟随重定向之后的最终地址 |
  | `headers` | 普通对象，键全部小写 |
  | `text()` | 正文字符串（同步） |
  | `json()` | 正文解析为 JSON（同步），无效时抛出异常 |
  | `base64()` | 正文的 Base64（同步） |
  | `arrayBuffer()` | 正文的 `ArrayBuffer`（同步） |

  响应对象不能作为导出函数的返回值交给主程序，先取出需要的数据。
- **调用示例**
  - GET：
    ```javascript
    const response = await sim.fetch("https://api.example.com/song?id=123", { headers: { Accept: "application/json" } });
    response.ok;
    // true
    response.status;
    // 200
    response.statusText;
    // "200 OK"
    response.headers["content-type"];
    // "application/json; charset=utf-8"
    response.json();
    // { id: 123, title: "示例歌曲" }
    ```
  - POST JSON：
    ```javascript
    const response = await sim.fetch("https://api.example.com/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "sid=abc" },
        body: JSON.stringify({ user: "demo" })
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    response.text();
    // "{\"token\":\"xyz\"}"
    ```
  - 下载二进制并保存：
    ```javascript
    const response = await sim.fetch("https://cdn.example.com/pack.simex");
    const target = sim.path.join(sim.plugin.dataDir, "pack.simex");
    sim.fs.writeFile(target, response.arrayBuffer());
    // 数据目录下出现 pack.simex
    ```

---

# `sim.fs` 接口

`sim.fs` 为扩展提供文件与目录操作。扩展自己的数据目录（`sim.plugin.dataDir`）内读写不需要权限；其他位置读取需要 `fs.read`，写入、创建、删除需要 `fs.write`。路径一律使用绝对路径。除 `walk`、`dirSize` 外都是同步接口，失败时抛出异常。

## `sim.fs.file`

- **介绍**：取得磁盘文件的 [`File`](#file) 引用，同步。不读取内容，适合把音频文件作为 `playback` 交给主程序。文件不存在时抛出异常。
- **入参**：`sim.fs.file(path)`
  其中，`path` 是文件路径。
- **出参**：`File`，带有 `path`、`name`、`size`、`lastModified`。
- **调用示例**
  ```javascript
  const file = sim.fs.file("D:\\Music\\a.flac");
  // File { path: "D:\\Music\\a.flac", name: "a.flac", size: 31457280, lastModified: 1760000000000 }
  ```

## `sim.fs.readText`

- **介绍**：按 UTF-8 读取整个文件为字符串，同步。
- **入参**：`sim.fs.readText(path)`
- **出参**：字符串。
- **调用示例**
  ```javascript
  const text = sim.fs.readText(sim.path.join(sim.plugin.dataDir, "lists.json"));
  // "[{\"id\":\"fav\",\"name\":\"我的收藏\"}]"
  ```

## `sim.fs.readBase64`

- **介绍**：读取整个文件并编码为 Base64，同步。用于把图片等二进制内容经消息交给页面。
- **入参**：`sim.fs.readBase64(path)`
- **出参**：Base64 字符串。
- **调用示例**
  ```javascript
  const data = sim.fs.readBase64("D:\\Music\\cover.jpg");
  // "/9j/4AAQSkZJRgABAQ..."
  ```

## `sim.fs.writeText`

- **介绍**：把字符串按 UTF-8 写入文件，同步。文件已存在则覆盖，父目录不存在则自动创建。
- **入参**：`sim.fs.writeText(path, content)`
  其中，`path` 是文件路径，`content` 是文本。
- **出参**：无。
- **调用示例**
  ```javascript
  sim.fs.writeText(sim.path.join(sim.plugin.dataDir, "cache", "lists.json"), JSON.stringify([{ id: "fav" }]));
  // 数据目录下出现 cache\lists.json，内容为 [{"id":"fav"}]
  ```

## `sim.fs.writeFile`

- **介绍**：把二进制数据写入文件，同步。文件已存在则覆盖，父目录不存在则自动创建。
- **入参**：`sim.fs.writeFile(path, data)`
  其中，`data` 可以是 `File`、`ArrayBuffer`、TypedArray，或字符串（按 UTF-8 写入）。
- **出参**：无。
- **调用示例**
  ```javascript
  const cover = await sim.player.cover();
  if (cover) sim.fs.writeFile(sim.path.join(sim.plugin.dataDir, cover.name), cover);
  // 数据目录下出现 cover.jpg，内容是当前歌曲的封面

  sim.fs.writeFile(sim.path.join(sim.plugin.dataDir, "bytes.bin"), new Uint8Array([1, 2, 3]));
  // 数据目录下出现 3 字节的 bytes.bin
  ```

## `sim.fs.exists`

- **介绍**：路径（文件或目录）是否存在，同步。
- **入参**：`sim.fs.exists(path)`
- **出参**：布尔值。
- **调用示例**
  ```javascript
  sim.fs.exists("D:\\Music\\a.lrc");
  // false
  ```

## `sim.fs.stat`

- **介绍**：查询文件或目录的基本信息，同步。
- **入参**：`sim.fs.stat(path)`
- **出参**：`{ size, isDir, mtime }`，`size` 为字节数，`mtime` 为修改时间的 Unix 秒；路径不存在时为 `null`。
- **调用示例**
  ```javascript
  sim.fs.stat("D:\\Music\\a.flac");
  // { size: 31457280, isDir: false, mtime: 1760000000 }
  sim.fs.stat("D:\\不存在");
  // null
  ```

## `sim.fs.readDir`

- **介绍**：列出目录的直接子项，不递归，同步。
- **入参**：`sim.fs.readDir(path)`
- **出参**：`[{ name, path, isDir, size, mtime }]`，`path` 是子项的完整路径。
- **调用示例**
  ```javascript
  sim.fs.readDir("D:\\Music");
  // [{ name: "a.flac", path: "D:\\Music\\a.flac", isDir: false, size: 31457280, mtime: 1760000000 },
  //  { name: "专辑", path: "D:\\Music\\专辑", isDir: true, size: 0, mtime: 1759000000 }]
  ```

## `sim.fs.mkdir`

- **介绍**：创建目录，同步。缺少的各级父目录一并创建；目录已存在时不报错。
- **入参**：`sim.fs.mkdir(path)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.fs.mkdir(sim.path.join(sim.plugin.dataDir, "cache", "covers"));
  // 数据目录下出现 cache\covers
  ```

## `sim.fs.remove`

- **介绍**：删除文件，或**递归删除**整个目录，同步。路径不存在时不报错。不经过回收站，调用前确认路径范围。
- **入参**：`sim.fs.remove(path)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.fs.remove(sim.path.join(sim.plugin.dataDir, "cache"));
  // 数据目录下的 cache 目录及其全部内容被删除
  ```

## `sim.fs.walk`

- **介绍**：递归查找目录下的文件，异步。读不了的子目录被跳过。
- **入参**：`sim.fs.walk(dir, exts)`
  其中，`dir` 是起始目录；`exts` 是扩展名数组，写 `"mp3"` 或 `".mp3"` 均可，不区分大小写，空数组表示所有文件。
- **出参**：Promise，完成值为按路径排序的文件路径数组。
- **调用示例**
  ```javascript
  const files = await sim.fs.walk("D:\\Music", ["mp3", "flac"]);
  // ["D:\\Music\\a.flac", "D:\\Music\\专辑\\01.mp3", "D:\\Music\\专辑\\02.mp3"]
  ```

## `sim.fs.dirSize`

- **介绍**：递归统计目录下全部文件的总大小，异步。
- **入参**：`sim.fs.dirSize(path)`
- **出参**：Promise，完成值为字节数。
- **调用示例**
  ```javascript
  const bytes = await sim.fs.dirSize(sim.path.join(sim.plugin.dataDir, "cache"));
  // 5242880
  ```

---

# `sim.path` 接口

`sim.path` 提供按当前系统规则处理路径字符串的工具，全部同步、不访问磁盘、不需要权限。

## `sim.path.join`

- **介绍**：拼接路径片段并规整（去掉多余的分隔符、处理 `.` 与 `..`）。
- **入参**：`sim.path.join(...parts)`
- **出参**：字符串。
- **调用示例**
  ```javascript
  sim.path.join(sim.plugin.dataDir, "cache", "lists.json");
  // "D:\\SimMusicNext\\data\\plugin-data\\exampleMusic\\cache\\lists.json"
  sim.path.join("D:\\Music", "..", "Video");
  // "D:\\Video"
  ```

## `sim.path.basename`

- **介绍**：路径的最后一段。
- **入参**：`sim.path.basename(path)`
- **出参**：字符串。
- **调用示例**
  ```javascript
  sim.path.basename("D:\\Music\\a.flac");
  // "a.flac"
  ```

## `sim.path.dirname`

- **介绍**：去掉最后一段后的路径。
- **入参**：`sim.path.dirname(path)`
- **出参**：字符串。
- **调用示例**
  ```javascript
  sim.path.dirname("D:\\Music\\a.flac");
  // "D:\\Music"
  ```

## `sim.path.extname`

- **介绍**：扩展名，含点，保留原大小写；没有扩展名时为空串。
- **入参**：`sim.path.extname(path)`
- **出参**：字符串。
- **调用示例**
  ```javascript
  sim.path.extname("D:\\Music\\a.FLAC");
  // ".FLAC"
  sim.path.extname("D:\\Music\\README");
  // ""
  ```

## `sim.path.sep`

- **介绍**：当前系统的路径分隔符。
- **入参**：无（属性）。
- **出参**：字符串，Windows 上为 `"\\"`，Linux 上为 `"/"`。
- **调用示例**
  ```javascript
  "D:\\Music\\专辑\\01.mp3".split(sim.path.sep);
  // ["D:", "Music", "专辑", "01.mp3"]
  ```

---

# `sim.settings` 接口

`sim.settings` 是扩展自己的键值存储，自动持久化，不需要权限。它既保存 [`getSettings`](#getsettings) 声明的设置项的值，也可以保存扩展自己的任意数据（账号、导入的列表等）。全部同步。

## `sim.settings.get`

- **介绍**：读取一个值。
- **入参**：`sim.settings.get(key, fallback)`
  其中，`key` 是键名；`fallback` 是该键没有值时返回的默认值。
- **出参**：保存的值；没有时为 `fallback`。
- **调用示例**
  ```javascript
  sim.settings.get("quality", "standard");
  // "lossless"
  sim.settings.get("没存过的键", []);
  // []
  ```

## `sim.settings.set`

- **介绍**：保存一个值。值必须能表示为 JSON。不会触发 `onSettingChange`；如果改的是界面上的设置项并且需要让数据失效，自己调用 `sim.index.clear` 等。
- **入参**：`sim.settings.set(key, value)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.settings.set("lists", [{ id: "fav", name: "我的收藏", tracks: ["123"] }]);
  // 重启应用后 sim.settings.get("lists", []) 仍得到这个数组
  ```

## `sim.settings.all`

- **介绍**：读取全部键值。
- **入参**：`sim.settings.all()`
- **出参**：普通对象。
- **调用示例**
  ```javascript
  sim.settings.all();
  // { quality: "lossless", translation: true, lists: [{ id: "fav", name: "我的收藏", tracks: ["123"] }] }
  ```

---

# `sim.media` 接口

`sim.media` 用于读取和改写本地音频文件的标签、歌词与封面。读取数据目录以外的文件需要 `fs.read`；`writeTags` 需要 `fs.write`。

## `sim.media.readMetadata`

- **介绍**：批量读取音频文件的基本信息，异步，多个文件并行读取。单个文件读取失败不会使整体失败，而是在该项里给出 `error`。
- **入参**：`sim.media.readMetadata(paths, options)`
  其中，`paths` 是文件路径数组；`options` 可选，`{ duration: false }` 表示只读标签、不计算时长（快得多，适合搜索）。
- **出参**：Promise，完成值为与 `paths` 顺序一致的数组，每项为 `{ path, title, artist, album, duration, hasCover, size, mtime }`，失败时另有 `error`。`title` 在文件没有标题标签时取不含扩展名的文件名；`duration` 为秒；`hasCover` 指文件内嵌有封面；`mtime` 为 Unix 秒。
- **调用示例**
  ```javascript
  const metas = await sim.media.readMetadata(["D:\\Music\\a.flac", "D:\\Music\\坏文件.mp3"]);
  // [{ path: "D:\\Music\\a.flac", title: "示例歌曲", artist: "示例歌手", album: "示例专辑",
  //    duration: 215.4, hasCover: true, size: 31457280, mtime: 1760000000 },
  //  { path: "D:\\Music\\坏文件.mp3", title: "坏文件", artist: "", album: "", duration: 0,
  //    hasCover: false, size: 1024, mtime: 1760000000, error: "..." }]

  const tagsOnly = await sim.media.readMetadata(["D:\\Music\\a.flac"], { duration: false });
  // [{ path: "D:\\Music\\a.flac", title: "示例歌曲", artist: "示例歌手", album: "示例专辑",
  //    duration: 0, hasCover: true, size: 31457280, mtime: 1760000000 }]
  ```

## `sim.media.readLyrics`

- **介绍**：读取音频文件内嵌的歌词，同步。不会查找同目录的 `.lrc` 文件，需要时用 `sim.fs.exists` / `sim.fs.readText` 自己读取。
- **入参**：`sim.media.readLyrics(path)`
- **出参**：歌词文本；没有内嵌歌词时为空串。
- **调用示例**
  ```javascript
  sim.media.readLyrics("D:\\Music\\a.flac");
  // "[00:01.00]第一句\n[00:05.20]第二句"
  ```

## `sim.media.coverFile`

- **介绍**：取得音频文件封面的 [`File`](#file) 引用，同步，用作 `getMusicInfo` 的 `cover`。读取时优先取内嵌封面，没有时使用同目录下的 `cover` / `folder` 等图片。音频文件不存在时抛出异常。
- **入参**：`sim.media.coverFile(path)`
  其中，`path` 是**音频文件**的路径。
- **出参**：`File`。
- **调用示例**
  ```javascript
  const cover = sim.media.coverFile("D:\\Music\\a.flac");
  // File { path: "D:\\Music\\a.flac", name: "a.flac", size: 31457280, lastModified: 1760000000000 }
  // 作为 getMusicInfo 的 cover 返回后，列表中这首歌显示其内嵌封面
  ```

## `sim.media.readTags`

- **介绍**：读取一个音频文件全部可编辑的标签，异步。
- **入参**：`sim.media.readTags(path, options)`
  其中，`options` 可选，`{ cover: true }` 表示同时取出封面图片的数据。
- **出参**：Promise，完成值为 `{ path, format, writable, title, artist, album, albumArtist, composer, lyricist, genre, year, track, disc, comment, lyrics, cover }`。文本字段缺失时为空串；`track`、`disc` 保持文件里的写法（如 `"3/12"`）；`writable` 表示能否用 `writeTags` 写入（目前是 MP3 与 FLAC）；`cover` 为 `null` 或 `{ mime, type, width, height, size }`，传了 `{ cover: true }` 时另有 `base64`。
- **调用示例**
  ```javascript
  const tags = await sim.media.readTags("D:\\Music\\a.flac", { cover: true });
  // { path: "D:\\Music\\a.flac", format: "flac", writable: true,
  //   title: "示例歌曲", artist: "示例歌手", album: "示例专辑", albumArtist: "", composer: "", lyricist: "",
  //   genre: "Pop", year: "2024", track: "3/12", disc: "1", comment: "", lyrics: "[00:01.00]第一句",
  //   cover: { mime: "image/jpeg", type: "Front Cover", width: 1000, height: 1000, size: 182044, base64: "/9j/4AAQ..." } }
  ```

## `sim.media.writeTags`

- **介绍**：改写一个音频文件的标签，异步。只改动 `tags` 里出现的字段，音频数据不变。文件正在播放时，播放会在写入期间短暂中断并从原位置恢复。写入后调用 `sim.index.remove([id])` 让主程序重新读取这首歌的信息。
- **入参**：`sim.media.writeTags(path, tags)`
  其中，`tags` 是要改动的字段：文本字段（同 `readTags` 的字段名）给字符串即写入，给空串即删除该字段；`cover: null` 移除内嵌封面，`cover: { path }` 用图片文件替换，`cover: { base64 }` 用 Base64（可以是 data URL）替换。
- **出参**：Promise，无完成值。格式不支持写入等情况下被拒绝。
- **调用示例**
  ```javascript
  const path = "D:\\Music\\a.flac";
  await sim.media.writeTags(path, { title: "新标题", genre: "", cover: { path: "D:\\Music\\new.jpg" } });
  sim.index.remove([path]);
  // undefined
  // 文件的标题变为“新标题”、流派被删除、封面换成 new.jpg；列表中这首歌的标题和封面随即更新
  ```

---

# `sim.dialog` 接口

`sim.dialog` 在主窗口上弹出对话框并等待用户操作，全部异步，不需要权限。选择文件 / 目录的对话框本身不授予读取权限，读取所选路径仍需要 `fs.read`。

只应在允许长时间等待的导出函数里等待对话框：`onSidebarAdd`、`onSidebarOpen`、`onSidebarMenu`（10 分钟）以及 `onAction`、`onTrackAction`（1 分钟）。

## `sim.dialog.prompt`

多字段输入可使用 `sim.dialog.form({ title, subtitle?, submit?, items })`，返回 `Promise<object | null>`，取消时为 `null`。`items` 为 `{ name, type, placeholder?, value?, allowEmpty?, options? }` 数组；`type` 支持 `input`、`textarea`、`select`，选项为 `{ value: label }`，字段值与返回值均为字符串。最多 20 个字段，不接受 HTML。和 `sim.dialog.prompt` 一样，这些表单由宿主在原生对话框窗口中显示；扩展 webview 应通过自己的 message 通道请求入口脚本调用此方法。

- **介绍**：弹出一个单行输入框。
- **入参**：`sim.dialog.prompt(title, placeholder, value)`
  其中，`title` 是标题，`placeholder` 是输入框的占位提示，`value` 是初始内容。
- **出参**：Promise，完成值为用户输入的字符串；取消或未输入时为空串。
- **调用示例**
  ```javascript
  const input = await sim.dialog.prompt("导入歌单", "歌单 ID 或分享链接", "");
  // "123456"
  // 弹出标题为“导入歌单”的输入框，用户输入后点击确定
  ```

## `sim.dialog.confirm`

- **介绍**：弹出一个确认框。
- **入参**：`sim.dialog.confirm(text)`
  其中，`text` 是提示文字。
- **出参**：Promise，完成值为布尔值：确定为 `true`，取消为 `false`。
- **调用示例**
  ```javascript
  const ok = await sim.dialog.confirm("确定移除这个列表？");
  // true
  // 弹出确认框，用户点击了确定
  ```

## `sim.dialog.pickFolder`

- **介绍**：弹出系统的选择文件夹对话框。
- **入参**：`sim.dialog.pickFolder(title)`
  其中，`title` 是对话框标题。
- **出参**：Promise，完成值为所选目录的路径；取消时为 `null`。
- **调用示例**
  ```javascript
  const dir = await sim.dialog.pickFolder("选择音乐目录");
  // "D:\\Music"
  // 弹出系统的选择文件夹对话框
  ```

## `sim.dialog.pickFiles`

- **介绍**：弹出系统的选择文件对话框，可多选。
- **入参**：`sim.dialog.pickFiles(title, exts)`
  其中，`title` 是对话框标题；`exts` 是允许选择的扩展名数组，如 `[".mp3", ".flac"]`。
- **出参**：Promise，完成值为所选文件的路径数组；用户取消时没有任何路径，应按“值为空或长度为 0”判断。
- **调用示例**
  ```javascript
  const paths = await sim.dialog.pickFiles("选择音频", [".mp3", ".flac"]);
  if (!paths || !paths.length) return;
  // ["D:\\Music\\a.flac", "D:\\Music\\b.mp3"]
  // 弹出系统的选择文件对话框，只列出 mp3 与 flac
  ```

---

# `sim.ui` 接口

`sim.ui` 用于向用户显示提示，以及通知主界面刷新。

## `sim.ui.toast`

- **介绍**：在界面上显示一条很快消失的短提示，同步，不需要权限。只用于**不超过 10 个字的固定短语**；超过 10 个字时主程序改用弹窗显示。歌曲名、错误详情等长度不定的内容用 `sim.ui.alert`。
- **入参**：`sim.ui.toast(text)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.ui.toast("已复制");
  // 界面上浮现“已复制”，片刻后消失
  ```

## `sim.ui.alert`

- **介绍**：弹出一个需要用户关闭的提示框，同步返回（不等待用户关闭），不需要权限。长度不定的部分建议单独放一行。
- **入参**：`sim.ui.alert(text)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.ui.alert("已导入歌单：\n" + listName);
  // 弹出提示框，两行文字：“已导入歌单：” / “通勤路上”
  ```

## `sim.ui.invalidateMusic`

- **介绍**：使本扩展相关协议的全部歌曲的**资源**（封面、播放、下载地址等）失效，主程序之后会重新索取各场景；标题、歌手、歌词文本等普通数据保留。同步，不需要权限。用于账号、接口地址这类影响所有资源的变化；只影响个别字段时用更精确的 [`sim.index.clear`](#simindexclear)。
- **入参**：`sim.ui.invalidateMusic()`
- **出参**：无。
- **调用示例**
  ```javascript
  exports.onSettingChange = key => { if (key === "apiEndpoint") sim.ui.invalidateMusic(); };
  // 正在显示的本扩展歌曲列表重新加载封面；之后播放的歌曲重新索取播放地址
  ```

## `sim.ui.refresh`

- **介绍**：等同于 [`sim.sidebar.refresh`](#simsidebarrefresh)。需要 `sidebar` 权限。
- **入参**：`sim.ui.refresh()`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.ui.refresh();
  // 侧栏按 getSidebar 的最新结果重新显示
  ```

---

# `sim.sidebar` 接口

`sim.sidebar` 让扩展主动更新自己的侧栏内容。需要 `sidebar` 权限。侧栏的内容本身由导出函数 [`getSidebar`](#getsidebar) 等给出。

## `sim.sidebar.refresh`

- **介绍**：请主程序重新调用 `getSidebar` 并更新侧栏。同步返回，刷新在稍后完成。`onSidebarAdd`、`onSidebarMenu` 结束后主程序会自动刷新一次，不必再调用。当前显示的条目在刷新后不存在时，主界面回到首页。它只刷新侧栏本身，不会重建正在显示的歌曲列表（那需要 `sim.sidebar.open`）。
- **入参**：`sim.sidebar.refresh()`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.settings.set("lists", [...sim.settings.get("lists", []), { id: "new", name: "新列表", tracks: [] }]);
  sim.sidebar.refresh();
  // 侧栏分区里多出“新列表”
  ```

## `sim.sidebar.open`

- **介绍**：让主界面显示本扩展的某个侧栏条目，效果与用户点击它相同（先刷新侧栏，再触发 `onSidebarOpen(id)`）。条目已经在显示时即为刷新其内容。同步返回，切换在稍后完成。
- **入参**：`sim.sidebar.open(id)`
  其中，`id` 是 `getSidebar` 给出的条目 id。
- **出参**：无。
- **调用示例**
  ```javascript
  sim.sidebar.open("fav");
  // 主界面切换到“我的收藏”；已在显示时，列表按 onSidebarOpen("fav") 的最新结果重新加载
  ```

---

# `sim.index` 接口

主程序会记住 `getMusicInfo` 返回过的信息，不重复索取。当扩展知道某些信息已经过时（设置改了音质、文件被改写），用 `sim.index` 让它们失效。只作用于本扩展注册或追加的协议下的歌曲。不需要权限，全部同步。

## `sim.index.clear`

- **介绍**：丢弃指定歌曲的指定字段，之后需要时重新索取。
- **入参**：`sim.index.clear(fields, ids)`
  其中，`fields` 是字段名数组；`ids` 是歌曲 id 数组，**省略表示全部歌曲**，传 `[]` 表示一首也不选。
  字段与重新索取的场景：`playback`、`lyrics`、`format`、`largeCover` → `play`；`download`、`ext` → `download`（`lyrics` 同时影响 `download`）；其他字段（`title`、`cover` 等）→ 各场景。
- **出参**：无。
- **调用示例**
  ```javascript
  sim.index.clear(["playback"]);
  // 本扩展全部歌曲的播放地址失效；之后播放任何一首都会重新调用 getMusicInfo(ids, "play")。正在播放的音频不受影响

  sim.index.clear(["download", "ext"]);
  // 下载音质改变后：之后的下载重新索取 download 场景

  sim.index.clear(["lyrics"], ["123", "456"]);
  // 只有这两首歌的歌词失效
  ```

## `sim.index.remove`

- **介绍**：丢弃指定歌曲的**全部**已知信息并立即重新读取，效果等同于用户对这些歌曲执行“刷新索引缓存”。用于歌曲本身发生了变化的情况（例如文件标签被改写）。
- **入参**：`sim.index.remove(ids)`
  其中，`ids` 是歌曲 id 数组。
- **出参**：无。
- **调用示例**
  ```javascript
  await sim.media.writeTags(path, { title: "新标题" });
  sim.index.remove([path]);
  // 列表、播放队列和底栏里这首歌的标题变为“新标题”；它正在播放时歌词也重新加载
  ```

---

# `sim.shell` 接口

`sim.shell` 提供与操作系统的集成：打开文件与网址、文件右键菜单、运行本机程序。需要 `shell` 权限。

## `sim.shell.openPath`

- **介绍**：用系统默认程序打开一个文件、目录或网址，同步返回。
- **入参**：`sim.shell.openPath(pathOrUrl)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.shell.openPath("https://example.com/help");
  // 系统默认浏览器打开该网页
  sim.shell.openPath(sim.plugin.dataDir);
  // 文件资源管理器打开扩展的数据目录
  ```

## `sim.shell.showItemInFolder`

- **介绍**：在文件资源管理器中打开文件所在的目录并选中该文件，同步返回。
- **入参**：`sim.shell.showItemInFolder(path)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.shell.showItemInFolder("D:\\Music\\a.flac");
  // 文件资源管理器打开 D:\Music，并选中 a.flac
  ```

## `sim.shell.registerFileMenu`

- **介绍**：为指定扩展名的文件注册或移除“用 SimMusic 打开”的系统关联（右键菜单与“打开方式”），同步。用户通过它打开的文件会交给导出函数 [`openFiles`](#openfiles)。
- **入参**：`sim.shell.registerFileMenu(exts, enable, label)`
  其中，`exts` 是扩展名数组；`enable` 为 `true` 注册、`false` 移除；`label` 是菜单文字，空串时为“使用 SimMusic 播放”。
- **出参**：布尔值，是否成功（失败原因写入扩展日志）。
- **调用示例**
  ```javascript
  sim.shell.registerFileMenu([".mp3", ".flac"], true, "");
  // true
  // 在资源管理器中右键 .mp3 / .flac 文件，菜单里出现“使用 SimMusic 播放”
  sim.shell.registerFileMenu([".mp3", ".flac"], false, "");
  // true
  // 该菜单项消失
  ```

## `sim.shell.exec`

- **介绍**：运行一个本机程序直到它结束，异步，取回它的全部输出。控制台程序不会弹出控制台窗口。一个扩展同时最多运行 16 个程序；扩展停用、重新加载、被移除或应用退出时，它启动的程序全部被结束。
- **入参**：`sim.shell.exec(path, args, options)`
  其中，`path` 是程序的**绝对路径**（扩展自带的程序用 `sim.path.join(sim.plugin.dir, ...)` 构造）；`args` 是参数数组，可省略；`options` 可省略：

  | 选项 | 含义 |
  | --- | --- |
  | `cwd` | 工作目录，默认是程序所在目录 |
  | `env` | 追加或覆盖的环境变量对象 |
  | `hide` | 为 `true` 时程序的第一个窗口隐藏着启动 |
  | `input` | 作为标准输入交给程序的文本 |
  | `timeout` | 毫秒，默认 60000；超时的程序被结束，Promise 被拒绝 |

- **出参**：Promise，完成值为 `{ code, stdout, stderr }`：退出码与两路输出的文本（各保留前 16 MiB）。程序以非零退出码结束**不算**失败；启动不了时抛出异常。
- **调用示例**
  ```javascript
  const result = await sim.shell.exec("C:\\Windows\\System32\\where.exe", ["ffmpeg"]);
  // { code: 0, stdout: "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe\r\n", stderr: "" }

  const converted = await sim.shell.exec(sim.path.join(sim.plugin.dir, "convert.exe"), ["--to", "lrc"], { input: rawLyrics, timeout: 10000 });
  // { code: 0, stdout: "[00:01.00]第一句\n", stderr: "" }
  ```

## `sim.shell.spawn`

- **介绍**：启动一个本机程序并保持连接，同步返回子进程对象：可以持续向它的标准输入写入，并按行接收它的输出。适合需要长期运行的辅助程序（原生窗口、系统 API）。数量上限与结束规则同 `exec`；需要比播放器活得更久的程序请用 `sim.shell.openPath` 启动。
- **入参**：`sim.shell.spawn(path, args, options)`
  参数同 `exec`，`options` 只支持 `cwd`、`env`、`hide`。
- **出参**：子进程对象：

  | 成员 | 说明 |
  | --- | --- |
  | `pid` | 进程号 |
  | `exited`、`exitCode` | 是否已结束；退出码，未结束时为 `null` |
  | `write(text)` | 写入标准输入，返回是否已接受；程序已结束或调用过 `end()` 后为 `false` |
  | `end()` | 关闭标准输入（多数按行读取的程序以此为退出信号） |
  | `kill()` | 立即结束程序 |
  | `on(type, handler)`、`off(type, handler)` | 添加 / 移除事件处理函数，返回子进程对象本身 |
  | `onstdout`、`onstderr`、`onexit` | 也可以直接给这三个属性赋值 |

  事件：`stdout`、`stderr` 每收到一行触发一次，事件对象为 `{ type, target, data }`，`data` 是不含换行符的一行文本（UTF-8，单行最长 8 MiB）；`exit` 在全部输出送达之后触发，事件对象为 `{ type, target, code }`。
- **调用示例**
  ```javascript
  const child = sim.shell.spawn(sim.path.join(sim.plugin.dir, "helper.exe"), ["--mode", "pipe"], { hide: true });
  child.pid;
  // 18244
  child.onstdout = event => sim.log("程序说", event.data);
  // 程序每输出一行，日志多一条“程序说 …”
  child.on("exit", event => sim.log("程序退出", event.code));
  child.write("hello\n");
  // true
  child.end();
  // 程序读到输入结束后退出，日志：程序退出 0
  child.exited;
  // true
  child.exitCode;
  // 0
  ```

---

# `sim.clipboard` 接口

`sim.clipboard` 用于写入系统剪贴板。需要 `clipboard.write` 权限。

## `sim.clipboard.writeText`

- **介绍**：把一段文字放进系统剪贴板，同步。
- **入参**：`sim.clipboard.writeText(text)`
- **出参**：无。
- **调用示例**
  ```javascript
  sim.clipboard.writeText("https://example.com/song/123");
  // 系统剪贴板的内容变为这个链接
  ```

---

# `sim.webview` 接口

`sim.webview` 让扩展显示自己的网页。需要 `webview` 权限。有三种形态：

| 构造 | 显示位置 |
| --- | --- |
| `new sim.webview.panel(options)` | 嵌在主窗口内容区：侧栏右侧、底栏上方 |
| `new sim.webview.window(options)` | 独立的系统窗口 |
| `new sim.webview.offscreen(options)` | 不显示，在后台加载页面、执行脚本 |

三者得到的对象有相同的[属性](#webview-属性)、[方法](#webviewloadurl)和[事件](#webview-事件)，独立窗口另有[窗口方法](#独立窗口的方法)。页面一侧如何与扩展通信见 [`simHost` 接口（页面内）](#simhost-接口页面内)。

通用规则：

- 页面是普通网页，里面**没有** `sim`；它通过 `simHost` 与扩展脚本互发消息。
- 页面地址写 `ext://路径` 或相对路径，表示扩展目录中的文件；写 `http(s)://` 表示远程页面，需要 `network` 权限并受 `hosts` 约束。
- 每个扩展有自己独立的浏览器存储（Cookie、缓存、登录状态），与主界面和其他扩展隔离，退出应用后保留。但 `localStorage` 等按源保存的数据**不保证**跨启动保留，需要持久保存的数据通过消息交给扩展，用 `sim.settings` 保存。
- 页面不能打开新窗口：`window.open`、`target="_blank"` 都改为在当前 webview 内跳转。页面内的请求不受跨源限制。
- 扩展停用、重新加载或被移除时，它创建的 webview 全部关闭。在 `init()` 里界面可能尚未就绪，此时创建会抛出异常。

## `new sim.webview.panel(options)`

- **介绍**：在主窗口内容区显示一个页面。同一时间只有一个面板：用户切换到其他侧栏项目、主界面切换页面、或另一个面板出现时，当前面板被关闭并触发 `close` 事件。通常在 [`onSidebarOpen`](#onsidebaropen) 里创建，并且该函数不返回值。面板的顶部覆盖了主窗口原本的拖动区，主窗口的窗口按钮叠在面板右上角；页面可以用 CSS `-webkit-app-region: drag` 标出用来拖动主窗口的区域。
- **入参**：`new sim.webview.panel(options)`
  其中，`options` 可以直接是地址字符串，或对象 `{ url, backgroundColor }`：`url` 省略时为 `about:blank`；`backgroundColor` 是页面绘制前的底色 `#rrggbb`，默认白色。
- **出参**：webview 对象，`kind` 为 `"panel"`。
- **调用示例**
  ```javascript
  let panel = null;
  exports.onSidebarOpen = id => {
      panel = new sim.webview.panel({ url: "ext://pages/home.html", backgroundColor: "#FFFFFF" });
      panel.onclose = () => { panel = null; };
  };
  // 主界面内容区显示扩展目录中的 pages/home.html；用户点击其他侧栏项目时面板关闭
  ```

## `new sim.webview.window(options)`

- **介绍**：打开一个独立窗口显示页面。在窗口里按 Esc 一定会关闭它，页面收不到这次按键。
- **入参**：`new sim.webview.window(options)`
  其中，`options` 可以直接是地址字符串，或对象：

  | 选项 | 含义 |
  | --- | --- |
  | `url`、`backgroundColor` | 同面板 |
  | `width`、`height` | 页面区域的大小，默认 800×600 |
  | `minWidth`、`minHeight`、`maxWidth`、`maxHeight` | 页面区域的尺寸限制 |
  | `x`、`y` | 窗口位置；两者都给出才生效，否则在主窗口所在屏幕居中 |
  | `title` | 窗口标题；省略时跟随页面的 `<title>` |
  | `icon` | `.ico` 或 `.png` 图标，相对扩展目录（或 `ext://`）；扩展目录以外的绝对路径需要 `fs.read`。省略时使用应用图标 |
  | `frame` | 是否显示系统标题栏，默认 `true`。为 `false` 时窗口全部是页面，页面用 CSS `-webkit-app-region: drag` 标出可拖动区域（其中的按钮用 `no-drag` 排除） |
  | `resizable`、`minimizable`、`maximizable` | 默认 `true` |
  | `top` | 置顶，默认 `false` |
  | `fullscreen` | 以全屏打开，默认 `false` |
  | `show` | 创建后立即显示，默认 `true`；为 `false` 时之后调用 `show()` |
  | `skipTaskbar` | 不在任务栏显示，默认 `false` |

- **出参**：webview 对象，`kind` 为 `"window"`。
- **调用示例**
  ```javascript
  const editor = new sim.webview.window({
      url: "ext://editor.html", title: "编辑元数据",
      width: 920, height: 700, minWidth: 920, minHeight: 700,
      frame: false, top: true
  });
  // 屏幕中央出现一个 920×700、没有系统标题栏、置顶的窗口，显示扩展目录中的 editor.html
  ```

## `new sim.webview.offscreen(options)`

- **介绍**：创建一个不显示的页面，用于在后台加载网页并用 `executeJavaScript` 取数据（例如需要浏览器环境才能完成的登录或签名）。
- **入参**：`new sim.webview.offscreen(options)`
  其中，`options` 可以直接是地址字符串，或对象 `{ url, backgroundColor, width, height }`，页面大小默认 1280×720。
- **出参**：webview 对象，`kind` 为 `"offscreen"`。
- **调用示例**
  ```javascript
  const page = new sim.webview.offscreen("https://example.com/player");
  page.onload = async () => {
      const title = await page.executeJavaScript("return document.title");
      // "示例播放器"
      page.close();
  };
  // 界面上没有任何变化
  ```

## webview 属性

- **介绍**：webview 对象上的只读属性。
- **入参**：无（属性）。
- **出参**：

  | 属性 | 说明 |
  | --- | --- |
  | `id` | 这个 webview 的标识 |
  | `kind` | `"panel"`、`"window"` 或 `"offscreen"` |
  | `url` | 当前地址；扩展自己的页面以 `ext://` 形式给出 |
  | `title` | 页面标题 |
  | `closed` | 是否已关闭 |
  | `cookies` | 即 [`sim.webview.cookies`](#simwebviewcookiesget) |

- **调用示例**
  ```javascript
  const panel = new sim.webview.panel("ext://pages/home.html");
  panel.kind;
  // "panel"
  panel.url;
  // "ext://pages/home.html"
  panel.closed;
  // false
  ```

## `webview.loadURL`

- **介绍**：让 webview 跳转到新地址，同步返回。webview 已关闭时抛出异常。
- **入参**：`webview.loadURL(url)`
  其中，`url` 的写法同创建时的 `url`。
- **出参**：无。
- **调用示例**
  ```javascript
  panel.loadURL("ext://pages/detail.html?id=123");
  // 面板改为显示 pages/detail.html；加载完成后触发 load 事件
  ```

## `webview.reload`

- **介绍**：重新加载当前页面，同步返回。
- **入参**：`webview.reload()`
- **出参**：无。
- **调用示例**
  ```javascript
  panel.reload();
  // 面板中的页面重新加载
  ```

## `webview.postMessage`

- **介绍**：向页面发送一条消息，同步返回。页面经 `simHost.onmessage` 收到。页面加载完成之前发送的消息会排队，加载完成后按顺序送达。
- **入参**：`webview.postMessage(data)`
  其中，`data` 必须能表示为 JSON（函数、循环引用不行；二进制数据用 Base64）。
- **出参**：无。
- **调用示例**
  ```javascript
  panel.postMessage({ type: "lists", lists: sim.settings.get("lists", []) });
  // 页面里 simHost.onmessage 收到 event.data 为 { type: "lists", lists: [...] }
  ```

## `webview.executeJavaScript`

- **介绍**：在页面里执行一段脚本并取回结果，异步。`code` 是一个**异步函数的函数体**：用 `return` 返回结果，可以使用 `await`。
- **入参**：`webview.executeJavaScript(code)`
  其中，`code` 是脚本文本。
- **出参**：Promise，完成值为脚本 `return` 的值（必须能表示为 JSON）。页面抛出错误、脚本无法解析、webview 已关闭、30 秒内没有结果时被拒绝。
- **调用示例**
  ```javascript
  const info = await page.executeJavaScript(`
      const response = await fetch("/api/me");
      const user = await response.json();
      return { name: user.name, links: document.querySelectorAll("a").length };
  `);
  // { name: "demo", links: 42 }
  ```

## `webview.close`

- **介绍**：关闭 webview，同步返回。已经关闭时无效果。关闭后触发 `close` 事件。
- **入参**：`webview.close()`
- **出参**：无。
- **调用示例**
  ```javascript
  editor.close();
  // 独立窗口消失；editor.closed 变为 true
  ```

## `webview.on` / `webview.off`

- **介绍**：添加 / 移除事件处理函数。也可以给 `onload`、`onnavigation`、`onerror`、`ontitle`、`onmessage`、`onclose` 属性直接赋值（每个属性只能放一个函数）。
- **入参**：`webview.on(type, handler)`、`webview.off(type, handler)`
  其中，`type` 是[事件](#webview-事件)名；`handler` 是处理函数，收到一个事件对象。
- **出参**：webview 对象本身，可以连续调用。
- **调用示例**
  ```javascript
  const onLoad = event => sim.log("加载完成", event.url, event.status);
  panel.on("load", onLoad).on("title", event => sim.log("标题", event.title));
  // 页面加载完成后，日志：加载完成 ext://pages/home.html 200
  panel.off("load", onLoad);
  ```

## webview 事件

- **介绍**：webview 对象触发的事件。事件对象都带有 `type`（事件名）和 `target`（webview 对象）。
- **入参**：处理函数收到的事件对象：

  | 事件 | 何时触发 | 事件对象的字段 |
  | --- | --- | --- |
  | `load` | 页面加载完成 | `url`、`status`（HTTP 状态码） |
  | `navigation` | 页面地址变化（含重定向、页面内 `history` 变化） | `url` |
  | `error` | 页面加载失败 | `url`、`code`、`message` |
  | `title` | 页面标题变化 | `title` |
  | `message` | 页面调用了 `simHost.postMessage` | `data`、`origin`、`url`。扩展自己的页面 `origin` 为 `"ext://"`，远程页面为 `协议://主机[:端口]` |
  | `close` | 已关闭：扩展调用了 `close()`、用户关闭了窗口、面板被切换走 | — |

  加载远程页面时，那个页面的脚本同样能调用 `simHost.postMessage`。按 `event.origin` 判断来源，不要把远程页面发来的内容当作可信指令。
- **出参**：无。
- **调用示例**
  ```javascript
  panel.onmessage = event => {
      if (event.origin !== "ext://") return;
      if (event.data.type === "ready") panel.postMessage({ type: "hello", name: sim.plugin.name });
      if (event.data.type === "play") sim.player.play();
  };
  // 页面执行 simHost.postMessage({ type: "ready" }) 时，event 为：
  // { type: "message", target: panel, data: { type: "ready" }, origin: "ext://", url: "ext://pages/home.html" }
  // 随后页面收到 { type: "hello", name: "示例音乐" }
  ```

## 独立窗口的方法

- **介绍**：只有 `sim.webview.window` 创建的对象有这些方法，全部同步返回；窗口已关闭时抛出异常。
- **入参**：

  | 方法 | 作用 |
  | --- | --- |
  | `show()`、`hide()` | 显示、隐藏窗口 |
  | `focus()` | 把窗口放到前台 |
  | `minimize()`、`maximize()`、`restore()` | 最小化、最大化、还原 |
  | `center()` | 移到屏幕中央 |
  | `setTitle(text)` | 修改窗口标题 |
  | `setTop(on)` | 置顶或取消置顶 |
  | `setFullscreen(on)` | 进入或退出全屏 |
  | `setSize(width, height)` | 修改页面区域的大小 |
  | `setPosition(x, y)` | 移动窗口 |

- **出参**：无。
- **调用示例**
  ```javascript
  const mini = new sim.webview.window({ url: "ext://mini.html", width: 320, height: 96, frame: false, show: false, skipTaskbar: true });
  mini.setPosition(40, 40);
  mini.setTop(true);
  mini.show();
  // 屏幕左上角出现一个 320×96 的置顶小窗，任务栏上没有它的按钮
  mini.setTitle("迷你播放器");
  mini.setSize(320, 160);
  // 小窗变高到 160
  ```

## `sim.webview.cookies.get`

- **介绍**：读取本扩展浏览器存储中的 Cookie，异步。所有 webview 共用同一份 Cookie。
- **入参**：`sim.webview.cookies.get(url)`
  其中，`url` 可省略：给出时返回对该地址可见的 Cookie，省略时返回全部。
- **出参**：Promise，完成值为 `[{ name, value, domain, path, secure, httpOnly, expires }]`；`expires` 是 Unix 秒，会话 Cookie 为 0。
- **调用示例**
  ```javascript
  const cookies = await sim.webview.cookies.get("https://example.com/");
  // [{ name: "sid", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: true, expires: 1790000000 }]
  const header = cookies.map(cookie => cookie.name + "=" + cookie.value).join("; ");
  // "sid=abc123"（可用作 sim.fetch 的 Cookie 请求头）
  ```

## `sim.webview.cookies.set`

- **介绍**：设置一个 Cookie，异步。
- **入参**：`sim.webview.cookies.set(cookie)`
  其中，`cookie` 为 `{ url, name, value, domain?, path?, secure?, httpOnly?, expires? }`，`url` 与 `name` 必填。
- **出参**：Promise，完成值为 `true`；设置失败时被拒绝。
- **调用示例**
  ```javascript
  await sim.webview.cookies.set({ url: "https://example.com/", name: "lang", value: "zh", expires: 1790000000 });
  // true
  // 之后任何 webview 访问 example.com 时都带上 lang=zh
  ```

## `sim.webview.cookies.remove`

- **介绍**：删除某个地址下的 Cookie，异步。
- **入参**：`sim.webview.cookies.remove(url, name)`
  其中，`url` 必填；`name` 可省略，省略时删除该地址下的全部 Cookie。
- **出参**：Promise，完成值为删除的数量。
- **调用示例**
  ```javascript
  await sim.webview.cookies.remove("https://example.com/", "sid");
  // 1
  ```

## `sim.webview.cookies.clear`

- **介绍**：清空本扩展的全部 Cookie，异步。
- **入参**：`sim.webview.cookies.clear()`
- **出参**：Promise，完成值为删除的数量。
- **调用示例**
  ```javascript
  await sim.webview.cookies.clear();
  // 7
  // 扩展的 webview 中所有网站的登录状态失效
  ```

---

# `sim.player` 接口

`sim.player` 提供播放控制：读取播放状态、播放队列、歌词与频谱，监听它们的变化，执行播放操作，编排播放队列，获取队列中歌曲的音频。需要 `player` 权限。播放页里的 [`simPlayer`](#simplayer-接口播放页内) 是同一套接口。

## `sim.player.state`

- **介绍**：实时的播放状态。始终是**同一个对象**，主程序持续更新它的字段；只读，不要自己修改。
- **入参**：无（属性）。
- **出参**：状态对象：

  | 字段 | 含义 |
  | --- | --- |
  | `current` | 当前歌曲；没有时为 `null` |
  | `index` | 当前歌曲在 `queue` 中的位置；没有时为 `-1` |
  | `queue` | 播放队列，按当前播放顺序 |
  | `lyrics` | `{ traditional, perWord }`，见下 |
  | `playing`、`loading` | 是否在播放；当前歌曲是否仍在打开 |
  | `position`、`duration` | 秒。`position` 每 250 毫秒更新一次；需要平滑的位置用 [`sim.player.position()`](#simplayerposition) |
  | `volume`、`speed` | 音量 0–1；倍速 |
  | `mode` | 播放模式：`0` 列表循环、`1` 单曲循环、`2` 随机播放 |
  | `sleep` | 睡眠定时 `{ active, until, waitTrackEnd }`，`until` 为毫秒时间戳 |
  | `settings` | 主程序设置中“播放界面”“歌词视图”的各项（键以 `play.`、`lrc.` 开头）与界面字体 `general.font`，显示歌词或播放信息的扩展可以据此保持一致 |

  **歌曲对象**（`current` 与 `queue` 的元素）：`{ source, id, title, artist, album, duration, infoRevision, infoReady }`。`infoReady` 为 `false` 表示这首歌的信息还没有读取，标题等可能不完整，可用 [`loadInfo`](#simplayerloadinfo) 请求读取；`infoRevision` 在歌曲信息更新时变化。歌曲对象里没有封面地址，封面用 [`sim.player.cover()`](#simplayercover) 读取。

  **歌词**：歌词由主程序解析好再提供，扩展拿到的不是音源返回的原文。
  - `traditional`：逐行歌词 `[{ time, text, translation }]`，`time` 为秒。
  - `perWord`：逐字歌词，没有时为 `null`：
    ```js
    [{
        start: 12.34, end: 15.8,            // 本行起止，秒
        text: "Hello world",                // 整行文本，等于各片段 text 相连
        translation: "", romanization: "",  // 翻译、音译，没有时为空串
        background: false,                  // 是否为和声 / 背景行
        voice: 0,                           // 0 主唱，1 对唱中的另一方
        words: [{ start: 12.34, end: 12.8, text: "Hello " }, { start: 12.8, end: 13.4, text: "world" }]
    }]
    ```
    一个片段可以是一个词、一个音节或一个字，空格包含在片段文本里。音源要提供逐字时间，在 LRC 里使用行内时间标签：`[00:12.00]<00:12.00>Hello <00:12.60>world<00:13.40>`（最后一个标签可选，表示末词结束）。没有逐字时间的歌曲是否也有 `perWord`，取决于用户的“设置 → 播放控制 → 逐字歌词解析”：默认只在歌词里存在逐字时间时提供；用户也可以选择让主程序把时间平均分配到每个字 / 词上。有 `perWord` 的歌曲仍同时提供 `traditional`。

- **调用示例**
  ```javascript
  const state = sim.player.state;
  state.current;
  // { source: "example", id: "123", title: "示例歌曲", artist: "示例歌手", album: "示例专辑", duration: 215.4, infoRevision: 1760000000123, infoReady: true }
  state.index;
  // 2
  state.queue.length;
  // 30
  state.playing;
  // true
  state.volume;
  // 0.8
  state.mode;
  // 0
  state.lyrics.traditional[0];
  // { time: 1, text: "第一句", translation: "" }
  state.lyrics.perWord;
  // null
  state.sleep;
  // { active: false, until: 0, waitTrackEnd: false }
  ```

## `sim.player.position`

- **介绍**：此刻的播放位置，同步。它在主程序两次报告之间按倍速连续推算，适合逐帧绘制进度或逐字歌词。
- **入参**：`sim.player.position()`
- **出参**：数字，秒。
- **调用示例**
  ```javascript
  sim.player.position();
  // 42.137
  ```

## `sim.player.on` / `sim.player.off`

- **介绍**：监听播放状态的变化。事件在扩展里依次触发，不会与其他函数同时执行。
- **入参**：`sim.player.on(type, handler)`、`sim.player.off(type, handler)`
  其中，`type` 是事件名，`handler` 是处理函数：

  | 事件 | 何时触发 | 处理函数的参数 |
  | --- | --- | --- |
  | `track` | `current`、`index` 变化 | 状态对象 |
  | `queue` | `queue` 变化（增删、排序、歌曲信息更新） | 状态对象 |
  | `lyrics` | `lyrics` 变化 | 状态对象 |
  | `status` | `playing`、`loading`、`duration`、`volume`、`speed`、`mode`、`sleep`、`settings` 变化 | 状态对象 |
  | `position` | 每次状态更新之后（播放时约每 250 毫秒一次） | 状态对象 |
  | `change` | 同 `position`，另外告知这次变了什么 | `{ state, changed }`，`changed` 是上面前四个事件名中发生了变化的那些 |

  未知的事件名会抛出异常。
- **出参**：`sim.player` 本身，可以连续调用。
- **调用示例**
  ```javascript
  sim.player
      .on("track", state => sim.log("正在播放", state.current ? state.current.title : "无"))
      .on("status", state => sim.log(state.playing ? "播放中" : "已暂停", "音量", state.volume))
      .on("change", event => sim.log("变化", event.changed));
  // 用户切到下一首时，日志：
  // 正在播放 下一首歌
  // 变化 ["track","lyrics","status"]
  ```

## `sim.player.toggle` / `play` / `pause` / `stop`

- **介绍**：播放与暂停，异步。`toggle` 在播放与暂停之间切换；`play`、`pause` 在已经处于目标状态时不做任何事；`stop` 停止播放并清除当前歌曲。
- **入参**：`sim.player.toggle()`、`sim.player.play()`、`sim.player.pause()`、`sim.player.stop()`
- **出参**：Promise，操作完成后得到 `true`。
- **调用示例**
  ```javascript
  await sim.player.pause();
  // true
  // 音乐暂停，底栏的播放按钮变为“播放”图标
  sim.player.state.playing;
  // false
  ```

## `sim.player.previous` / `next`

- **介绍**：上一首 / 下一首，异步。
- **入参**：`sim.player.previous()`、`sim.player.next()`
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  await sim.player.next();
  // true
  // 开始播放队列中的下一首，底栏的歌名与封面随之变化
  ```

## `sim.player.seek`

- **介绍**：跳转到当前歌曲的指定位置，异步。
- **入参**：`sim.player.seek(seconds)`
  其中，`seconds` 是秒数，小于 0 时按 0 处理。
- **出参**：Promise，得到 `true`；参数不是数字时被拒绝。
- **调用示例**
  ```javascript
  await sim.player.seek(60);
  // true
  // 从 1:00 处继续播放，进度条跳到对应位置
  ```

## `sim.player.setVolume` / `setSpeed`

- **介绍**：设置音量、倍速，异步。超出范围的值被限制在范围内。
- **入参**：`sim.player.setVolume(volume)`、`sim.player.setSpeed(speed)`
  其中，`volume` 为 0–1，`speed` 为 0.1–10。
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  await sim.player.setVolume(0.5);
  // true
  // 音量变为一半，底栏的音量条移到中间
  await sim.player.setSpeed(1.25);
  // true
  // 以 1.25 倍速播放
  ```

## `sim.player.cycleMode` / `setMode`

- **介绍**：切换播放模式，异步。`cycleMode` 切到下一种模式；`setMode` 直接指定。
- **入参**：`sim.player.cycleMode()`、`sim.player.setMode(mode)`
  其中，`mode` 为 `0`（列表循环）、`1`（单曲循环）、`2`（随机播放）。
- **出参**：Promise，得到切换后的模式；`mode` 不合法时被拒绝。
- **调用示例**
  ```javascript
  await sim.player.setMode(2);
  // 2
  // 底栏的模式按钮变为“随机播放”，队列顺序被打乱
  await sim.player.cycleMode();
  // 0
  ```

## `sim.player.playIndex` / `removeFromQueue` / `moveInQueue` / `clearQueue`

- **介绍**：操作播放队列，异步。位置都是 `state.queue` 的下标。
- **入参**：
  - `sim.player.playIndex(index)`：播放队列中的第 `index` 首；
  - `sim.player.removeFromQueue(index)`：从队列中移除第 `index` 首；
  - `sim.player.moveInQueue(from, to)`：把第 `from` 首移到 `to` 的位置；
  - `sim.player.clearQueue()`：清空队列。
- **出参**：Promise，得到 `true`；位置超出范围时被拒绝。
- **调用示例**
  ```javascript
  await sim.player.playIndex(5);
  // true
  // 开始播放队列中的第 6 首
  await sim.player.moveInQueue(5, 0);
  // true
  // 这首歌移到队列最前面，播放不中断
  await sim.player.removeFromQueue(1);
  // true
  // 队列中原来的第 2 首消失
  ```

## `sim.player.setQueue` / `append` / `playNext`

- **介绍**：把歌曲放进播放队列，异步，不显示提示。
  - `setQueue` 用给出的歌曲替换整个队列。要成为当前歌曲的那一首如果正是现在的当前歌曲，它照常播放，不重新打开、不中断；否则打开那一首。
  - `append` 把歌曲追加到队列末尾，已在队列中的歌曲不重复添加；队列原来为空时从第一首开始播放。
  - `playNext` 把歌曲插到当前歌曲之后，已在队列中的歌曲改为移动到那里。

  可以放进队列的歌曲有两种：本扩展注册的协议的歌曲；以及队列里已经有的歌曲（任何协议都可以，主程序沿用它已有的信息）。其他扩展的协议中、队列里没有的歌曲会被拒绝。队列中不会出现重复歌曲，重复的只保留第一次出现。新歌曲的标题等信息由主程序经 `getMusicInfo` 读取。
- **入参**：`sim.player.setQueue(tracks, options)`、`sim.player.append(tracks)`、`sim.player.playNext(tracks)`
  其中，`tracks` 是歌曲引用数组 `[{ source, id }]`，`source` 是协议名，扩展只注册了一个协议时可以省略；`options` 可省略，字段如下：

  | 字段 | 说明 |
  | --- | --- |
  | `index` | 成为当前歌曲的位置（`tracks` 的下标）。省略时：`tracks` 里有现在的当前歌曲就是它，否则是第一首 |
  | `position` | 秒。当前歌曲照常播放时跳到这个位置；打开新的当前歌曲时从这个位置开始。省略时不跳转 / 从头开始 |
  | `play` | `true` 播放、`false` 暂停。省略时照常播放的歌曲保持原状态，新打开的歌曲开始播放 |

  `index` 与 `state.queue` 的下标无关：随机播放模式下，`state.queue` 按随机顺序排列，而 `tracks` 是正常顺序。替换队列时，留在队列里的歌曲保持原来的随机先后，新歌曲随机排在其后。
- **出参**：Promise，得到 `true`；有歌曲不能放进队列，或 `index` 超出范围时被拒绝，队列不变。
- **调用示例**
  ```javascript
  // 本扩展注册了 "musicSync" 协议；队列里已有 local 协议的 D:\Music\a.flac，且正在播放
  await sim.player.setQueue([
      { source: "musicSync", id: "peer1/42" },
      { source: "local", id: "D:\Music\a.flac" },
      { source: "musicSync", id: "peer1/43" }
  ]);
  // true
  // 队列变为这三首，a.flac 继续播放，不中断

  await sim.player.setQueue([{ id: "peer1/43" }], { position: 95.2, play: false });
  // true
  // 队列只剩这一首，它在 1:35 处打开，处于暂停状态

  await sim.player.append([{ id: "peer1/44" }]);
  // true
  // 队列末尾多出一首

  await sim.player.setQueue([{ source: "ncm", id: "12345" }]);
  // 被拒绝：这首歌既不属于本扩展的协议，也不在队列中
  ```

## `sim.player.setSleep` / `cancelSleep`

- **介绍**：设置 / 取消睡眠定时，异步。
- **入参**：`sim.player.setSleep(minutes)`、`sim.player.cancelSleep()`
  其中，`minutes` 为大于 0、不超过 1440 的分钟数。
- **出参**：Promise，得到 `true`；`minutes` 超出范围时被拒绝。
- **调用示例**
  ```javascript
  await sim.player.setSleep(30);
  // true
  sim.player.state.sleep;
  // { active: true, until: 1760001800000, waitTrackEnd: false }
  // 30 分钟后停止播放
  await sim.player.cancelSleep();
  // true
  ```

## `sim.player.showWindow`

- **介绍**：显示主窗口并放到前台（从托盘、最小化或被遮住的状态），异步。供主窗口之外的控件使用，例如任务栏或桌面上的小窗。由扩展自己启动的本机程序响应用户点击时，该程序应先调用系统的 `AllowSetForegroundWindow(ASFW_ANY)`，否则系统只会让任务栏按钮闪烁。
- **入参**：`sim.player.showWindow()`
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  await sim.player.showWindow();
  // true
  // SimMusic 主窗口出现在最前面
  ```

## `sim.player.showMenu`

- **介绍**：在鼠标指针处弹出当前歌曲的播放页菜单（添加到歌单、下载、睡眠定时、倍速、均衡器、输出设备、扩展菜单等），异步。主窗口不必显示。菜单位置固定在指针处，不接受坐标。
- **入参**：`sim.player.showMenu()`
- **出参**：Promise，得到 `true`；没有当前歌曲时得到 `false`，不弹出菜单。
- **调用示例**
  ```javascript
  await sim.player.showMenu();
  // true
  // 鼠标指针处弹出当前歌曲的菜单
  ```

## `sim.player.showTrackMenu`

- **介绍**：在鼠标指针处打开宿主原生歌曲列表右键菜单，支持播放、下一首、队列、本地歌单、下载、扩展菜单和索引刷新。需要 `player` 权限。`list` 提供完整列表上下文；单选时菜单里的“播放”使用整个列表，并从选中歌曲开始。多选时播放选中歌曲。
- **入参**：`sim.player.showTrackMenu(list, selected)`。两个参数都是歌曲引用数组 `[{ source?, id }]`，歌曲必须属于本扩展注册或获准追加的协议；`selected` 非空且必须是 `list` 的子集。列表最多 50000 首，重复引用自动去重。只使用引用，忽略传入的标题、封面等信息。
- **出参**：Promise，得到 `true` 表示菜单请求已接受；无效引用、越权协议或选择不属于列表时被拒绝。接口不改播放队列，也不等待整张列表的元数据请求。
- **调用示例**
  ```javascript
  // 自己页面的 contextmenu 消息到达扩展后：
  await sim.player.showTrackMenu(
      ["101", "102", "103"].map(id => ({ source: "example", id })),
      [{ source: "example", id: "102" }]
  );
  // 菜单“播放”从 102 开始，队列仍包含 101、102、103。
  ```

## `sim.player.loadInfo`

- **介绍**：请主程序读取队列中某些位置上尚未读取信息（`infoReady` 为 `false`）的歌曲，异步。读取在后台进行，完成后随 `queue` 事件体现在状态里。
- **入参**：`sim.player.loadInfo(indexes)`
  其中，`indexes` 是 `state.queue` 的下标数组，一次最多处理 200 首。
- **出参**：Promise，得到 `true`（表示请求已接受，不代表信息已读到）。
- **调用示例**
  ```javascript
  const missing = sim.player.state.queue.map((track, index) => track.infoReady ? -1 : index).filter(index => index >= 0);
  // [12, 13, 14]
  await sim.player.loadInfo(missing);
  // true
  // 稍后触发 queue 事件，这三首歌的 title 等字段已填好，infoReady 变为 true
  ```

## `sim.player.spectrum`

- **介绍**：读取正在听到的声音的频谱，异步，供频谱、律动之类的可视化使用。取的是均衡器之后、音量与淡入淡出之前的声音，所以不随音量变小；时间上对齐到此刻扬声器里放出的声音。暂停、没有歌曲或静音段落时各频段都是 `0`。不触发任何事件；需要动画时按自己的帧率反复读取，例如播放页在 `requestAnimationFrame` 里每帧读一次（上一次还没返回时跳过这一帧）。
- **入参**：`sim.player.spectrum(bands)`
  其中，`bands` 是频段数，1–256，省略为 `64`。频段从 40 Hz 到 16 kHz 按音高均匀划分（每个频段跨越的音程相同），低频在前。
- **出参**：Promise，完成值为长度等于 `bands` 的数字数组，每项 `0`–`1`：`0` 表示 -70 dB 或更安静，`1` 表示满幅的单音，中间按分贝线性对应。
- **调用示例**
  ```javascript
  await sim.player.spectrum(8);
  // [0.62, 0.81, 0.74, 0.58, 0.49, 0.37, 0.21, 0.04]

  // 播放页里画一圈频谱
  let waiting = false;
  const draw = async () => {
      requestAnimationFrame(draw);
      if (waiting || !simPlayer.state.visible) return;
      waiting = true;
      const levels = await simPlayer.spectrum(96);
      waiting = false;
      paintBars(levels);
  };
  requestAnimationFrame(draw);
  ```

## `sim.player.cover`

- **介绍**：读取状态里某首歌的封面图片，异步。扩展得到的是图片本身，而不是它的地址。
- **入参**：`sim.player.cover(track, options)`
  其中，`track` 是 `state.current` 或 `state.queue` 里的歌曲对象，省略（或传 `null`）表示当前歌曲；`options` 可省略，`{ large: true }` 取播放页用的大图。
- **出参**：Promise，完成值为 [`File`](#file)（有 `name`、`type`、`size`，可 `arrayBuffer()`，可交给 `sim.fs.writeFile`）；没有封面或歌曲不在状态里时为 `null`。
- **调用示例**
  ```javascript
  const cover = await sim.player.cover(null, { large: true });
  // File { name: "cover.jpg", type: "image/jpeg", size: 182044 }
  if (cover) sim.fs.writeFile(sim.path.join(sim.plugin.dataDir, cover.name), cover);
  // 数据目录下出现 cover.jpg

  await sim.player.cover(sim.player.state.queue[3]);
  // null（这首歌没有封面）
  ```

## `sim.player.playback`

- **介绍**：获取状态里某首歌的音频，也就是主程序播放它时用的资源，异步。主程序按需要向提供这首歌的扩展索取（与它将要播放这首歌时相同），因此地址总是当时可用的。得到的形式与 [`getMusicInfo`](#getmusicinfo) 的 `playback` 字段相同，可以原样作为本扩展 `getMusicInfo` 的 `playback` 返回。

  音频地址可能附带登录凭据（如请求头里的 Cookie），只应交给用户指定的对象。读取 `File` 的内容遵循本扩展自己的权限：位于本扩展数据目录以外的文件需要 `fs.read` 权限。
- **入参**：`sim.player.playback(track)`
  其中，`track` 是 `state.current` 或 `state.queue` 里的歌曲对象（只需 `source` 与 `id`），省略（或传 `null`）表示当前歌曲。
- **出参**：Promise，完成值为以下两种之一：
  - 网络地址 `{ url, headers }`：`url` 是 HTTP(S) 地址，`headers` 是请求它时要附带的请求头（没有时为 `{}`）；
  - [`File`](#file)：磁盘上的音频文件，有 `path`、`name`、`size`、`lastModified`。

  歌曲不在状态里、提供它的扩展未启用、没有返回音频或无权访问该音频时被拒绝。
- **调用示例**
  ```javascript
  await sim.player.playback();
  // { url: "https://m701.music.example.com/abc.flac?sign=...", headers: { Referer: "https://music.example.com/" } }

  const audio = await sim.player.playback(sim.player.state.queue[2]);
  // File { path: "D:\Music\a.flac", name: "a.flac", size: 31457280, lastModified: 1720000000000 }
  if (audio instanceof File) uploadFile(audio.path);   // 扩展自己实现的上传
  ```

---

# `sim.playPage` 接口

`sim.playPage` 用于扩展脚本与它自己的[播放页](#playpages播放页)通信。需要 `player` 权限。

## `sim.playPage.postMessage`

- **介绍**：向本扩展的播放页发送一条消息，同步。只有当用户选用的正是本扩展的播放页、且页面已经加载时才能送达。页面经 `simPlayer.on("message", ...)` 收到；页面发来的消息到达导出函数 [`onPlayPageMessage`](#onplaypagemessage)。
- **入参**：`sim.playPage.postMessage(data)`
  其中，`data` 必须能表示为 JSON。
- **出参**：布尔值，是否已送达。
- **调用示例**
  ```javascript
  exports.onSettingChange = (key, value) => sim.playPage.postMessage({ type: "setting", key, value });
  // true
  // 播放页的 message 事件收到 { type: "setting", key: "dark", value: true }，页面随即切换为深色
  ```

---

# `sim.plugins` 接口

`sim.plugins` 提供扩展管理：查看、安装、卸载、启用、停用、重新加载扩展（包括自己）。需要 `plugin` 权限。足以做成一个扩展商店：用 `sim.fetch` 下载 `.simex`，用 `sim.fs.writeFile` 存到数据目录，再交给 `sim.plugins.install`。

安装、卸载、启用、停用这四项，**每一次**调用主程序都会先向用户确认，没有“记住选择”。Promise 的完成值是用户是否同意——拒绝得到 `false`，不是异常；目标不存在、安装包无效时才被拒绝。目标本来就处于所要求的状态时直接得到 `true`，不打扰用户。

这些操作会使其他扩展重新启动。发起操作的扩展自己不会被重启（它的面板、定时器都保留），除非它注册或追加了歌曲协议，或者被操作的就是它自己。

## `sim.plugins.list`

- **介绍**：列出已安装的全部扩展，按加载顺序，同步。
- **入参**：`sim.plugins.list()`
- **出参**：`[{ id, name, version, author, description, permissions, builtin, development, enabled, running, error }]`
  其中，`permissions` 是清单声明的权限；`builtin` 表示随应用自带；`development` 表示从文件夹加载的开发扩展；`enabled` 是用户是否启用；`running` 是此刻是否在运行；`error` 是最近一次加载失败的原因，没有为空串。
- **调用示例**
  ```javascript
  sim.plugins.list();
  // [{ id: "local", name: "本地音乐", version: "1.0.0", author: "SimMusic", description: "...",
  //    permissions: ["sidebar", "fs.read", "fs.write", "shell", "trackMenu", "webview"],
  //    builtin: true, development: false, enabled: true, running: true, error: "" },
  //  { id: "exampleMusic", name: "示例音乐", version: "1.0.0", author: "你的名字", description: "一个在线音源。",
  //    permissions: ["network", "sidebar"], builtin: false, development: false, enabled: true, running: true, error: "" }]
  ```

## `sim.plugins.get`

- **介绍**：查询一个扩展，同步。
- **入参**：`sim.plugins.get(id)`
- **出参**：同 `list` 的元素；没有安装时为 `null`。
- **调用示例**
  ```javascript
  sim.plugins.get("exampleMusic").version;
  // "1.0.0"
  sim.plugins.get("notInstalled");
  // null
  ```

## `sim.plugins.install`

- **介绍**：安装（或覆盖更新）一个 `.simex` 包，异步。主程序弹出与用户自己安装时相同的安装界面，标明是哪个扩展请求的，用户可以在其中逐项关闭权限。
- **入参**：`sim.plugins.install(path)`
  其中，`path` 是 `.simex` 文件的路径（数据目录以外需要 `fs.read`）。
- **出参**：Promise，完成值为布尔值：用户是否确认了安装。
- **调用示例**
  ```javascript
  const response = await sim.fetch("https://store.example.com/packages/demo-1.2.0.simex");
  const file = sim.path.join(sim.plugin.dataDir, "demo-1.2.0.simex");
  sim.fs.writeFile(file, response.arrayBuffer());
  const installed = await sim.plugins.install(file);
  // true
  // 弹出安装界面，列出 demo 扩展请求的权限；用户点击安装后，扩展管理中出现该扩展
  ```

## `sim.plugins.uninstall`

- **介绍**：卸载一个扩展，异步。随应用自带的扩展不能卸载。
- **入参**：`sim.plugins.uninstall(id)`
- **出参**：Promise，完成值为布尔值：用户是否同意。
- **调用示例**
  ```javascript
  await sim.plugins.uninstall("demo");
  // false
  // 弹出确认框，用户点击了取消，扩展仍在
  ```

## `sim.plugins.setEnabled`

- **介绍**：启用或停用一个扩展，异步。
- **入参**：`sim.plugins.setEnabled(id, enabled)`
  其中，`enabled` 为 `true` 启用、`false` 停用。
- **出参**：Promise，完成值为布尔值：用户是否同意（已处于目标状态时直接为 `true`）。
- **调用示例**
  ```javascript
  await sim.plugins.setEnabled("demo", false);
  // true
  // 弹出确认框，用户同意后 demo 被停用：它的侧栏分区消失
  sim.plugins.get("demo").running;
  // false
  ```

## `sim.plugins.reload`

- **介绍**：重新加载一个扩展（重新读取它的清单与入口脚本），异步。不需要用户确认。
- **入参**：`sim.plugins.reload(id)`
- **出参**：Promise，完成值为 `true`；扩展不存在或重新加载后启动失败时被拒绝。
- **调用示例**
  ```javascript
  await sim.plugins.reload("demo");
  // true
  // demo 重新启动，它打开的面板与窗口被关闭
  ```

---

# `simHost` 接口（页面内）

`simHost` 是 [`sim.webview`](#simwebview-接口) 打开的页面里的全局对象，是页面与扩展脚本之间唯一的通道。页面是普通网页，没有 `sim`。消息必须能表示为 JSON：函数、DOM 对象、循环引用不能传递，二进制数据用 Base64。

## `simHost.postMessage`

- **介绍**：向扩展脚本发送一条消息，触发对应 webview 对象的 `message` 事件。
- **入参**：`simHost.postMessage(data)`
- **出参**：无。`data` 不能表示为 JSON 时抛出 `TypeError`。
- **调用示例**
  ```javascript
  // 页面里
  simHost.postMessage({ type: "play", id: "123" });
  // 扩展脚本里 webview.onmessage 收到 event.data 为 { type: "play", id: "123" }，event.origin 为 "ext://"
  ```

## `simHost.onmessage` / `simHost.addEventListener`

- **介绍**：接收扩展脚本用 `webview.postMessage` 发来的消息。两种写法等价；`addEventListener` / `removeEventListener` 的事件名是 `"message"`。
- **入参**：`simHost.onmessage = handler`、`simHost.addEventListener("message", handler)`
  其中，`handler` 收到一个事件对象，`event.data` 是扩展发来的数据。
- **出参**：无。
- **调用示例**
  ```javascript
  // 页面里
  simHost.onmessage = event => {
      if (event.data.type === "lists") render(event.data.lists);
  };
  simHost.postMessage({ type: "ready" });
  // 扩展脚本回复 panel.postMessage({ type: "lists", lists: [...] }) 后，页面渲染出列表
  ```

---

# `simPlayer` 接口（播放页内）

`simPlayer` 是[播放页](#playpages播放页)里的播放控制对象。页面引入主程序提供的脚本后即可使用：

```html
<script src="/.sim/player.js"></script>
```

它包含 [`sim.player`](#simplayer-接口) 的全部成员，用法完全一致：`state`、`on` / `off`、`position()`、`toggle` / `play` / `pause` / `stop`、`previous` / `next`、`seek`、`setVolume` / `setSpeed`、`cycleMode` / `setMode`、`playIndex` / `removeFromQueue` / `moveInQueue` / `clearQueue`、`setQueue` / `append` / `playNext`、`setSleep` / `cancelSleep`、`showWindow`、`loadInfo`、`spectrum`。**没有** `cover()`：页面里的歌曲对象直接带着可用作图片地址的 `cover` 与 `largeCover`。**也没有** `playback()`：歌曲的音频只交给扩展脚本。

以下只列出页面独有的部分。

**播放页的行为。** 被选用的播放页随应用启动而加载，盖在整个主窗口上，由主程序负责展开与收起（用户点击底栏封面、播放队列按钮等）。收起期间页面仍在运行并持续收到歌曲、队列、歌词的变化，因此展开的一刻内容就是对的；是否正在显示以 `state.visible` 为准，隐藏时页面应停止动画。其他规则：

- 未声明 `windowButtons` 时，主窗口右上角的收起、最小化、最大化、关闭按钮由主程序绘制并盖在页面上方，页面应避免在右上角 184×35 的区域放置内容；声明了 `windowButtons` 的页面必须自己提供这些按钮。
- 主程序的右键菜单、提示条和对话框始终显示在页面上方，页面不需要为它们让位。
- 页面顶部覆盖了主窗口的拖动区，用 CSS `-webkit-app-region: drag` 标出用来拖动窗口的区域。
- 拖到播放页上的文件会被拒绝。
- 只有扩展自己的页面能使用 `simPlayer`；页面跳转到其他站点后，播放控制失效。
- `localStorage` 不保证跨启动保留；需要保存的数据经 `simPlayer.postMessage` 交给扩展脚本，用 `sim.settings` 保存。
- 所选播放页的权限被撤销、扩展被停用或页面加载失败时，主程序自动改用其他可用的播放页。

## `simPlayer.state`（页面独有的字段）

- **介绍**：在 [`sim.player.state`](#simplayerstate) 的全部字段之外，播放页的状态还有与显示相关的字段，歌曲对象也多出封面地址。
- **入参**：无（属性）。
- **出参**：

  | 字段 | 含义 |
  | --- | --- |
  | `visible` | 播放页是否正在显示 |
  | `side` | 主程序希望页面展示的内容：`"queue"`（用户点了播放队列）、`"lyrics"` 或 `""` |
  | `windowMaximized` | 主窗口是否已最大化 |
  | `fullscreen` | 主窗口是否处于全屏 |
  | 歌曲对象的 `cover`、`largeCover` | 可直接用作 `<img>` 的 `src` 或 CSS 的 `url()`；`largeCover` 是大图 |

- **调用示例**
  ```javascript
  simPlayer.state.visible;
  // true
  simPlayer.state.side;
  // "lyrics"
  coverImage.src = simPlayer.state.current.largeCover;
  // 页面上的 <img id="coverImage"> 显示当前歌曲的大封面
  ```

## `simPlayer.ready`

- **介绍**：页面第一次收到状态后完成的 Promise。在它完成之前，`state` 里是空的初始值。
- **入参**：无（属性）。
- **出参**：Promise，完成值为状态对象。
- **调用示例**
  ```javascript
  const state = await simPlayer.ready;
  titleText.textContent = state.current ? state.current.title : "";
  // 页面标题处显示当前歌曲名
  ```

## `simPlayer.on`（页面独有的事件）

- **介绍**：在 [`sim.player.on`](#simplayeron--simplayeroff) 的事件之外，播放页还有两个事件。另外，页面里的 `status` 事件还会在 `windowMaximized`、`fullscreen` 变化时触发；`position` 事件在页面隐藏期间不触发。
- **入参**：`simPlayer.on(type, handler)`

  | 事件 | 何时触发 | 处理函数的参数 |
  | --- | --- | --- |
  | `view` | `visible`、`side` 变化 | 状态对象 |
  | `message` | 扩展脚本调用了 `sim.playPage.postMessage` | 扩展发来的数据 |

- **出参**：`simPlayer` 本身。
- **调用示例**
  ```javascript
  simPlayer.on("track", state => {
      titleText.textContent = state.current ? state.current.title : "";
      coverImage.src = state.current ? state.current.largeCover : "";
  });
  simPlayer.on("view", state => { queuePanel.hidden = state.side !== "queue"; });
  simPlayer.on("message", data => { if (data.type === "setting") applySetting(data.key, data.value); });
  const frame = () => {
      if (simPlayer.state.visible) progressBar.value = simPlayer.position();
      requestAnimationFrame(frame);
  };
  frame();
  // 展开播放页：显示当前歌曲的标题与封面，进度条平滑前进；用户点击底栏的播放队列按钮时，队列面板出现
  ```

## `simPlayer.close`

- **介绍**：收起播放页。
- **入参**：`simPlayer.close()`
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  closeButton.onclick = () => simPlayer.close();
  // 点击后播放页向下滑出，回到主界面
  ```

## `simPlayer.showMenu`

- **介绍**：在鼠标指针处弹出主程序的歌曲菜单。
- **入参**：`simPlayer.showMenu(options)`
  其中，`options` 可省略：省略时是当前歌曲的播放页菜单（添加到歌单、下载、睡眠定时、倍速、均衡器、输出设备、扩展菜单等）；为 `{ scene: "queue", index }` 时是播放队列中第 `index` 首的菜单。
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  moreButton.onclick = () => simPlayer.showMenu();
  // 指针处弹出当前歌曲的菜单
  queueItem.oncontextmenu = () => simPlayer.showMenu({ scene: "queue", index: 3 });
  // 指针处弹出队列中第 4 首的菜单
  ```

## `simPlayer.showDialog`

- **介绍**：打开主程序的对话框。
- **入参**：`simPlayer.showDialog(name)`
  其中，`name` 为 `"equalizer"`（均衡器）、`"sleep"`（睡眠定时）或 `"speed"`（倍速）。
- **出参**：Promise，得到 `true`；`name` 未知时被拒绝。
- **调用示例**
  ```javascript
  await simPlayer.showDialog("equalizer");
  // true
  // 均衡器对话框出现在播放页上方
  ```

## `simPlayer.setLyricsShown`

- **介绍**：告诉主程序用户在页面里打开或关闭了歌词。主程序记住这个选择，下次展开时经 `state.side` 传回。
- **入参**：`simPlayer.setLyricsShown(shown)`
  其中，`shown` 为布尔值。
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  lyricsButton.onclick = () => simPlayer.setLyricsShown(simPlayer.state.side !== "lyrics");
  // 点击后 state.side 在 "lyrics" 与 "" 之间切换，并触发 view 事件
  ```

## `simPlayer.window`

- **介绍**：操作主窗口，供声明了 `windowButtons`、自己绘制窗口按钮的页面使用。
- **入参**：`simPlayer.window(name)`
  其中，`name` 为 `"minimize"`、`"maximize"`（最大化 / 还原）或 `"close"`。
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  maximizeButton.onclick = () => simPlayer.window("maximize");
  // 主窗口最大化；随后 status 事件送达，state.windowMaximized 为 true
  ```

## `simPlayer.setTitleBar`

- **介绍**：运行时更改主程序绘制的窗口按钮区域的底色与图标深浅，例如跟随封面取色。
- **入参**：`simPlayer.setTitleBar(options)`
  其中，`options` 为 `{ color, dark }`：`color` 是 `#rrggbb`；`dark` 为 `true` 时使用浅色图标。两者都可省略。
- **出参**：Promise，得到 `true`。
- **调用示例**
  ```javascript
  await simPlayer.setTitleBar({ color: "#101820", dark: true });
  // true
  // 右上角窗口按钮区域变为深蓝底色、浅色图标
  ```

## `simPlayer.setFullscreen` / `toggleFullscreen`

- **介绍**：让主窗口进入 / 退出全屏，不需要用户手势。只有播放页正在展开时可以调用；收起播放页时自动退出全屏。页面自己调用标准的 Fullscreen API 效果相同。
- **入参**：`simPlayer.setFullscreen(on)`、`simPlayer.toggleFullscreen()`
- **出参**：Promise，得到 `true`；播放页未展开时被拒绝。
- **调用示例**
  ```javascript
  await simPlayer.toggleFullscreen();
  // true
  // 主窗口铺满整个屏幕；随后 state.fullscreen 为 true
  ```

## `simPlayer.postMessage`

- **介绍**：向扩展脚本发送一条消息，到达导出函数 [`onPlayPageMessage(pageId, data)`](#onplaypagemessage)。扩展用 `sim.playPage.postMessage` 回复，页面经 `message` 事件收到。
- **入参**：`simPlayer.postMessage(data)`
  其中，`data` 必须能表示为 JSON。
- **出参**：无。
- **调用示例**
  ```javascript
  simPlayer.on("message", data => { if (data.type === "settings") applySettings(data.values); });
  simPlayer.postMessage({ type: "getSettings" });
  // 扩展脚本的 onPlayPageMessage("vinyl", { type: "getSettings" }) 被调用；它回复后页面应用这些设置
  ```

## `simPlayer.shortcuts`

- **介绍**：页面获得焦点时，主窗口的快捷键是否照常可用。默认 `true`：空格、方向键、Ctrl+左右、Esc、W/A/S/D、Ctrl+F、Ctrl+O 交给主界面处理，F11 切换全屏；输入框内的按键不受影响。页面想自己处理某个按键时，对它调用 `preventDefault()`；设为 `false` 则全部关闭。
- **入参**：无（可写属性）。
- **出参**：布尔值。
- **调用示例**
  ```javascript
  addEventListener("keydown", event => {
      if (event.key === " ") { event.preventDefault(); toggleMyOwnAnimation(); }
  }, true);
  // 空格不再播放 / 暂停，其余快捷键照常

  simPlayer.shortcuts = false;
  // 页面里所有按键都不再触发主窗口的快捷键
  ```

---

# 主程序提供的页面资源

webview 页面与播放页可以用以下地址引用主程序提供的资源，以便与主界面风格一致。它们与页面同源，直接写路径即可。

| 地址 | 内容 |
| --- | --- |
| `/.sim/player.js` | [`simPlayer`](#simplayer-接口播放页内)，仅播放页使用 |
| `/.sim/fonts.css` | 图标字体（字体族名 `icon`，RemixIcon）与用户选择的界面字体 |
| `/.sim/simui.css`、`/.sim/simui.js` | 主界面使用的 SimUI 样式与组件脚本 |
| `/.sim/cssRules.js`、`/.sim/runtime.css` | `simui.js` 的依赖 |
| `/.sim/assets/placeholder.png` | 没有封面时的占位图 |

- **调用示例**
  ```html
  <!doctype html>
  <html>
  <head>
      <meta charset="utf-8">
      <title>我的页面</title>
      <link rel="stylesheet" href="/.sim/fonts.css">
      <link rel="stylesheet" href="/.sim/simui.css">
      <link rel="stylesheet" href="/.sim/runtime.css" id="runtimeCss">
      <link rel="stylesheet" href="home.css">
  </head>
  <body>
      <button class="sub" id="playButton">播放</button>
      <script src="/.sim/cssRules.js"></script>
      <script src="/.sim/simui.js"></script>
      <script src="home.js"></script>
  </body>
  </html>
  <!-- 页面使用与主界面相同的字体与按钮样式；home.css、home.js 是扩展目录中与本页面同目录的文件 -->
  ```

使用 `simui.js` 时，`cssRules.js` 必须先于它加载，并且页面里要有上面那个 `id="runtimeCss"` 的 `<link>`。

---

# 打包与调试

## 从文件夹加载

在扩展管理中选择“从文件夹加载”，选中包含 `plugin.json` 的目录并授权。这种方式直接使用该目录中的文件，不复制：修改源文件后点击该扩展的“重新加载”即可生效；移除开发扩展只解除引用，不删除源文件。重新加载会读取新的清单，但**不会**自动授予新增的权限，需要在权限管理中打开。

扩展的 `console` / `sim.log` 输出、导出函数的异常、超时与加载失败的原因，都在扩展管理中该扩展的“日志”里。

## 打包为 `.simex`

`.simex` 是一个 ZIP 文件，**包的根目录**直接包含 `plugin.json` 和入口脚本，不要把整个扩展目录再套一层。

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = (Resolve-Path "./exampleMusic").Path
$package = Join-Path (Split-Path $source -Parent) "exampleMusic-1.0.0.simex"
[IO.Compression.ZipFile]::CreateFromDirectory($source, $package, [IO.Compression.CompressionLevel]::Optimal, $false)
```

限制：压缩包最大 64 MiB，最多 4096 个条目，解压后总大小最多 128 MiB；不能包含符号链接、越出包外的路径，以及仅大小写不同的重名路径。扩展不能依赖 Node.js 运行时或 `node_modules`。

## 发布前自查

1. 安装打包后的 `.simex`（而不是从文件夹加载）验证包结构。
2. 重新加载与重启应用后，设置与扩展自己保存的数据都能恢复；`init` 可以重复执行。
3. 用户取消对话框时不报错。
4. 逐项关闭清单里的权限，确认扩展能给出合理的表现，而不是不断抛出异常。
5. 在线资源的 `expire` 不超过服务实际的有效期；过期后能重新取得。
6. 长列表与搜索按批量接口请求远端数据，并控制并发。
