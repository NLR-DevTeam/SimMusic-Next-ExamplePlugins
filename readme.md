# SimMusic Next 示例扩展

本仓库收录五个 SimMusic Next 示例扩展，涵盖在线音源、任务栏歌词、播放页和多人同步播放。扩展脚本由宿主的 Goja 执行，网页由 CEF 渲染，运行时无需安装 Node.js。

开发接口参见 [扩展开发文档](extension-development.md)。本仓库独立于 SimMusic Next 主程序仓库。

| 目录 | 名称 | 版本 | 用途 |
| --- | --- | --- | --- |
| [ncmNext](ncmNext/) | 网易云 Nodejs API | 2.4.0 | 接入网易云 API，提供搜索、账号音乐库、播放与下载 |
| [taskbarLyrics](taskbarLyrics/) | Windows 任务栏歌词 | 1.1.3 | 在任务栏显示歌词、封面与播放控制 |
| [lyricVideo](lyricVideo/) | LRC 2 MV | 1.4.2 | 以歌词排版和动态背景呈现歌曲的播放页 |
| [lyricWheel](lyricWheel/) | 歌词轮盘 | 2.1.0 | 唱片、弧形歌词与频谱组成的播放页 |
| [musicSync](musicSync/) | 一起听 | 1.0.0 | 通过分享链接共用播放队列、播放状态与进度 |

## 安装

使用当前版本的 SimMusic Next。部分示例使用新增的表单弹窗和歌曲列表菜单接口，旧版宿主可能不支持。

每个目录都是一个独立扩展，`plugin.json` 位于扩展根目录。将该目录内的文件压缩为 ZIP，再把扩展名改成 `.simex`，即可通过 SimMusic 的扩展管理安装。压缩包根目录必须直接包含 `plugin.json` 和 `main.js`，不要再套一层目录。

在仓库根目录执行以下 PowerShell 命令，重新编译原生辅助程序、中继服务，并为五个扩展生成安装包：

```powershell
./build.ps1
```

安装时按需授予扩展声明的权限。安装后的可编辑文件位于应用数据目录的 `plugins/<扩展 ID>`，设置和运行数据由宿主另行保存；修改仓库里的示例不会自动更新已安装的副本。

构建输出位于根目录 `release/`，该目录已加入 `.gitignore`。其中五个 `.simex` 是客户端安装包，`musicSyncRelay/` 内是独立部署的 Windows / Linux x64 中继服务。

## ncmNext：网易云 Nodejs API

通过可配置的网易云 Nodejs API 服务提供音源和账号页面。本目录包含客户端扩展，不包含网易云 API 服务端。

- 支持歌曲搜索、在线播放、下载、传统歌词和逐字歌词。
- 提供推荐歌单、新歌、每日推荐、喜欢的音乐、收藏歌单和自建歌单页面。
- 支持在内置登录窗口登录账号，以及歌单导入、收藏和管理。
- 支持分别配置歌曲解析 API、播放音质和下载音质，并接入宿主歌曲列表菜单。

安装后，在扩展设置中填写“API 地址”，也可以在网易云页面的账号菜单中配置 API 端点。若解析歌曲使用另一套服务，可另填“歌曲解析 API 地址”；留空时使用主 API。

两个 Header 设置均采用 `a=b&c=d` 格式，键和值需要 URL 转义。账号相关功能需要登录；“自动解灰”需要支持该能力的 Enhanced API。实际歌曲可用性、音质和账号操作取决于 API 服务及账号权限。

声明权限：`network`、`sidebar`、`trackMenu`、`shell`、`clipboard.write`、`webview`、`player`。

入口为 [main.js](ncmNext/main.js)，账号和音乐库页面位于 [page/](ncmNext/page/)。扩展 ID 是 `ncmNext`，歌曲协议是 `ncm`。

## taskbarLyrics：Windows 任务栏歌词

将当前歌词、歌曲信息与封面嵌入 Windows 任务栏。鼠标移入后显示播放模式、上一首、播放 / 暂停、下一首、音量和打开主窗口等控制。

安装并启用后自动启动，可在扩展设置中调整歌词区域宽度和文字对齐方式。没有歌词时显示歌曲信息。该扩展仅在 Windows 上启动原生窗口，Windows 11 的任务栏占位由配套布局 DLL 处理。

目录同时保留原生源码和现有 Windows x64 辅助程序：

- `taskbarLyrics.exe`：任务栏歌词窗口，通过标准输入 / 输出与扩展脚本通信。
- `taskbarLayout-1.1.3.dll`：处理 Windows 11 任务栏内部布局占位。
- [native/](taskbarLyrics/native/)：窗口与布局组件的 C / C++ 源码和资源文件。

打包安装时保留 EXE 和 DLL；仅复制 JavaScript 无法显示任务栏歌词。

声明权限：`player`、`shell`。入口为 [main.js](taskbarLyrics/main.js)。

