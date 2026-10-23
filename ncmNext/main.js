// SimMusic-NCM-Ext, MIT. Ported to the Next Goja extension interface.
const defaults = { apiEndpoint: "", apiHeaders: "", songApiEndpoint: "", songApiHeaders: "", searchLimit: 30, filterInvalid: true, autoUnblock: false, musicQuality: "standard", downloadQuality: "standard", lyricType: "yrc", formatLrc: true, maxParallelCount: 8, playlists: [] };
const setting = key => sim.settings.get(key, defaults[key]);
const numberSetting = (key, min, max) => Math.max(min, Math.min(max, Number(setting(key)) || defaults[key]));
const ref = id => ({ source: "ncm", id: String(id) });
const songID = value => {
    const input = String(value).trim();
    if (/^\d+$/.test(input)) return input;
    const match = /(?:[?&#]|\/)(?:id=|playlist\/|song\/)(\d+)/.exec(input);
    if (!match) throw new Error("无法解析 ID，请输入网易云分享 URL 或数字 ID。");
    return match[1];
};
const apiError = (message, kind = "request") => Object.assign(new Error(message), { kind });
const endpointValue = (key = "apiEndpoint") => String(setting(key)).trim().replace(/\/+$/, "");
const songApiRoutes = new Set(["/song/detail", "/song/url", "/song/url/match"]);
let lastRequestTime = 0;
const request = async (route, query = {}, options = {}) => {
    const songRequest = songApiRoutes.has(route);
    const songEndpoint = songRequest ? endpointValue("songApiEndpoint") : "";
    const songHeaders = songRequest ? String(setting("songApiHeaders") || "") : "";
    const separate = !!songEndpoint || !!songHeaders.trim();
    const endpoint = songEndpoint || endpointValue();
    if (!/^https?:\/\/[^\s?#]+$/.test(endpoint)) throw apiError(songEndpoint ? "请在扩展设置中填写有效的歌曲解析 API 地址。" : "请先连接网易云 API 服务。", songEndpoint ? "input" : "setup");
    query = { ...query };
    const headers = {};
    for (const part of String(songHeaders.trim() ? songHeaders : setting("apiHeaders") || "").split("&").filter(Boolean)) {
        const index = part.indexOf("=");
        if (index < 1) throw new Error("Header 格式应为 a=b&c=d，需要 URL 转义。");
        const key = decodeURIComponent(part.slice(0, index));
        const value = decodeURIComponent(part.slice(index + 1));
        if (key.toLowerCase() === "cookie") query.cookie = value;
        else headers[key] = value;
    }
    // Custom song resolution never receives the saved account session, even if its
    // endpoint matches the main API. Explicitly configured Headers stay unchanged.
    if (!separate && sim.settings.get("sessionEndpoint", "") === endpoint && sim.settings.get("sessionCookie", "")) query.cookie = [query.cookie, sim.settings.get("sessionCookie", "")].filter(Boolean).join("; ");
    const cookie = query.cookie || "";
    delete query.cookie;
    const method = cookie || options.write || options.json ? "POST" : "GET";
    const send = async method => {
        const requestHeaders = { ...headers }, params = { ...query };
        let body;
        if (method === "POST") {
            Object.keys(requestHeaders).filter(key=>key.toLowerCase()==="content-type").forEach(key=>delete requestHeaders[key]);
            requestHeaders["Content-Type"] = options.json ? "application/json" : "application/x-www-form-urlencoded";
            body = options.json ? JSON.stringify({ ...query, ...(cookie ? { cookie } : {}) }) : cookie ? `cookie=${encodeURIComponent(cookie)}` : "";
            if (options.json) Object.keys(params).forEach(key=>delete params[key]);
        } else if (cookie) {
            // NodeJS API also accepts Cookie headers. Credentials never enter the URL.
            requestHeaders.Cookie = cookie;
        }
        if (method === "POST" || options.fresh || options.write || options.json) params.timestamp = lastRequestTime = Math.max(Date.now(),lastRequestTime+1);
        const search = Object.entries(params).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
        let timer;
        const response = await Promise.race([
            sim.fetch(`${endpoint}${route}?${search}`, { method, headers: requestHeaders, ...(method === "POST" ? { body } : {}) }),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(apiError("服务响应超时，请稍后重试。","timeout")),options.timeout||18000);})
        ]).finally(()=>clearTimeout(timer));
        let data = null;
        try { data = response.json(); } catch (_) {}
        if (data?.body && typeof data.body === "object") data = data.body;
        return { response, data };
    };
    let { response, data } = await send(method);
    // A proxy rejecting POST is distinct from NetEase's business code 405. Retry only
    // an explicit method rejection, never a business rejection or an ambiguous timeout.
    if (method === "POST" && response.status === 405 && (!data || /^method not allowed[.!\s]*$/i.test(String(data.message || data.msg || data.error || data.detail || "")))) ({ response, data } = await send("GET"));
    if (!response.ok) {
        const kind = response.status === 401 || [301,401].includes(Number(data?.code)) ? separate ? "request" : "auth" : [404,501].includes(response.status) ? "unsupported" : "request";
        if (kind === "auth") {accountCache.clear();clearPageCache();}
        const message = data && typeof (data.message || data.msg) === "string" ? data.message || data.msg : `API 请求失败（HTTP ${response.status}）。`;
        throw apiError(message,kind);
    }
    if (!data || typeof data !== "object") throw apiError("服务返回了无法识别的数据，请检查 API 地址。", "response");
    if (data.code && Number(data.code) !== 200 && !(options.codes || []).includes(Number(data.code))) {
        const kind = !separate && [301, 401].includes(Number(data.code)) ? "auth" : "request";
        if (kind === "auth") {accountCache.clear();clearPageCache();}
        throw apiError(data.message || data.msg || `API 返回错误 ${data.code}。`, kind);
    }
    return data;
};
const parallel = async (items, task) => {
    let next = 0;
    const result = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(items.length, numberSetting("maxParallelCount", 1, 16)) }, async () => {
        while (next < items.length) { const index = next++; result[index] = await task(items[index]); }
    }));
    return result;
};
const chunks = ids => Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
const details = async ids => {
    const responses = await parallel(chunks(ids), group => request("/song/detail", { ids: group.join(",") }));
    return {
        songs: responses.flatMap(data => data.songs || []),
        privileges: responses.flatMap(data => data.privileges || [])
    };
};
const validSongs = (ids, privileges) => {
    if (!setting("filterInvalid")) return ids;
    const allowed = new Map(privileges.map(item => [String(item.id), item.plLevel ? item.plLevel !== "none" || item.payed === 1 || (item.chargeInfoList || []).some(charge => charge.chargeType === 0) : !(item.st < 0 || item.fee === 1 && !item.payed)]));
    return ids.filter(id => allowed.get(String(id)) !== false);
};
const cover = (url, size) => url ? { url: `${url}${url.includes("?") ? "&" : "?"}param=${size}y${size}`, expire: 86400 } : null;
const lyricTime = ms => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
// YRC uses absolute millisecond times. Enhanced LRC keeps each word's start and end,
// including gaps, and is understood by both the host and downloaded local songs.
const yrcToLrc = source => {
    let timed = false;
    const lines = String(source || "").replace(/\r/g, "").split("\n").map(line => {
        if (line.startsWith("{")) {
            try {
                const data = JSON.parse(line);
                if (Number.isFinite(data.t) && data.t >= 0 && Array.isArray(data.c)) return `[${lyricTime(data.t)}]` + data.c.map(item => item.tx || "").join("");
            } catch (_) {}
            return "";
        }
        const header = /^\[(\d+),(\d+)\]/.exec(line);
        if (!header) return "";
        const body = line.slice(header[0].length);
        const tags = [...body.matchAll(/\((\d+),(\d+),\d+\)/g)];
        if (!tags.length) return "";
        let text = "", end = 0;
        tags.forEach((tag, index) => {
            const piece = body.slice(tag.index + tag[0].length, index + 1 < tags.length ? tags[index + 1].index : body.length);
            const start = Number(tag[1]);
            if (index && start > end) text += `<${lyricTime(end)}>`;
            text += `<${lyricTime(start)}>${piece}`;
            end = start + Number(tag[2]);
        });
        if (!body.replace(/\((\d+),(\d+),\d+\)/g, "").trim()) return "";
        timed = true;
        return `[${lyricTime(Number(header[1]))}]${text}<${lyricTime(end)}>`;
    }).filter(Boolean);
    return timed ? lines.join("\n") : "";
};
const formatLyrics = text => {
    if (setting("formatLrc")) text = text.split("\n").map(line => {
        const tags = line.match(/^(?:\[[^\]]*\])*/)?.[0] || "";
        return tags + line.slice(tags.length).split(/(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/).map((part, index) => index % 2 ? part : part.replace(/([,?!])(?![\s,?!])/g, "$1 ").replace(/(?<!\d)\.(?!\d|\s|\.)/g, ". ")).join("");
    }).join("\n");
    return text;
};
const lyrics = async id => {
    const perWord = setting("lyricType") === "yrc";
    // Old API deployments can still supply ordinary lyrics when /lyric/new is unavailable.
    let data = await request(perWord ? "/lyric/new" : "/lyric", { id }).catch(error => {
        if (!perWord) throw error;
        return request("/lyric", { id });
    });
    if (data.pureMusic) return "";
    const words = yrcToLrc(data.yrc?.lyric);
    if (!words && !data.lrc?.lyric && perWord) data = await request("/lyric", { id });
    if (data.pureMusic) return "";
    const traditional = [data.lrc?.lyric, data.tlyric?.lyric].filter(Boolean).join("\n");
    const enhanced = words ? [words, data.ytlrc?.lyric || data.tlyric?.lyric].filter(Boolean).join("\n") : traditional;
    return formatLyrics(perWord ? enhanced : traditional);
};
const lyricTypes = [{ value: "yrc", label: "逐字歌词" }, { value: "lrc", label: "传统歌词" }];
const qualities = [{value:"low",label:"低 (192 kbps)"},{value:"standard",label:"标准 (320 kbps)"},{value:"sq",label:"SQ (~1000 kbps)"},{value:"hr",label:"High-Res (~2000 kbps)"}];
const urls = async (ids, quality) => {
    const br = { low: 192000, standard: 320000, sq: 1000000, hr: 10000000 }[quality] || 320000;
    const responses = await parallel(chunks(ids), group => request("/song/url", { id: group.join(","), br }));
    const values = new Map(responses.flatMap(data => data.data || []).map(item => [String(item.id), item]));
    return parallel(ids, async id => {
        const item = values.get(id) || {};
        if (!item.url && setting("autoUnblock")) { const data = await request("/song/url/match", { id }); if (typeof data.data === "string") item.url = data.data; }
        if (!item.url) throw new Error(`曲目 ${id} 无可用播放地址，请检查账号权限或 API。`);
        return { id, resource: { url: item.url, expire: Math.max(0, Number(item.expi || 0) - 30) }, ext: String(item.type || "mp3").toLowerCase() };
    });
};
const importPlaylist = async input => {
    const id = songID(input);
    const data = await request("/playlist/detail", { id });
    if (!data.playlist) throw new Error("API 未返回歌单。");
    const ids = [...new Set((data.playlist.trackIds || data.playlist.tracks || []).map(song => String(song.id)))];
    const entries = [...setting("playlists")];
    const index = entries.findIndex(item => item.id === id);
    // A re-import keeps the remark the user gave the playlist.
    const entry = { id, name: data.playlist.name, ids, ...(entries[index]?.remark ? { remark: entries[index].remark } : {}) };
    if (index < 0) entries.push(entry); else entries[index] = entry;
    sim.settings.set("playlists", entries);
    sim.ui.refresh();
    sim.ui.toast("歌单已导入");
    return entry;
};
const promptPlaylist = async () => {
    const input = await sim.dialog.prompt("导入网易云歌单", "歌单分享 URL 或 ID", "");
    if (input) return importPlaylist(input);
};
// Account and library data stay in Goja. Pages receive only normalized display data, never Headers or Cookies.
const fixedTabs = [{ id: "home", name: "主页" }, { id: "daily", name: "日推" }, { id: "liked", name: "喜欢" }, { id: "collection", name: "收藏" }];
const views = new Set(), accountCache = new Map(), writes = new Set(), pageCache = new Map(), pageReads = new Map(), pageVersions = new Map();
let pageCacheEpoch = 0;
let accountEpoch = 0, loginWindow = null, cookieSyncPaused = false, loginOpening = false;
const idValue = value => {
    const id = String(value || "");
    if (!/^\d{1,24}$/.test(id)) throw apiError("无效的网易云资源 ID。", "input");
    return id;
};
const pageValue = value => Math.max(0, Math.min(100000, Math.floor(Number(value) || 0)));
const imageUrl = (value, size = 400) => {
    const url = String(value || "");
    return /^https?:\/\//.test(url) ? `${url}${url.includes("?") ? "&" : "?"}param=${size}y${size}` : "";
};
const cacheData = (key, read, ttl = 60000) => {
    const current = accountCache.get(key);
    if (current?.until > Date.now()) return Promise.resolve(current.value);
    if (current?.promise) return current.promise;
    const epoch = accountEpoch;
    const entry = {};
    entry.promise = Promise.resolve().then(read).then(value => {
        if (epoch !== accountEpoch) throw apiError("账号状态已变化，请刷新页面。", "stale");
        entry.value = value; entry.until = Date.now() + ttl; entry.promise = null;
        return value;
    }).catch(error => { if (accountCache.get(key) === entry) accountCache.delete(key); throw error; });
    if (accountCache.size >= 160) {
        const oldest=[...accountCache.entries()].find(([name,value])=>!value.promise&&!["profile","liked","collectPlaylists"].includes(name));
        if(oldest)accountCache.delete(oldest[0]);
    }
    accountCache.set(key, entry);
    return entry.promise;
};
const sendViews = data => views.forEach(view => { if (!view.closed) view.postMessage(data); });
const pageRoot = data => `${data.tab}:${data.id || ""}`;
const clearPageCache = () => { pageCacheEpoch++;pageCache.clear();pageReads.clear();pageVersions.clear(); };
const invalidatePage = (tab,id="") => {
    const root = pageRoot({tab,id});
    pageVersions.set(root,(pageVersions.get(root)||0)+1);
    for (const [key,entry] of pageCache) if(entry.root===root)pageCache.delete(key);
    for (const [key,entry] of pageReads) if(entry.root===root)pageReads.delete(key);
};
const freshPage = data => {
    invalidatePage(data.tab,data.id);
    if(data.tab==="home"){accountCache.delete("discovery");accountCache.delete("newSongs");}
    else if(data.tab==="daily")for(const key of accountCache.keys()){if(key.startsWith("daily:"))accountCache.delete(key);}
    else if(data.tab==="liked")accountCache.delete("liked");
    else if(data.tab==="playlist")accountCache.delete(`playlist:${data.id}`);
    else if(["collection","owned"].includes(data.tab)){
        for(const key of accountCache.keys())if(key.startsWith("library:"))accountCache.delete(key);
        accountCache.delete("collectPlaylists");
    }
};
const resetAccount = () => {
    accountEpoch++; accountCache.clear();clearPageCache();
    sendViews({ type: "accountChanged" });
};
const profile = (allowStale=false) => {
    const previous=accountCache.get("profile"),epoch=accountEpoch;
    const fresh=cacheData("profile",async()=>{
        const data=await request("/login/status",{},{fresh:true});
        const user=data.data?.profile||data.profile;
        if(!user?.userId)return null;
        return {id:idValue(user.userId),name:String(user.nickname||"网易云用户"),avatar:imageUrl(user.avatarUrl,80),signature:String(user.signature||"")};
    },120000);
    if(allowStale&&previous?.value&&previous.until<=Date.now()&&previous.until+1800000>Date.now()){
        fresh.then(user=>{
            if(epoch!==accountEpoch)return;
            if(previous.value.id!==user?.id){resetAccount();accountCache.set("profile",{value:user,until:Date.now()+120000});}
            else sendViews({type:"profileChanged",user});
        }).catch(error=>{if(error.kind==="auth"&&epoch===accountEpoch)resetAccount();});
        return Promise.resolve(previous.value);
    }
    return fresh;
};
const requireAccount = async () => {
    const user = await profile();
    if (!user) throw apiError("登录网易云账号后即可查看和同步你的音乐。", "auth");
    return user;
};
const syncBrowserCookies = async () => {
    if (cookieSyncPaused || !sim.permissions.has("webview")) return false;
    const epoch = accountEpoch, endpoint = endpointValue();
    const cookies = await sim.webview.cookies.get("https://music.163.com/");
    if (cookieSyncPaused || epoch !== accountEpoch || endpoint !== endpointValue()) return false;
    // Anonymous MUSIC_A is not an account login. Do not import unrelated site cookies.
    if (!cookies.some(cookie => cookie.name === "MUSIC_U" && cookie.value)) return false;
    const value = cookies.filter(cookie => /^[\w-]+$/.test(cookie.name) && !/[;\r\n]/.test(cookie.value)).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
    if (value === sim.settings.get("sessionCookie", "") && endpointValue() === sim.settings.get("sessionEndpoint", "")) return false;
    sim.settings.set("sessionCookie", value);
    sim.settings.set("sessionEndpoint", endpointValue());
    resetAccount();
    return true;
};
const openLogin = async () => {
    if (!sim.permissions.has("webview")) throw apiError("请在扩展权限中允许网页视图。", "permission");
    if (!endpointValue()) throw apiError("请先连接 API 服务，再登录账号。", "setup");
    if (loginOpening) return;
    loginOpening = true;
    cookieSyncPaused = true;
    const openingEpoch = ++accountEpoch;
    try {
    if (loginWindow && !loginWindow.closed) loginWindow.close();
    // Start the official login page with an empty extension browser Cookie jar. The saved
    // API session and custom Headers are kept until a newly observed login replaces them.
    await sim.webview.cookies.clear();
    if (openingEpoch !== accountEpoch) return;
    const window = new sim.webview.window({ url: "https://music.163.com/#/login", title: "登录网易云音乐", width: 1040, height: 760, minWidth: 800, minHeight: 600, backgroundColor: "#F9F9FB" });
    loginWindow = window;
    let timer = null, stopped = false, checking = false, attempts = 0, lastCookie = "";
    const stop = () => { stopped = true; clearTimeout(timer); if (loginWindow === window) loginWindow = null; };
    const check = async () => {
        if (stopped || window.closed || checking) return;
        checking = true;
        try {
            const cookies = await sim.webview.cookies.get("https://music.163.com/");
            if (stopped || !cookies.some(cookie => cookie.name === "MUSIC_U" && cookie.value)) return;
            await syncBrowserCookies();
            const cookie = sim.settings.get("sessionCookie", "");
            if (cookie && cookie !== lastCookie) {
                lastCookie = cookie; accountCache.delete("profile");
                const user = await profile();
                if (user && !stopped) {
                    sim.ui.toast(`已登录 ${user.name}`); sendViews({ type: "accountChanged" });
                    stop(); window.close(); return;
                }
            }
        } catch (_) {
            // The site may still be logging in; retry without exposing credentials or interrupting it.
            lastCookie = "";
        } finally {
            checking = false;
            if (!stopped && ++attempts < 400) timer = setTimeout(check, 1800);
        }
    };
    window.onclose = () => { stop(); syncBrowserCookies().then(() => sendViews({ type: "accountChanged" })).catch(() => {}); };
    window.onload = () => { if (!checking) { clearTimeout(timer); check(); } };
    timer = setTimeout(check, 1000);
    } finally {
        cookieSyncPaused = false;
        loginOpening = false;
    }
};
const disconnectAccount = async () => {
    cookieSyncPaused = true; accountEpoch++;
    try {
        if (loginWindow && !loginWindow.closed) loginWindow.close();
        sim.settings.set("sessionCookie", ""); sim.settings.set("sessionEndpoint", "");
        // Only the extension's own browser session is removed. Custom Headers remain byte-for-byte intact.
        if (sim.permissions.has("webview")) {
            const cookies = await sim.webview.cookies.get("https://music.163.com/");
            // CEF's URL-only deletion excludes domain Cookies; naming them removes both kinds.
            await Promise.all([...new Set(cookies.map(cookie => cookie.name))].map(name => sim.webview.cookies.remove("https://music.163.com/", name)));
        }
    } finally { cookieSyncPaused = false; resetAccount(); }
    return { customCookie: /(?:^|&)cookie=/i.test(String(setting("apiHeaders"))) };
};
const songView = song => ({
    id: idValue(song.id), title: String(song.name || "未命名歌曲"),
    artist: (song.ar || song.artists || []).map(item => item.name).join(" / "), album: String((song.al || song.album)?.name || ""),
    cover: imageUrl((song.al || song.album)?.picUrl || song.picUrl, 100), duration: Number(song.dt || song.duration || 0) / 1000,
    unavailable: song.st < 0 || song.noCopyrightRcmd != null
});
const playlistView = item => ({
    id: idValue(item.id), name: String(item.name || "未命名歌单"), cover: imageUrl(item.coverImgUrl || item.picUrl),
    count: Number(item.trackCount || 0), plays: Number(item.playCount || 0), creator: String(item.creator?.nickname || ""),
    owner: String(item.creator?.userId || item.userId || ""), description: String(item.description || ""), subscribed: !!item.subscribed, special: Number(item.specialType || 0), private: Number(item.privacy || 0) === 10
});
const invalidateLibrary = (id, kind = "updated") => {
    if (id) accountCache.delete(`playlist:${id}`);
    accountCache.delete("collectPlaylists");
    [...accountCache.keys()].filter(key => key.startsWith("library:")).forEach(key => accountCache.delete(key));
    invalidatePage("collection");invalidatePage("owned");
    if(id)invalidatePage("playlist",id);
    for(const entry of pageCache.values())if(entry.value.tab==="home"&&(entry.value.playlists||[]).some(item=>item.id===id)){invalidatePage("home");break;}
    sendViews({ type: "libraryChanged", id, kind });
};
const ownedPlaylist = async id => {
    const user = await requireAccount(), entry = await loadPlaylist(id);
    if (entry.playlist.owner !== user.id || entry.playlist.special === 5) throw apiError("只能管理自己创建的普通歌单。", "input");
    return entry;
};
const playlistName = value => {
    const name = String(value || "").trim();
    if (!name || Array.from(name).length > 40) throw apiError("歌单名称应为 1 至 40 个字符。", "input");
    return name;
};
const likedIds = async () => {
    const user = await requireAccount();
    return cacheData("liked", async () => {
        const data = await request("/likelist", { uid: user.id }, { fresh: true });
        if (!Array.isArray(data.ids)) throw apiError("服务没有返回喜欢的歌曲列表。", "response");
        return [...new Set(data.ids.map(idValue))];
    });
};
const playlistPage = async offset => {
    const user = await requireAccount();
    return cacheData(`library:${offset}`, async () => {
        const data = await request("/user/playlist", { uid: user.id, limit: 50, offset }, { fresh: true });
        if (!Array.isArray(data.playlist)) throw apiError("服务没有返回用户歌单。", "response");
        return { items: data.playlist.map(playlistView), more: data.more === true || data.more == null && data.playlist.length === 50, offset: offset + data.playlist.length };
    });
};
const songPage = async (ids, offset) => {
    const pageIds = ids.slice(offset, offset + 50);
    if (!pageIds.length) return { songs: [], ids, total: ids.length, more: false, offset };
    const data = await details(pageIds), songs = new Map(data.songs.map(song => [String(song.id), song]));
    return { songs: pageIds.filter(id => songs.has(id)).map(id => songView(songs.get(id))), ids, total: ids.length, more: offset + 50 < ids.length, offset: offset + 50 };
};
const loadPlaylist = id => cacheData(`playlist:${id}`, async () => {
    const data = await request("/playlist/detail", { id }, { fresh: true });
    if (!data.playlist) throw apiError("歌单不存在或暂时无法访问。", "response");
    const playlist = playlistView(data.playlist);
    const ids = (data.playlist.trackIds || data.playlist.tracks || []).map(song => idValue(song.id));
    return { playlist, ids: [...new Set(ids)] };
});
const dailySongs = async () => {
    await requireAccount();
    const day = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    return cacheData(`daily:${day}`, async () => {
        const data = await request("/recommend/songs", {}, { fresh: true });
        const songs = data.data?.dailySongs || data.recommend;
        if (!Array.isArray(songs)) throw apiError("服务没有返回每日推荐。", "response");
        return songs.map(songView);
    }, 300000);
};
const withWrite = async (key, run) => {
    if (writes.has(key)) throw apiError("操作正在进行，请稍候。", "busy");
    writes.add(key);
    const epoch = accountEpoch;
    try { const result = await run(); if (epoch !== accountEpoch) throw apiError("账号已变化，请刷新确认操作结果。", "stale"); return result; }
    finally { writes.delete(key); }
};
const setLiked = (id, liked) => withWrite(`like:${id}`, async () => {
    await requireAccount();
    await request("/like", { id, like: !!liked }, { write: true });
    const before = accountCache.get("liked")?.value;
    if (before) accountCache.set("liked", { value: liked ? [...new Set([...before, id])] : before.filter(value => value !== id), until: Date.now() + 60000 });
    else accountCache.delete("liked");
    invalidatePage("liked");
    sendViews({ type: "likedChanged", id, liked: !!liked });
    return { id, liked: !!liked };
});
const togglePlaylistSongs = (id, ids) => withWrite(`playlist:${id}`, async () => {
    const target = await ownedPlaylist(id);
    const existing = new Set(target.ids), remove = ids.every(value => existing.has(value));
    const changes = remove ? ids : ids.filter(value => !existing.has(value));
    await request("/playlist/tracks", { op: remove ? "del" : "add", pid: id, tracks: changes.join(",") }, { write: true });
    const local = setting("playlists");
    if (local.some(item => item.id === id)) {
        const changed = new Set(changes);
        sim.settings.set("playlists", local.map(item => item.id === id ? { ...item, ids: remove ? item.ids.filter(value => !changed.has(value)) : [...new Set([...item.ids, ...changes])] } : item));
    }
    invalidateLibrary(id);
    return { name: target.playlist.name, removed: remove };
});
const createPlaylist = (data, selected = []) => withWrite("createPlaylist", async () => {
    const user = await requireAccount(), name = playlistName(data.name);
    const result = await request("/playlist/create", { name, privacy: data.private ? 10 : 0, type: "NORMAL" }, { write: true });
    const id = idValue(result.playlist?.id || result.id);
    invalidateLibrary(id, "created");
    if (selected.length) {
        try { await request("/playlist/tracks", { op: "add", pid: id, tracks: selected.join(",") }, { write: true }); }
        catch (error) { invalidateLibrary(id); throw apiError(`歌单「${name}」已创建，但歌曲加入失败。可在歌单列表重试收藏：${error.message}`, "partial"); }
        invalidateLibrary(id);
    }
    return { id, name, owner: user.id, collected: selected.length };
});
const editPlaylist = data => withWrite(`playlist:${idValue(data.id)}`, async () => {
    const id = idValue(data.id), entry = await ownedPlaylist(id), name = playlistName(data.name ?? entry.playlist.name);
    const description = String(data.description ?? entry.playlist.description);
    if (Array.from(description).length > 1000) throw apiError("歌单简介不能超过 1000 个字符。", "input");
    let changed = false;
    try {
        if (name !== entry.playlist.name) { await request("/playlist/name/update", { id, name }, { write: true }); changed = true; }
        if (description !== entry.playlist.description) await request("/playlist/desc/update", { id, desc: description }, { write: true });
    } catch (error) {
        invalidateLibrary(id);
        if (changed) throw apiError(`歌单名称已保存，但简介保存失败，请刷新后重试：${error.message}`, "partial");
        throw error;
    }
    const local = setting("playlists");
    if (local.some(item => item.id === id)) { sim.settings.set("playlists", local.map(item => item.id === id ? { ...item, name } : item)); sim.sidebar.refresh(); }
    invalidateLibrary(id);
    return { id, name, description };
});
const deletePlaylist = id => withWrite(`playlist:${id}`, async () => {
    await ownedPlaylist(id);
    await request("/playlist/delete", { id }, { write: true });
    const local = setting("playlists");
    if (local.some(item => item.id === id)) { sim.settings.set("playlists", local.filter(item => item.id !== id)); sim.sidebar.refresh(); }
    invalidateLibrary(id, "deleted");
    return { id };
});
const removePlaylistSongs = (id, ids) => withWrite(`playlist:${id}`, async () => {
    const entry = await ownedPlaylist(id);
    if (!ids.length || ids.some(value => !entry.ids.includes(value))) throw apiError("选中的歌曲已不在这个歌单中，请刷新。", "stale");
    await request("/playlist/tracks", { op: "del", pid: id, tracks: ids.join(",") }, { write: true });
    const local = setting("playlists");
    if (local.some(item => item.id === id)) sim.settings.set("playlists", local.map(item => item.id === id ? { ...item, ids: item.ids.filter(value => !ids.includes(value)) } : item));
    invalidateLibrary(id);
    return { id, removed: ids };
});
const collectPlaylists = () => cacheData("collectPlaylists", async () => {
    const user = await requireAccount(), entries = new Map();
    let offset = 0;
    for (;;) {
        const page = await playlistPage(offset);
        page.items.forEach(item => { if (item.owner === user.id && item.special !== 5) entries.set(item.id,item); });
        if (!page.more) break;
        if (page.offset <= offset || page.offset > 100000) throw apiError("歌单分页异常，请稍后重试。","response");
        offset = page.offset;
    }
    return parallel([...entries.values()],async item => item.count === 0 ? { playlist:item, ids:[] } : ownedPlaylist(item.id));
},300000);
const collectSelection = tracks => {
    const ids = [...new Set(tracks.map(track => idValue(track.id)))];
    if (!ids.length || ids.length > 1000) throw apiError("一次请选择 1 至 1000 首歌曲。","input");
    return ids;
};
const collectActions = async tracks => {
    const ids = collectSelection(tracks);
    const [liked, playlists] = await Promise.all([likedIds(),collectPlaylists()]);
    const favorites = new Set(liked), allLiked = ids.every(id => favorites.has(id));
    return [
        { key:"liked",label:allLiked?"移出喜欢":"加入喜欢",icon:allLiked?"EE0F":"EE0D" },
        ...playlists.map(entry => {
            const included = new Set(entry.ids);
            return { key:`playlist-${entry.playlist.id}`,label:entry.playlist.name,icon:ids.every(id => included.has(id))?"EB7B":"" };
        }),
        { key:"new",label:"新建歌单",icon:"EA13" }
    ];
};
const collectOperation = async (ids, work) => {
    sendViews({ type:"songsBusy",ids,busy:true });
    try { return await work(); }
    finally { sendViews({ type:"songsBusy",ids,busy:false }); }
};
const toggleCollectedLikes = ids => withWrite("collectLikes", async () => {
    const epoch = accountEpoch, favorites = new Set(await likedIds()), liked = !ids.every(id => favorites.has(id));
    let completed = 0;
    try {
        for (const id of ids.filter(id => favorites.has(id) !== liked)) {
            if (epoch !== accountEpoch) throw apiError("账号已变化，已停止修改喜欢状态。","stale");
            await setLiked(id,liked);completed++;
        }
    } catch (error) {
        if (completed) throw apiError(`已处理 ${completed} 首歌曲，其余未完成：${error.message}`,"partial");
        throw error;
    }
    sim.ui.toast(liked?"已加入喜欢":"已取消喜欢");
});
const createAndCollect = ids => withWrite("collectNew", async () => {
    await requireAccount();
    const epoch = accountEpoch;
    const name = await sim.dialog.prompt("新建歌单","歌单名称，创建后加入选中的歌曲","");
    if (!name) return;
    if (epoch !== accountEpoch) throw apiError("账号已变化，请重新新建歌单。","stale");
    await collectOperation(ids,()=>createPlaylist({name},ids));
    sim.ui.toast("歌单已创建并收藏");
});
const runCollectionAction = async (key, tracks) => {
    if (key === "collect/login") { await openLogin();return; }
    const ids = collectSelection(tracks);
    if (key === "collect/new") { await createAndCollect(ids);return; }
    await collectOperation(ids,async()=>{
        if (key === "collect/liked") { await toggleCollectedLikes(ids);return; }
        const match = /^collect\/playlist-(\d+)$/.exec(key);
        if (!match) throw apiError("无效的收藏操作。","input");
        const result = await togglePlaylistSongs(idValue(match[1]),ids);
        sim.ui.toast(result.removed?"已从歌单移出":"已加入歌单");
    });
};
const readPageData = async data => {
    const offset = pageValue(data.offset);
    if (data.tab === "home") {
        const result = await Promise.allSettled([
            cacheData("discovery", async () => { const data = await request("/personalized", { limit: 10 }); if (!Array.isArray(data.result)) throw apiError("服务没有返回推荐歌单。", "response"); return data.result.map(playlistView); }, 300000),
            cacheData("newSongs", async () => { const data = await request("/personalized/newsong", { limit: 6 }); if (!Array.isArray(data.result)) throw apiError("服务没有返回推荐歌曲。", "response"); return data.result.map(item => songView(item.song || item)); }, 300000)
        ]);
        return { tab: "home", playlists: result[0].status === "fulfilled" ? result[0].value : [], songs: result[1].status === "fulfilled" ? result[1].value : [], errors: result.flatMap((item, index) => item.status === "rejected" ? [{ section: index ? "新歌" : "推荐歌单", message: item.reason.message, kind: item.reason.kind || "request" }] : []) };
    }
    if (data.tab === "daily") { const songs = await dailySongs(); return { tab: "daily", songs, ids:songs.map(song=>song.id), total: songs.length, more: false }; }
    if (data.tab === "liked") return { tab: "liked", ...await songPage(await likedIds(), offset) };
    if (data.tab === "collection" || data.tab === "owned") {
        const user = await requireAccount(), page = await playlistPage(offset);
        return { tab: data.tab, ...page, items: page.items.filter(item => data.tab === "owned" ? item.owner === user.id && item.special !== 5 : item.owner !== user.id) };
    }
    if (data.tab === "playlist") {
        const entry = await loadPlaylist(idValue(data.id));
        return { tab: "playlist", playlist: entry.playlist, ...await songPage(entry.ids, offset) };
    }
    throw apiError("未知页面。", "input");
};
// These are bounded, account-scoped page responses, not another song metadata index.
// A stale page can render immediately while a single shared read refreshes it.
const pageData = async data => {
    const root = pageRoot(data), offset = pageValue(data.offset), key = `${root}:${offset}`;
    if(data.refresh)freshPage(data);
    const now = Date.now(), cached = pageCache.get(key);
    if(cached&&cached.until>now&&!data.refresh){pageCache.delete(key);pageCache.set(key,cached);return {...cached.value,cacheUntil:cached.until};}
    const background = !!cached&&!data.refresh&&cached.keepUntil>now;
    let pending = pageReads.get(key);
    if(!pending){
        const epoch=accountEpoch,cacheEpoch=pageCacheEpoch,version=pageVersions.get(root)||0;
        pending={root};
        pending.promise=readPageData({...data,offset}).then(value=>{
            if(epoch!==accountEpoch||cacheEpoch!==pageCacheEpoch)throw apiError("账号或接口已变化，请重新加载。","stale");
            let ttl=data.tab==="home"||data.tab==="daily"?300000:60000;
            if(value.errors?.length)ttl=15000;
            const midnight=Math.floor((Date.now()+8*3600000)/86400000)*86400000+86400000-8*3600000;
            const until=Math.min(Date.now()+ttl,data.tab==="daily"?midnight:Infinity);
            const result={...value,cacheUntil:until};
            if(version===(pageVersions.get(root)||0)){
                if(pageCache.size>=80)pageCache.delete(pageCache.keys().next().value);
                pageCache.set(key,{root,value,until,keepUntil:Math.min(until+1800000,data.tab==="daily"?midnight:Infinity)});
                if(background)sendViews({type:"pageUpdated",root,offset,value:result});
            }
            return result;
        }).finally(()=>{if(pageReads.get(key)===pending)pageReads.delete(key);});
        pageReads.set(key,pending);
    }
    if(background){pending.promise.catch(()=>{});return {...cached.value,cacheUntil:cached.until};}
    return pending.promise;
};
const contextIds = async data => {
    let ids;
    if (data.tab === "playlist") ids = (await loadPlaylist(idValue(data.id))).ids;
    else if (data.tab === "liked") ids = await likedIds();
    else if (data.tab === "daily") ids = (await dailySongs()).map(song => song.id);
    else if (Array.isArray(data.ids) && data.ids.length <= 1000) ids = data.ids.map(idValue);
    else throw apiError("没有可播放的歌曲。", "input");
    return ids;
};
const playItems = async data => {
    if (!sim.permissions.has("player")) throw apiError("请在扩展权限中允许播放控制。", "permission");
    const ids = await contextIds(data);
    if (!ids.length) throw apiError("这里还没有歌曲。", "input");
    const index = data.song ? ids.indexOf(idValue(data.song)) : 0;
    if (index < 0) throw apiError("歌曲已不在当前列表中，请刷新。", "stale");
    if (data.mode === "next") await sim.player.playNext(ids.map(ref));
    else if (data.mode === "append") await sim.player.append(ids.map(ref));
    else await sim.player.setQueue(ids.map(ref), { index, play: true });
    return { count: ids.length, id: ids[index] };
};
const createView = tab => {
    if (!sim.permissions.has("webview")) throw apiError("请在扩展权限中允许网页视图。", "permission");
    const view = new sim.webview.panel({ url: "ext://page/index.html", backgroundColor: "#FCFCFC" });
    views.add(view);
    const requests = new Set();
    view.onclose = () => views.delete(view);
    view.onmessage = event => {
        // The local HTTP server canonicalizes index.html to the containing directory.
        if (event.origin !== "ext://" || !/^ext:\/\/page\/(?:index\.html)?(?:\?|$)/.test(String(event.url))) return;
        const data = event.data || {}, token = data.request;
        if (!Number.isSafeInteger(token) || token < 1 || typeof data.client !== "string" || !/^[a-z0-9]{1,40}$/.test(data.client)) return;
        const key = `${data.client}:${token}`;
        if (requests.has(key)) return;
        requests.add(key);
        if (requests.size > 1024) requests.delete(requests.values().next().value);
        const run = async () => {
            if (data.action === "toast") { sim.ui.toast(String(data.text||"")); return true; }
            if (data.action === "dialogForm") {
                if (typeof sim.dialog.form!=="function") throw apiError("当前界面无法打开多字段表单。", "dialog");
                return sim.dialog.form(data.form);
            }
            if (data.action === "dialogPrompt") return (await sim.dialog.prompt(String(data.title||"").slice(0,512),String(data.placeholder||"").slice(0,1024),String(data.value||"").slice(0,16384))) || null;
            if (data.action === "dialogConfirm") return sim.dialog.confirm(String(data.text||"").slice(0,8192));
            if (data.action === "ready") {
                if (data.refresh) accountCache.delete("profile");
                await syncBrowserCookies();
                let user = null, accountError = null;
                try { user = await profile(!data.refresh); } catch (error) { accountError = { message: error.message, kind: error.kind || "request" }; }
                const state = sim.permissions.has("player") ? sim.player.state : {};
                return { tab, user, endpoint: endpointValue(), accountError, canForm: typeof sim.dialog.form === "function", canPlay: sim.permissions.has("player"), canWrite: sim.permissions.has("network"), current: state.current || null, playing: !!state.playing, loading: !!state.loading };
            }
            if (data.action === "load") return pageData(data);
            if (data.action === "playlistAuthors") {
                const ids=Array.isArray(data.ids)?[...new Set(data.ids.slice(0,20).map(idValue))]:[];
                const authors=await parallel(ids,async id=>({id,creator:await cacheData(`author:${id}`,async()=>(await loadPlaylist(id)).playlist.creator,300000).catch(()=>"")}));
                const names=new Map(authors.map(item=>[item.id,item.creator]));
                for(const item of accountCache.get("discovery")?.value||[])if(names.has(item.id))item.creator=names.get(item.id);
                for(const entry of pageCache.values())if(entry.value.tab==="home")for(const item of entry.value.playlists||[])if(names.has(item.id))item.creator=names.get(item.id);
                return authors;
            }
            if (data.action === "likes") { try { return await likedIds(); } catch (_) { return []; } }
            if (data.action === "play") return playItems(data);
            if (data.action === "songMenu") {
                // The page already received the full IDs while loading its list. Opening a menu
                // must not refresh an expired playlist cache or wait for a network request.
                const ids = Array.isArray(data.ids) && data.ids.length<=50000 ? data.ids.map(idValue) : await contextIds(data);
                const selection = Array.isArray(data.selected) ? data.selected.map(idValue) : [];
                if (!selection.length || selection.some(id => !ids.includes(id))) throw apiError("无效的歌曲选择。", "input");
                if (typeof sim.player.showTrackMenu !== "function") throw apiError("请更新主程序以使用歌曲列表菜单。", "unsupported");
                await sim.player.showTrackMenu(ids.map(ref), selection.map(ref)); return true;
            }
            if (data.action === "createPlaylist") return createPlaylist(data);
            if (data.action === "editPlaylist") return editPlaylist(data);
            if (data.action === "deletePlaylist") return deletePlaylist(idValue(data.id));
            if (data.action === "removeSongs") return removePlaylistSongs(idValue(data.id), Array.isArray(data.ids) ? data.ids.map(idValue) : []);
            if (data.action === "like") return setLiked(idValue(data.id), !!data.liked);
            if (data.action === "subscribe") return withWrite(`subscribe:${idValue(data.id)}`, async () => {
                await requireAccount();
                // Enhanced API uses t === 1 to include the subscribe checkToken. JSON preserves
                // its numeric type; URL/form parameters turn it into "1" and skip that branch.
                // Login comes from music.163.com: use the API's web channel, preserving
                // CSRF and the server's anti-cheat token instead of its app default.
                await request("/playlist/subscribe", { id: idValue(data.id), t: data.subscribed ? 1 : 2, crypto: "weapi", e_r: "false" }, { json: true });
                accountCache.delete(`playlist:${data.id}`);
                [...accountCache.keys()].filter(key => key.startsWith("library:")).forEach(key => accountCache.delete(key));
                invalidatePage("collection");invalidatePage("playlist",data.id);
                sendViews({type:"libraryChanged",id:data.id,kind:"subscribed"});
                return true;
            });
            if (data.action === "login") { await openLogin(); return true; }
            if (data.action === "disconnect") return disconnectAccount();
            if (data.action === "connect") {
                const endpoint = String(data.endpoint || "").trim().replace(/\/+$/, "");
                if (!/^https?:\/\/[^\s?#@]+$/.test(endpoint)) throw apiError("请输入有效的 HTTP 或 HTTPS API 地址。", "input");
                sim.settings.set("apiEndpoint", endpoint); resetAccount(); sim.ui.invalidateMusic(); return true;
            }
            throw apiError("不支持的操作。", "input");
        };
        run().then(result => { if (!view.closed) view.postMessage({ reply: token, result }); }).catch(error => { if (!view.closed) view.postMessage({ reply: token, error: { message: error.message || "操作失败，请重试。", kind: error.kind || "request" } }); });
    };
    return view;
};
module.exports = {
    init: () => {
        const notify = state => sendViews({ type: "player", current: state.current, playing: state.playing, loading: state.loading });
        if (sim.permissions.has("player")) sim.player.on("track", notify).on("status", notify);
    },
    getSettings: () => [
        { key: "apiEndpoint", label: "API 地址", type: "text", default: "", desc: "必填，无需最后的斜线（示例： https://api.example.com）。" },
        { key: "apiHeaders", label: "要发送给 API 的 Header 信息", type: "text", default: "", desc: "选填，支持多个（格式：a=b&c=d，需要 URL 转义）。" },
        { key: "songApiEndpoint", label: "歌曲解析 API 地址", type: "text", default: "", desc: "留空时使用上方 API 地址。" },
        { key: "songApiHeaders", label: "要发送给歌曲解析 API 的 Header 信息", type: "text", default: "", desc: "留空时使用上方 Header；支持多个（格式：a=b&c=d，需要 URL 转义）。" },
        { key: "accountLogin", label: "网易云账号", type: "button", button: "登录账号" },
        { key: "searchLimit", label: "搜索时每页歌曲数量", type: "slider", min: 1, max: 100, default: 30, desc: "必填，默认为 30，推荐不超过 50，不能超过 100。" },
        { key: "filterInvalid", label: "过滤无效歌曲", type: "toggle", default: true, desc: "开启后搜索结果中将过滤您无法播放的歌曲。" },
        { key: "autoUnblock", label: "启用自动解灰", type: "toggle", default: false, badge: "Enhanced API", desc: "自动解析无权播放的歌曲（仅支持标准音质），但需要 Enhanced 版本的 API；建议在开启时关闭“过滤无效歌曲”一项。" },
        { key: "musicQuality", label: "播放音质", type: "select", default: "standard", options: qualities, desc: "选择在线播放时的音质，若歌曲无此音质或您无相应权限，会自动降级，建议在切换后清除缓存。" },
        { key: "downloadQuality", label: "下载音质", type: "select", default: "standard", options: qualities, desc: "选择下载时的音质，若歌曲无此音质或您无相应权限，会自动降级。" },
        { key: "lyricType", label: "歌词类型", type: "select", default: "yrc", options: lyricTypes },
        { key: "formatLrc", label: "自动格式化歌词", type: "toggle", default: true, desc: "开启后将会自动在网易云歌曲歌词中的无尾随空格英文标点后添加空格，增加 UI 美观度。" },
        { key: "maxParallelCount", label: "歌单信息最大并行请求数量", type: "slider", min: 1, max: 16, default: 8, desc: "必填，默认为 8，推荐不超过 16。" },
        { key: "importPlaylist", label: "导入歌单", type: "button", button: "导入" }
    ],
    // The sidebar section is entirely the extension's: its title, entries, clicks and context menus.
    // A playlist with a remark is titled by it in the sidebar and on its page; the line under the
    // title then gives the original name, followed in either case by the playlist ID.
    getSidebar: () => ({ title: "网易云", canAdd: true, items: [...fixedTabs.map(item => ({ id: `ncm:${item.id}`, name: item.name })), ...setting("playlists").map(item => ({ id: item.id, name: item.remark || item.name }))] }),
    onSidebarAdd: async () => { const entry = await promptPlaylist(); if (entry) sim.sidebar.open(entry.id); },
    onSidebarOpen: async id => {
        if (fixedTabs.some(item => id === `ncm:${item.id}`)) { createView(id.slice(4)); return; }
        const entry = setting("playlists").find(item => item.id === id);
        if (!entry) throw new Error("歌单已被移除。");
        return { title: entry.remark || entry.name, details: [...(entry.remark ? [{ icon: "F011", text: entry.name }] : []), { icon: "EDFC", text: entry.id }], tracks: entry.ids.map(ref) };
    },
    getSidebarMenu: id => {
        if (id.startsWith("ncm:")) return [{ key: "refresh", label: "刷新", icon: "F064" }, { key: "login", label: "登录账号", icon: "F256" }];
        const entries = setting("playlists");
        const index = entries.findIndex(item => item.id === id);
        const items = [];
        if (index > 0) items.push({ key: "up", label: "上移", icon: "EA78" });
        if (index >= 0 && index < entries.length - 1) items.push({ key: "down", label: "下移", icon: "EA4E" });
        items.push({ key: "remark", label: "设置备注", icon: "EC86" });
        if (entries[index]?.remark) items.push({ key: "clearRemark", label: "清除备注", icon: "EC86" });
        items.push({ key: "reimport", label: "重新导入歌单", icon: "F064" });
        if (sim.permissions.has("shell")) items.push({ key: "openWeb", label: "在浏览器中查看", icon: "EDCF" });
        if (sim.permissions.has("clipboard.write")) items.push({ key: "copyId", label: "复制歌单 ID", icon: "ECD5" });
        items.push({ separator: true }, { key: "remove", label: "移除歌单", icon: "ED74" });
        return items;
    },
    onSidebarMenu: async (id, key) => {
        if (id.startsWith("ncm:")) { if (key === "refresh") { accountCache.clear(); sim.sidebar.open(id); } if (key === "login") await openLogin(); return; }
        const entries = [...setting("playlists")];
        const index = entries.findIndex(item => item.id === id);
        if (index < 0) return;
        if (key === "reimport") { await importPlaylist(id); sim.sidebar.open(id); }
        if (key === "remark" || key === "clearRemark") {
            const remark = key === "remark" ? String(await sim.dialog.prompt("设置备注", entries[index].name, entries[index].remark || "") || "").trim() : "";
            if (key === "remark" && !remark) return;
            if (remark) entries[index].remark = remark; else delete entries[index].remark;
            sim.settings.set("playlists", entries);
            sim.sidebar.refresh();
            sim.sidebar.open(id);
        }
        if (key === "openWeb") sim.shell.openPath(`https://music.163.com/#/playlist?id=${id}`);
        if (key === "copyId") { sim.clipboard.writeText(id); sim.ui.toast("已复制歌单 ID"); }
        if (key === "up" || key === "down") {
            const target = index + (key === "up" ? -1 : 1);
            if (target < 0 || target >= entries.length) return;
            entries.splice(target, 0, entries.splice(index, 1)[0]);
            sim.settings.set("playlists", entries);
            sim.sidebar.refresh();
        }
        if (key === "remove") {
            if (!await sim.dialog.confirm(`歌单「${entries[index].name}」将从侧栏移除，网易云账号中的歌单不受影响。是否继续？`)) return;
            sim.settings.set("playlists", setting("playlists").filter(item => item.id !== id));
            sim.sidebar.refresh();
        }
    },
    onAction: key => { if (key === "importPlaylist") return promptPlaylist(); if (key === "accountLogin") return openLogin(); },
    // Receives the raw text and the host's word segments; the search API does its own matching, so the text goes as typed.
    search: async keyword => {
        const data = await request("/search", { keywords: keyword, type: 1, limit: numberSetting("searchLimit", 1, 100), offset: 0 });
        const ids = (data.result?.songs || []).map(song => String(song.id));
        if (!setting("filterInvalid") || !ids.length) return ids.map(ref);
        return validSongs(ids, (await details(ids)).privileges).map(ref);
    },
    getMusicInfo: async (ids, scene) => {
        ids = ids.map(String);
        const data = await details(ids);
        const info = new Map(data.songs.map(song => [String(song.id), { id: String(song.id), title: song.name, artist: (song.ar || song.artists || []).map(item => item.name).join(", "), album: (song.al || song.album)?.name || "", duration: Number(song.dt || song.duration || 0) / 1000, cover: cover((song.al || song.album)?.picUrl, 120), ...(scene === "list" ? {} : { largeCover: cover((song.al || song.album)?.picUrl, 800) }) }]));
        if (scene !== "list") {
            // Playback and download each use their own quality setting; one request serves both when they match.
            const playQuality = setting("musicQuality"), downloadQuality = setting("downloadQuality");
            const [resources, texts] = await Promise.all([urls(ids, playQuality), parallel(ids, id => lyrics(id).catch(() => ""))]);
            const downloads = scene === "download" ? downloadQuality === playQuality ? resources : await urls(ids, downloadQuality) : [];
            resources.forEach((item, index) => {
                const track = info.get(item.id);
                if (!track) throw new Error(`API 未返回曲目 ${item.id} 的信息。`);
                Object.assign(track, { playback: item.resource, lyrics: texts[index], ext: item.ext, ...(scene === "download" ? { download: downloads[index].resource, ext: downloads[index].ext } : {}) });
            });
        }
        return ids.map(id => { const track = info.get(id); if (!track) throw new Error(`找不到曲目 ${id}。`); return track; });
    },
    getTrackActions: async (tracks, scene, parent) => {
        if (parent === "quality") return qualities.map(item => ({ key: item.value, label: item.label, icon: setting("musicQuality") === item.value ? "EB7B" : "" }));
        if (parent !== "collect" || !tracks[0]) return [];
        let timer;
        try {
            // Finish before the host's menu deadline; a slow API must not stop the extension.
            return await Promise.race([collectActions(tracks),new Promise((_,reject)=>{timer=setTimeout(()=>reject(apiError("收藏菜单加载超时，请重试。","timeout")),8000);})]);
        } catch (error) { if (error.kind !== "auth") throw error; return [{key:"login",label:"登录网易云账号",icon:"F264"}]; }
        finally { clearTimeout(timer); }
    },
    onTrackAction: async (key, tracks) => {
        if (key.startsWith("collect/")) {
            // Prompts and a large selection may outlive a menu callback. Keep the workflow
            // in this extension rather than holding the host's action call open.
            runCollectionAction(key,tracks).catch(error=>{
                if(error.kind==="auth")openLogin().catch(error=>sim.ui.alert(error.message));
                else sim.ui.alert(error.message||"收藏操作失败。");
            });
            return;
        }
        if (key.startsWith("quality/")) {
            const quality = key.slice(8);
            if (!qualities.some(item => item.value === quality)) return;
            // The song that is playing keeps its stream; cached addresses of the old quality are dropped.
            sim.settings.set("musicQuality", quality);
            sim.index.clear(["playback"]);
            sim.ui.toast("切换歌曲后生效");
            return;
        }
        if (!tracks[0]) return;
        if (key === "copyId") sim.clipboard.writeText(songID(tracks[0].id));
        if (key === "openWeb") sim.shell.openPath(`https://music.163.com/#/song?id=${songID(tracks[0].id)}`);
    },
    onSettingChange: key => {
        // Only what the setting made stale is dropped from the host's index; everything else stays cached.
        if (["apiEndpoint", "apiHeaders"].includes(key)) sim.ui.invalidateMusic();
        if (["songApiEndpoint", "songApiHeaders"].includes(key)) sim.ui.invalidateMusic();
        if (["songApiEndpoint", "songApiHeaders"].includes(key)) {clearPageCache();sendViews({type:"pagesInvalidated"});}
        if (["apiEndpoint", "apiHeaders"].includes(key)) { if (loginWindow && !loginWindow.closed) loginWindow.close(); resetAccount(); }
        if (key === "musicQuality") sim.index.clear(["playback"]);
        if (key === "downloadQuality") sim.index.clear(["download", "ext"]);
        if (key === "lyricType" || key === "formatLrc") sim.index.clear(["lyrics"]);
        if (sim.permissions.has("sidebar")) sim.ui.refresh();
    }
};
