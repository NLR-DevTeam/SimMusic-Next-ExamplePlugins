// 一起听的网页版：在浏览器里提供 SimMusic 播放页所用的 simPlayer，背后是中继上的共享状态与一个音频元素。
// 与扩展里的规则相同：只有用户的操作才同步，一次同步交出整个状态、别人整个照着对齐；自然放完切歌不上报；
// 每打开完一首歌向创建者单向对齐一次进度。
// 音量只是本机的。浏览器不能自带请求头，歌曲的音频、封面都经中继取得。
(() => {
    const base = location.pathname.replace(/\/s\/[^/]+\/?$/, "");
    const shareId = (location.pathname.match(/\/s\/([^/]+)/) || [])[1] || "";
    const api = `${location.origin}${base}/api/s/${shareId}`;
    const clientId = "w" + Math.random().toString(36).slice(2, 12);
    const audio = new Audio();
    audio.preload = "auto";
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    let password = "";
    let seq = -1, version = 0, offset = 0, syncUntil = 0;
    // 本机此刻的共享状态：别人的操作照 actions 改它，本机的操作改了它再交出去。
    let shared = null;
    let loadedKey = "", startAt = 0, lyricsKey = "", calibrating = false, asked = null;

    const query = params => new URLSearchParams({ ...params, ...(password ? { p: password } : {}) }).toString();
    // 没有封面的歌由中继给出占位图。
    const coverURL = (key, size) => `${api}/cover?${query({ key, size, fallback: 1 })}`;
    const request = async (method, path, body) => {
        const response = await fetch(api + path, {
            method, cache: "no-store",
            headers: { "Content-Type": "application/json", ...(password ? { "X-Sync-Password": password } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (!response.ok) throw Object.assign(new Error("HTTP " + response.status), { status: response.status });
        return response.json();
    };

    // ---------- simPlayer：与 SimMusic 播放页里的同一套接口 ----------

    const state = {
        current: null, index: -1, queue: [], lyrics: { traditional: [], perWord: null },
        playing: false, loading: false, position: 0, duration: 0, volume: 1, speed: 1, mode: 0,
        sleep: { active: false, until: 0, waitTrackEnd: false }, settings: {}, visible: true, side: "lyrics",
        windowMaximized: false, fullscreen: false
    };
    const listeners = {};
    const emit = (type, value = state) => (listeners[type] || []).slice().forEach(handler => { try { handler(value); } catch (error) { console.error(error); } });
    const announce = changed => {
        changed.forEach(group => emit(group));
        emit("position");
        emit("change", { state, changed });
    };

    const currentEntry = () => shared && shared.queue[shared.index];
    const expectedPosition = remote => remote.playing && !remote.loading ? remote.position + Math.max(0, Date.now() + offset - remote.at) / 1000 * (remote.speed || 1) : remote.position;

    // 本机的操作：先在本机生效，再交给所有人。
    const publish = async (changes, actions) => {
        if (!shared) return;
        shared = { ...shared, position: audio.currentTime || 0, loading: state.loading, ...changes, at: Date.now() + offset, actions };
        show(actions.includes("track") || actions.includes("seek") ? shared.position : null);
        try {
            const result = await request("POST", `/state?client=${clientId}`, shared);
            version = Math.max(version, result.version);
        } catch {}
    };
    const move = step => shared && shared.queue.length && publish({ index: (shared.index + step + shared.queue.length) % shared.queue.length, position: 0, playing: true }, ["track"]);
    const done = value => Promise.resolve(value);

    window.simPlayer = {
        state,
        ready: Promise.resolve(state),
        on: (type, handler) => { (listeners[type] ||= []).push(handler); return window.simPlayer; },
        off: (type, handler) => { listeners[type] = (listeners[type] || []).filter(item => item !== handler); return window.simPlayer; },
        position: () => audio.currentTime || state.position,
        toggle: () => done(shared && publish({ playing: !shared.playing }, ["toggle"])),
        play: () => done(shared && !shared.playing && publish({ playing: true }, ["toggle"])),
        pause: () => done(shared && shared.playing && publish({ playing: false }, ["toggle"])),
        previous: () => done(move(-1)),
        next: () => done(move(1)),
        seek: seconds => done(shared && publish({ position: Math.max(0, Number(seconds) || 0) }, ["seek"])),
        // 一起听不使用随机播放：列表循环与单曲循环之间切换。
        cycleMode: () => done(shared && publish({ mode: shared.mode === 1 ? 0 : 1 }, ["mode"])),
        setMode: mode => done(shared && publish({ mode: mode === 1 ? 1 : 0 }, ["mode"])),
        setSpeed: speed => done(shared && publish({ speed: Math.max(.1, Math.min(10, Number(speed) || 1)) }, ["speed"])),
        playIndex: index => done(shared && shared.queue[index] && publish({ index, position: 0, playing: true }, ["track"])),
        removeFromQueue: index => {
            if (!shared || !shared.queue[index]) return done(false);
            const queue = shared.queue.filter((_, i) => i !== index);
            if (index !== shared.index) return done(publish({ queue, index: shared.index - (index < shared.index ? 1 : 0) }, ["queue"]));
            return done(publish({ queue, index: Math.min(index, queue.length - 1), position: 0 }, ["queue", "track"]));
        },
        moveInQueue: (from, to) => {
            if (!shared || !shared.queue[from] || !shared.queue[to]) return done(false);
            const queue = shared.queue.slice(), key = currentEntry() && currentEntry().key;
            queue.splice(to, 0, queue.splice(from, 1)[0]);
            return done(publish({ queue, index: queue.findIndex(entry => entry.key === key) }, ["queue"]));
        },
        setVolume: volume => { audio.volume = Math.max(0, Math.min(1, Number(volume) || 0)); state.volume = audio.volume; announce(["status"]); return done(true); },
        setSleep: () => done(false), cancelSleep: () => done(false),
        loadInfo: () => done(true),
        spectrum: bands => done(new Array(bands || 64).fill(0)),
        close: () => done(false), showMenu: () => done(false), showDialog: () => done(false), showWindow: () => done(false),
        setTitleBar: () => done(false), setLyricsShown: () => done(true), window: () => done(false), setFullscreen: () => done(false), toggleFullscreen: () => done(false),
        postMessage: () => {}, shortcuts: false
    };

    // ---------- 共享状态 → 播放器 ----------

    const trackOf = entry => ({
        source: "musicsync", id: entry.key, title: entry.title || "未知歌曲", artist: entry.artist || "", album: entry.album || "", duration: entry.duration || 0,
        infoReady: true, infoRevision: 0, cover: coverURL(entry.key, "small"), largeCover: coverURL(entry.key, "large")
    });

    const parseLrc = text => {
        const lines = [];
        for (const raw of String(text || "").split(/\r?\n/)) {
            const match = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(raw.trim());
            if (!match) continue;
            const time = Number(match[1]) * 60 + Number(match[2]), content = match[3].trim();
            const previous = lines[lines.length - 1];
            // 同一时间的第二行是翻译。
            if (previous && Math.abs(previous.time - time) < .01) previous.translation = content;
            else if (content) lines.push({ time, text: content, translation: "" });
        }
        return lines;
    };
    // 歌词由正在播放这首歌的 SimMusic 成员交给中继；还没有时过一会儿再问。
    const loadLyrics = async key => {
        lyricsKey = key;
        state.lyrics = { traditional: [], perWord: null };
        announce(["lyrics"]);
        for (let attempt = 0; attempt < 12 && lyricsKey === key; attempt++) {
            try {
                const result = await request("GET", `/lyrics?${query({ key })}`);
                if (lyricsKey !== key) return;
                if (result.lrc) {
                    state.lyrics = { traditional: parseLrc(result.lrc), perWord: null };
                    announce(["lyrics"]);
                    return;
                }
            } catch {}
            await sleep(5000);
        }
    };

    const seekTo = position => {
        audio.currentTime = Math.max(0, position);
    };
    const playOrPause = () => {
        if (shared && shared.playing && currentEntry() && !calibrating) audio.play().then(() => { resumeLayer.hidden = true; }).catch(() => { resumeLayer.hidden = false; });
        else audio.pause();
    };

    // 让播放器显示并播放 shared；position 不为 null 时跳到那里（换了歌就从那里打开）。
    const show = position => {
        const entry = currentEntry();
        const changed = ["queue", "status"];
        state.queue = shared ? shared.queue.map(trackOf) : [];
        state.index = entry ? shared.index : -1;
        state.mode = shared ? shared.mode || 0 : 0;
        state.speed = shared ? shared.speed || 1 : 1;
        state.playing = !!(shared && shared.playing);
        audio.defaultPlaybackRate = audio.playbackRate = state.speed;
        const key = entry ? entry.key : "";
        if (key !== loadedKey) {
            loadedKey = key;
            state.current = entry ? state.queue[shared.index] : null;
            state.duration = entry ? entry.duration || 0 : 0;
            state.position = 0;
            changed.unshift("track");
            if (entry) {
                startAt = position || 0;
                calibrating = true;
                // 进度在音频打开的同时就去问，打开完时多半已经有了答案。
                asked = { key, answer: request("GET", "/position").catch(() => null) };
                audio.src = `${api}/audio?${query({ key })}`;
                audio.playbackRate = state.speed;
                state.loading = true;
                loadLyrics(key);
            } else {
                audio.removeAttribute("src");
                audio.load();
                state.lyrics = { traditional: [], perWord: null };
                changed.push("lyrics");
            }
        } else {
            if (entry) state.current = state.queue[shared.index];
            if (entry && position !== null && position !== undefined) {
                if (audio.readyState < 1) startAt = position;
                else if (Math.abs(audio.currentTime - position) > .5) seekTo(position);
            }
        }
        document.title = entry ? `${entry.title || "未知歌曲"} - 一起听` : "一起听";
        announce(changed);
        playOrPause();
    };

    // 别人的操作：整个状态照着对齐。创建者为新成员补发的状态只给刚加入的成员。
    const receive = (wrapped, fresh) => {
        if (wrapped.version <= version) return;
        version = wrapped.version;
        if (wrapped.by === clientId && !fresh) return;
        const remote = wrapped.state;
        if (fresh) syncUntil = Date.now() + 5000;
        else if ((remote.actions || []).includes("sync")) {
            if (Date.now() > syncUntil) return;
            syncUntil = 0;
        }
        shared = { ...remote };
        show(expectedPosition(remote));
    };

    // 每打开完一首歌，向创建者要一次它此刻的进度，单向对齐；对齐之前不出声。问不到时用别人提交时的位置推算。
    const calibrate = async key => {
        try {
            let result = asked && asked.key === key ? await asked.answer : null;
            // 先问时创建者还没换到这首（例如是本机切的歌）：现在再问一次。
            if (!result || result.key !== key) result = await request("GET", "/position");
            if (key === loadedKey && result.key === key) startAt = result.position + (result.playing ? Math.max(0, Date.now() + offset - result.at) / 1000 * (result.speed || 1) : 0);
        } catch {}
        if (key !== loadedKey) return;
        if (Math.abs(audio.currentTime - startAt) > .5) seekTo(startAt);
        startAt = 0;
        calibrating = false;
        playOrPause();
    };
    audio.addEventListener("loadedmetadata", () => {
        if (isFinite(audio.duration)) state.duration = audio.duration;
        announce(["status"]);
        calibrate(loadedKey);
    });
    // 有的浏览器在打开、开始播放时把播放速度改回默认：每次都改回分享的倍速。
    const keepRate = () => { if (Math.abs(audio.playbackRate - state.speed) > .001) audio.defaultPlaybackRate = audio.playbackRate = state.speed; };
    ["loadedmetadata", "canplay", "playing", "ratechange"].forEach(type => audio.addEventListener(type, keepRate));
    const setLoading = loading => { if (state.loading !== loading) { state.loading = loading; announce(["status"]); } };
    audio.addEventListener("canplay", () => setLoading(false));
    audio.addEventListener("playing", () => setLoading(false));
    audio.addEventListener("waiting", () => setLoading(true));
    // 放完了：自己切到下一首（单曲循环时从头再来），不交给别人。
    audio.addEventListener("ended", () => {
        if (!shared || !shared.queue.length) return;
        if (shared.mode === 1) { seekTo(0); audio.play().catch(() => {}); return; }
        shared = { ...shared, index: (shared.index + 1) % shared.queue.length };
        show(0);
    });
    setInterval(() => {
        if (!shared) return;
        state.position = audio.currentTime || 0;
        emit("position");
    }, 250);

    // ---------- 加入 ----------

    const showMembers = count => { membersText.textContent = `${count} 人在听`; };

    const loop = async () => {
        let failures = 0;
        for (;;) {
            try {
                const result = await request("GET", `/poll?${query({ client: clientId, since: seq, web: 1 })}`);
                failures = 0;
                offset = result.now - Date.now();
                showMembers(result.members);
                if (result.state) receive(result.state, true);
                for (const event of result.events) if (event.type === "state") receive(event.data, false);
                seq = result.seq;
            } catch (error) {
                if (error.status === 404 || error.status === 401) {
                    audio.pause();
                    return showGate(error.status === 404 ? "分享已结束" : "密码错误", error.status === 401 ? "password" : "");
                }
                failures++;
                await sleep(Math.min(10000, 1000 * failures));
            }
        }
    };

    // mode：“password”要输入密码，“join”只需点加入，空则无法加入。
    const showGate = (text, mode) => {
        gate.hidden = false;
        gateText.textContent = text;
        passwordBox.hidden = mode !== "password";
        joinButton.hidden = !mode;
        if (mode === "password") passwordInput.focus();
    };

    const join = async () => {
        password = passwordInput.value;
        joinButton.disabled = true;
        try {
            await request("GET", `/poll?${query({ client: clientId, since: -1, web: 1 })}`);
        } catch (error) {
            joinButton.disabled = false;
            if (error.status === 401) return showGate("密码不正确，请重新输入", "password");
            return showGate(error.status === 404 ? "分享已结束" : "无法连接服务器", "");
        }
        joinButton.disabled = false;
        gate.hidden = true;
        // 在这次点击里先让音频元素获准播放。
        audio.play().catch(() => {});
        emit("view");
        loop();
    };

    const open = async () => {
        try {
            const response = await fetch(api, { cache: "no-store" });
            if (response.status === 404) return showGate("分享已结束", "");
            const info = await response.json();
            showGate(info.password ? "这个分享需要密码" : "有人邀请你一起听歌", info.password ? "password" : "join");
        } catch {
            showGate("无法连接服务器", "");
        }
    };

    addEventListener("DOMContentLoaded", () => {
        joinButton.onclick = join;
        passwordInput.onkeydown = event => { if (event.key === "Enter") join(); };
        resumeButton.onclick = () => { resumeLayer.hidden = true; playOrPause(); };
        open();
    });
})();