## lyricVideo：LRC 2 MV

提供“歌词 MV”播放页，将歌曲歌词作为画面主体，支持横排、上下两行、竖排和自动切换版式。没有歌词时显示歌曲信息，移动鼠标可唤出播放控制。

安装后，在播放器的“播放页样式”中选择“歌词 MV”。扩展设置可调整字体、自定义字体名称、歌词版式、逐字歌词、光斑粒子、背景大字、胶片颗粒和镜头律动。自定义字体需要已安装在本机。

页面隐藏时会暂停自身动画和绘制；关闭光斑粒子也可减少可见播放时的硬件开销。

声明权限：`playPage`、`player`。设置入口为 [main.js](lyricVideo/main.js)，播放页由 `mv.html`、`mv.css` 和 `mv.js` 组成。

## lyricWheel：歌词轮盘

提供“歌词轮盘”播放页：唱片封面位于左侧，歌词沿同心圆弧排列，外圈显示音频频谱，界面颜色随封面变化。支持逐字歌词、手动滚动浏览歌词，以及点击歌词跳转播放位置。

安装后，在“播放页样式”中选择“歌词轮盘”。页面直接使用宿主提供的播放状态、歌词和频谱，无需单独配置音源。

声明权限：`playPage`、`player`。扩展在 [plugin.json](lyricWheel/plugin.json) 中声明播放页，页面由 `wheel.html`、`wheel.css` 和 `wheel.js` 组成。

## musicSync：一起听

创建分享链接，让其他 SimMusic 客户端或浏览器加入同一场播放。各端可控制队列、切歌、播放 / 暂停、进度和倍速；分享可设置独立密码。

该扩展需要一个单独运行的中继服务。扩展会提供歌曲地址，或通过辅助程序上传本地音频；浏览器听众使用中继自带的网页播放器。

### 部署中继

[relay/](musicSync/relay/) 包含 Go 服务端及其网页资源。在仓库根目录构建 Windows 服务端：

```powershell
$env:PATH = "C:\VM Projects\Go Tool Chain\go\bin;$env:PATH"
$env:GOCACHE = "C:\VM Projects\Go Tool Chain\gocache"
$env:GOPATH = "C:\VM Projects\Go Tool Chain\gopath"
New-Item -ItemType Directory -Force release/musicSyncRelay | Out-Null
go build -o release/musicSyncRelay/musicsync-relay.exe ./musicSync/relay
```

启动示例：

```powershell
./release/musicSyncRelay/musicsync-relay.exe -addr 0.0.0.0:8686 -key "your-server-key"
```

`-addr` 默认是 `:8686`，监听所有网卡；`-key` 用于限制创建分享，留空则允许任何人创建。服务器密钥与每次分享的密码是两项独立配置。

### 使用

1. 在“一起听”的扩展设置中填写中继的“服务器地址”和对应“服务器密钥”。地址必须能被其他参与者访问。
2. 打开侧边栏的“一起听”，创建分享并复制链接，可选设置分享密码。
3. 其他 SimMusic 用户在“一起听”中粘贴链接加入；浏览器用户直接打开链接。
4. 创建者结束分享或离线超时后，中继会结束该场分享。

目录内的 `musicSyncUpload.exe` 和 `musicSyncUpload` 分别是现有 Windows / Linux 上传辅助程序，源码位于 [upload/](musicSync/upload/)。客户端打包时应保留对应平台的辅助程序。`relay/` 是独立部署的服务端，不会由扩展自动启动。

声明权限：`player`、`network`、`shell`、`sidebar`、`webview`、`clipboard.write`。客户端入口为 [main.js](musicSync/main.js)。


## 构建要求

在本仓库根目录执行 `./build.ps1`，产物输出到本仓库的 `release/`。脚本会重新编译任务栏歌词原生组件，以及一起听的 Windows / Linux x64 上传程序和中继服务，再打包五个扩展；其余三个扩展直接打包 JavaScript 和网页资源。

构建需要 PowerShell、Go 和 Windows x64 MinGW GCC / G++。默认 Go 工具链目录为 `C:\VM Projects\Go Tool Chain`，可用 `-GoToolchain` 指定另一处包含 `go/bin`、`gocache` 和 `gopath` 的目录。构建使用本仓库内的源码和网页资源，无需 SimMusic Next 主仓库。

## 阅读源码

每个扩展的 `plugin.json` 声明身份、入口、权限和可选的歌曲协议或播放页。`main.js` 使用宿主的 `sim` API，扩展网页通过宿主消息桥接或 `simPlayer` 获取状态、请求操作。音频播放仍由主程序的 Go 音频内核完成。

这些示例未被编入主程序，也不会随主程序启动自动安装。可以独立修改、打包和安装各个扩展。

## 许可协议

与 SimMusic Next 主程序使用相同的 GNU GPL v3 许可证，完整文本见 [LICENSE](LICENSE)。
