// 歌词转盘：一张大唱片从左边缘露出大半，外圈是随声音跳动的频谱；歌词沿着与唱片同心的圆弧排列，一屏五行，
// 像拨轮一样上下转动，正在唱的一句在正右方。
// 页面只通过宿主的 simPlayer 读取状态、控制播放；歌词由宿主解析，这里只用每一行（和逐字片段）的时间。
const state = simPlayer.state;
const escapeText = value => su5.utils.formatText(value ?? "");
const glyph = code => String.fromCodePoint(parseInt(code, 16));
const placeholder = "/.sim/assets/placeholder.png";
const formatTime = seconds => {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
const artistOf = track => track && track.artist && track.artist !== "未知艺术家" ? track.artist : "";

// ---------- 颜色：取封面的主色，展开成底色、圆心处的亮色和文字色 ----------
const coverColor = image => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, 48, 48);
    const pixels = context.getImageData(0, 0, 48, 48).data;
    // 越鲜艳的像素分量越重：灰、黑、白不决定一张封面的颜色。
    let red = 0, green = 0, blue = 0, total = 0;
    for (let index = 0; index < pixels.length; index += 16) {
        const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]];
        const weight = (Math.max(r, g, b) - Math.min(r, g, b)) / 255 + .04;
        red += r * weight; green += g * weight; blue += b * weight; total += weight;
    }
    return [red / total, green / total, blue / total];
};
const applyColors = ([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
    let hue = 262, saturation = .4;
    if (span >= 10) {
        hue = ((max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60 + 360) % 360;
        saturation = Math.max(.3, Math.min(.75, span / 255 + .2));
    }
    const root = simCss(document.documentElement);
    root.setProperty("--deep", `hsl(${hue.toFixed(1)}, ${(saturation * 55).toFixed(1)}%, 8%)`);
    root.setProperty("--mid", `hsl(${hue.toFixed(1)}, ${(saturation * 70).toFixed(1)}%, 25%)`);
    root.setProperty("--ink", `hsl(${hue.toFixed(1)}, 85%, 93%)`);
    spectrumInk = `hsla(${hue.toFixed(1)}, 90%, 88%, `;
};
let coverLoading = null;
const loadCover = track => {
    const address = track && track.infoReady ? track.largeCover : placeholder;
    const image = coverLoading = new Image();
    // 解码完成后才换上：唱片和背景不会先空一下。
    image.onload = () => { if (coverLoading !== image) return; discCover.src = backdropCover.src = address; applyColors(track ? coverColor(image) : [120, 100, 180]); };
    image.onerror = () => { if (coverLoading !== image) return; discCover.src = backdropCover.src = placeholder; applyColors([120, 100, 180]); };
    image.src = address;
};

// ---------- 转盘 ----------
// 第一行总是歌名（副行是艺术家）：前奏时、没有歌词时它就是居中的那一句。歌词的第一句本身就是歌名的歌
// （常见的写法，有时后面还跟着艺术家），用这一句当第一行，不另加一行。
let lines = [];
let nodes = [];
let linesKey = "";
let shownKey = "";
// 滚轮翻看时居中的行；-1 表示跟着演唱走。停止滚动几秒后回到正在唱的那一句。
let browseIndex = -1;
let browseTimer = 0;
let wheelTravel = 0;
const buildLines = () => {
    const track = state.current;
    const lyrics = state.lyrics || {};
    const sung = lyrics.perWord ? lyrics.perWord.map(line => ({ time: line.start, text: line.text, translation: line.translation, words: line.words })) : (lyrics.traditional || []);
    const shown = sung.filter(line => String(line.text || "").trim());
    const plain = text => String(text || "").replace(/s+/g, "").toLowerCase();
    const title = plain(track && track.title);
    const titled = !!title && shown.length > 0 && plain(shown[0].text).startsWith(title);
    const next = titled ? [{ ...shown[0], translation: shown[0].translation || artistOf(track) }, ...shown.slice(1)] : [{ time: -1, text: track ? track.title : "", translation: artistOf(track) }, ...shown];
    const key = JSON.stringify(next);
    if (key === linesKey) return;
    linesKey = key;
    lines = next;
    wheel.innerHTML = lines.map((line, index) => `<div class="wheelLine${line.time >= 0 ? " seekable" : ""}" data-offset="3">${line.words ? line.words.map(word => `<span class="word">${escapeText(word.text)}</span>`).join("") : escapeText(line.text)}${line.translation ? `<span class="translation">${escapeText(line.translation)}</span>` : ""}</div>`).join("");
    nodes = [...wheel.children];
    nodes.forEach((node, index) => { if (lines[index].time >= 0) node.onclick = () => { stopBrowsing(); simPlayer.seek(lines[index].time + .05); }; });
    stopBrowsing();
    shownKey = "";
    turnWheel();
};
const sungIndex = position => {
    let index = 0;
    for (let i = 1; i < lines.length && lines[i].time <= position; i++) index = i;
    return index;
};
// 每一行按它离居中那一句有几行就位：两行以内可见，更远的停在扇面两端、不显示。
const turnWheel = () => {
    const position = simPlayer.position();
    const sung = sungIndex(position), center = browseIndex >= 0 ? browseIndex : sung;
    if (shownKey !== `${center}:${sung}`) {
        shownKey = `${center}:${sung}`;
        wheel.classList.toggle("translated", !!lines[center]?.translation);
        nodes.forEach((node, i) => {
            const offset = String(Math.max(-3, Math.min(3, i - center)));
            if (node.dataset.offset !== offset) node.dataset.offset = offset;
            node.classList.toggle("sung", i === sung);
        });
        fitLine(nodes[center]);
    }
    paintWords(sung, position);
};
// 居中的一句放不下时缩小字号，最多缩到七成，再长才以省略号截断；转开后恢复原来的字号。
let fittedLine = null;
const fitLine = node => {
    if (fittedLine && fittedLine !== node) simCss(fittedLine).removeProperty("--fit");
    fittedLine = node;
    if (!node) return;
    simCss(node).removeProperty("--fit");
    if (node.scrollWidth > node.clientWidth) simCss(node).setProperty("--fit", Math.max(.7, node.clientWidth / node.scrollWidth).toFixed(3));
};
addEventListener("resize", () => fitLine(fittedLine));
// 逐字歌词：正在唱的这一句里，唱过的片段完全显示，正在唱的片段随时间从左到右显现。
let wordProgress = "";
const paintWords = (index, position) => {
    const words = lines[index]?.words;
    if (!words) return;
    const spans = nodes[index].querySelectorAll(".word");
    let progress = "";
    words.forEach((word, i) => {
        const done = position >= word.end, doing = !done && position >= word.start;
        spans[i].classList.toggle("done", done);
        spans[i].classList.toggle("doing", doing);
        if (doing) progress = `${(100 * (position - word.start) / Math.max(.001, word.end - word.start)).toFixed(1)}%`;
    });
    if (progress && progress !== wordProgress) simCss(wheel).setProperty("--wordProgress", wordProgress = progress);
};
const stopBrowsing = () => { clearTimeout(browseTimer); browseIndex = -1; wheelTravel = 0; };
// 位置由宿主每 250ms 报告一次，simPlayer.position() 在其间连续推算。暂停或页面不在显示时不再逐帧查看。
let frameId = 0;
const frame = () => {
    frameId = 0;
    if (!state.visible) return;
    turnWheel();
    if (state.playing && !state.loading) frameId = requestAnimationFrame(frame);
};
const schedule = () => { if (!frameId) frameId = requestAnimationFrame(frame); spectrumStart(); };

// ---------- 频谱：唱片外圈一圈细线，低音在正右方，向上下两侧依次升高 ----------
let spectrumInk = "hsla(262, 90%, 88%, ";
let levels = new Array(48).fill(0);
// 频谱整体的出现程度：开始播放时从唱片边缘长出来，暂停时收回去。
let presence = 0;
let spectrumFrame = 0;
let spectrumWaiting = false;
const drawSpectrum = () => {
    const scale = devicePixelRatio || 1, size = spectrum.clientWidth;
    if (spectrum.width !== Math.round(size * scale)) spectrum.width = spectrum.height = Math.round(size * scale);
    const context = spectrum.getContext("2d");
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, size, size);
    const discRadius = disc.clientWidth / 2, room = (size / 2 - discRadius) / 1.25;
    context.lineCap = "round";
    context.lineWidth = Math.max(2, discRadius * .012);
    // 两侧对称，每侧各一组频段，在正左方合拢成一整圈。
    const count = levels.length, spread = Math.PI;
    for (let side = -1; side <= 1; side += 2) {
        levels.forEach((level, band) => {
            const angle = side * (band + .5) / count * spread;
            const inner = discRadius + room * .18, outer = inner + room * .93 * presence * Math.max(.05, level);
            context.strokeStyle = spectrumInk + (presence * (.18 + .5 * level)).toFixed(3) + ")";
            context.beginPath();
            context.moveTo(size / 2 + Math.cos(angle) * inner, size / 2 + Math.sin(angle) * inner);
            context.lineTo(size / 2 + Math.cos(angle) * outer, size / 2 + Math.sin(angle) * outer);
            context.stroke();
        });
    }
};
// 每帧向宿主要一次频谱（上一次还没返回时跳过）；升得快、落得慢。暂停后画到收回为止。
const spectrumTick = () => {
    spectrumFrame = 0;
    if (!state.visible) return;
    const playing = state.playing && !state.loading;
    if (!spectrumWaiting && playing) {
        spectrumWaiting = true;
        simPlayer.spectrum(levels.length).then(next => {
            levels = levels.map((level, band) => { const value = next[band] || 0; return value > level ? level + (value - level) * .55 : Math.max(value, level * .88); });
        }).catch(() => {}).finally(() => { spectrumWaiting = false; });
    } else if (!playing) levels = levels.map(level => level * .88);
    presence += ((playing ? 1 : 0) - presence) * .08;
    if (!playing && presence < .005) presence = 0;
    drawSpectrum();
    if (playing || presence > 0) spectrumFrame = requestAnimationFrame(spectrumTick);
};
const spectrumStart = () => { if (!spectrumFrame) spectrumFrame = requestAnimationFrame(spectrumTick); };

// ---------- 状态 ----------
let trackKey = "";
const syncTrack = () => {
    const track = state.current;
    const key = track ? `${track.source}:${track.id}:${track.infoRevision || 0}:${track.infoReady}` : "";
    if (key === trackKey) return;
    trackKey = key;
    trackTitle.textContent = track ? track.title : "";
    trackArtist.textContent = [artistOf(track), track && track.album].filter(Boolean).join(" · ");
    loadCover(track);
    buildLines();
};
const syncStatus = () => {
    document.body.classList.toggle("playing", state.playing && !state.loading);
    document.body.classList.toggle("fullscreen", !!state.fullscreen);
    discIcon.textContent = toggleButton.firstElementChild.textContent = glyph(state.playing ? "F507" : "F508");
    modeButton.firstElementChild.textContent = glyph(["F072", "F075", "F124"][state.mode || 0]);
    modeButton.title = ["列表循环", "单曲循环", "随机播放"][state.mode || 0];
    muteButton.firstElementChild.textContent = glyph(state.volume <= 0 ? "F29E" : "F2A2");
    volumeBar.progress.value = state.volume;
    const duration = Math.max(1, state.duration);
    if (Number(seekBar.progress.max) !== duration) seekBar.progress.max = duration;
    durationLabel.textContent = formatTime(state.duration);
    maximizeButton.textContent = glyph(state.windowMaximized ? "EABB" : "EAB9");
    fullscreenButton.title = state.fullscreen ? "退出全屏" : "全屏";
    schedule();
};
const syncPosition = () => {
    seekBar.progress.value = state.position;
    positionLabel.textContent = formatTime(state.position);
    schedule();
};
simPlayer.on("track", syncTrack);
simPlayer.on("lyrics", buildLines);
simPlayer.on("status", syncStatus);
simPlayer.on("position", syncPosition);
// ---------- 播放队列 ----------
const placeholderOf = track => track.infoReady ? track.cover : placeholder;
const trackId = track => `${track.source}\0${track.id}`;
let dragging = false;
let queueKeys = "";
// 按指针位置排序：浮动的副本跟随指针，途经的行让位，靠近边缘时列表自动滚动，Esc 取消。
const startDragSort = (event, row, index) => {
    const step = row.offsetHeight + 2;
    const grabbed = row.getBoundingClientRect();
    const grip = event.clientY - grabbed.top;
    const origin = grabbed.top + queueList.scrollTop - index * step;
    const count = state.queue.length;
    let pointerY = event.clientY, target = index, frame = 0;
    const copy = row.cloneNode(true);
    copy.classList.add("dragGhost");
    simCss(copy).left = `${grabbed.left}px`;
    simCss(copy).width = `${grabbed.width}px`;
    simCss(queueList).setProperty("--dragStep", `${step}px`);
    document.body.append(copy);
    const rows = () => [...queueList.querySelectorAll(".queueRow")];
    const update = () => {
        simCss(copy).top = `${pointerY - grip}px`;
        target = Math.max(0, Math.min(count - 1, Math.round((pointerY - grip + queueList.scrollTop - origin) / step)));
        rows().forEach((node, position) => {
            node.classList.toggle("dragSource", position === index);
            node.classList.toggle("dragUp", position > index && position <= target);
            node.classList.toggle("dragDown", position < index && position >= target);
        });
    };
    const scroll = () => {
        const bounds = queueList.getBoundingClientRect();
        const speed = pointerY < bounds.top + 40 ? -Math.min(18, (bounds.top + 40 - pointerY) / 3) : pointerY > bounds.bottom - 40 ? Math.min(18, (pointerY - bounds.bottom + 40) / 3) : 0;
        if (speed) { queueList.scrollTop += speed; update(); }
        frame = requestAnimationFrame(scroll);
    };
    const move = moved => { pointerY = moved.clientY; update(); };
    const swallow = clicked => { clicked.stopPropagation(); clicked.preventDefault(); };
    const finish = cancelled => {
        cancelAnimationFrame(frame);
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", drop);
        removeEventListener("pointercancel", cancel);
        removeEventListener("blur", cancel);
        removeEventListener("keydown", escape, true);
        // 松开时不能再触发下面那一行的播放。
        addEventListener("click", swallow, true);
        setTimeout(() => removeEventListener("click", swallow, true));
        copy.remove();
        queueList.classList.remove("dragSorting");
        rows().forEach(node => node.classList.remove("dragSource", "dragUp", "dragDown"));
        dragging = false;
        if (cancelled || target === index) { syncQueue(); return; }
        // 立即按新顺序显示，宿主的状态随后到达。
        state.queue.splice(target, 0, state.queue.splice(index, 1)[0]);
        state.index = state.index === index ? target : state.index > index && state.index <= target ? state.index - 1 : state.index < index && state.index >= target ? state.index + 1 : state.index;
        renderQueue();
        simPlayer.moveInQueue(index, target);
    };
    const drop = () => finish(false);
    const cancel = () => finish(true);
    const escape = pressed => { if (pressed.key === "Escape") { pressed.stopPropagation(); pressed.preventDefault(); cancel(); } };
    addEventListener("pointermove", move);
    addEventListener("pointerup", drop);
    addEventListener("pointercancel", cancel);
    addEventListener("blur", cancel);
    addEventListener("keydown", escape, true);
    dragging = true;
    update();
    requestAnimationFrame(() => { if (dragging) queueList.classList.add("dragSorting"); });
    frame = requestAnimationFrame(scroll);
};
// 可见的行里还没有读到信息的歌曲，请宿主读取；读到后随状态送达。
let infoTimer;
const loadVisibleInfo = () => {
    clearTimeout(infoTimer);
    infoTimer = setTimeout(() => {
        const bounds = queueList.getBoundingClientRect();
        const missing = [...queueList.querySelectorAll(".queueRow")].map((row, index) => [row, index]).filter(([row, index]) => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top - 300 && rect.top < bounds.bottom + 300 && state.queue[index] && !state.queue[index].infoReady; }).map(item => item[1]);
        if (missing.length) simPlayer.loadInfo(missing).catch(() => {});
    }, 90);
};
const renderQueue = () => {
    queueKeys = JSON.stringify([state.queue.map(trackId), state.index]);
    if (!state.queue.length) { queueList.innerHTML = `<div class="emptyQueue">播放队列是空的</div>`; return; }
    queueList.replaceChildren(...state.queue.map((track, index) => {
        const row = document.createElement("div");
        row.className = "queueRow";
        row.classList.toggle("current", index === state.index);
        row.innerHTML = `<img loading="lazy" src="${placeholderOf(track)}"><div><b>${escapeText(track.title)}</b><span>${escapeText(artistOf(track))}</span></div><button class="removeButton" title="移出队列">×</button>`;
        row.onclick = event => { if (!event.target.closest("button")) simPlayer.playIndex(index); };
        row.querySelector("button").onclick = () => simPlayer.removeFromQueue(index);
        row.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); simPlayer.showMenu({ scene: "queue", index }); };
        // 按住后移动才开始拖动，单击仍然是播放。
        row.onpointerdown = event => {
            if (event.button !== 0 || event.target.closest("button")) return;
            const stop = () => { removeEventListener("pointermove", moved); removeEventListener("pointerup", stop); };
            const moved = later => { if (Math.abs(later.clientY - event.clientY) < 6) return; stop(); startDragSort(event, row, index); };
            addEventListener("pointermove", moved);
            addEventListener("pointerup", stop);
        };
        return row;
    }));
    loadVisibleInfo();
};
// 歌曲和顺序没变、只是读到了信息：原地更新各行；否则重排。
const syncQueue = () => {
    if (dragging || !document.body.classList.contains("queueOpen")) return;
    if (JSON.stringify([state.queue.map(trackId), state.index]) !== queueKeys) { renderQueue(); return; }
    queueList.querySelectorAll(".queueRow").forEach((row, index) => {
        const track = state.queue[index];
        row.querySelector("b").textContent = track.title;
        row.querySelector("span").textContent = artistOf(track);
        const image = row.querySelector("img");
        if (image.getAttribute("src") !== placeholderOf(track)) image.src = placeholderOf(track);
    });
};
queueList.onscroll = loadVisibleInfo;

// ---------- 歌词与队列：和内置播放页一样，两者占同一块地方；收起歌词由宿主记住 ----------
let lyricsShown = true;
const setSide = (queue, lyrics) => {
    const opening = queue && !document.body.classList.contains("queueOpen");
    document.body.classList.toggle("queueOpen", queue);
    document.body.classList.toggle("lyricsHidden", !queue && !lyrics);
    queueButton.classList.toggle("active", queue);
    lyricsButton.classList.toggle("active", !queue && lyrics);
    if (opening) { renderQueue(); queueList.querySelector(".current")?.scrollIntoView({ block: "center" }); }
    if (!queue && lyrics) { shownKey = ""; schedule(); }
};
queueButton.onclick = () => setSide(!document.body.classList.contains("queueOpen"), lyricsShown);
lyricsButton.onclick = () => {
    lyricsShown = document.body.classList.contains("queueOpen") || document.body.classList.contains("lyricsHidden");
    setSide(false, lyricsShown);
    simPlayer.setLyricsShown(lyricsShown);
};
simPlayer.on("queue", syncQueue);
simPlayer.on("view", () => {
    document.body.classList.toggle("shown", state.visible);
    if (state.side !== "queue") lyricsShown = state.side === "lyrics";
    if (state.visible) {
        // 主界面要求的一侧：底栏的队列按钮打开队列，其余时候是歌词（或用户收起歌词后的唱片）。
        setSide(state.side === "queue", state.side === "lyrics");
        // 展开时总是从正在唱的那一句开始。
        stopBrowsing();
    }
    schedule();
});

// ---------- 控件 ----------
collapseButton.onclick = () => simPlayer.close();
minimizeButton.onclick = () => simPlayer.window("minimize");
maximizeButton.onclick = () => simPlayer.window("maximize");
closeButton.onclick = () => simPlayer.window("close");
disc.onclick = toggleButton.onclick = () => simPlayer.toggle();
previousButton.onclick = () => simPlayer.previous();
nextButton.onclick = () => simPlayer.next();
modeButton.onclick = () => simPlayer.cycleMode();
moreButton.onclick = () => simPlayer.showMenu();
fullscreenButton.onclick = () => simPlayer.toggleFullscreen();
seekBar.progress.onchange = seconds => { stopBrowsing(); simPlayer.seek(seconds); };
let previousVolume = .8;
const setVolume = value => {
    state.volume = Math.max(0, Math.min(1, value));
    simPlayer.setVolume(state.volume);
    muteButton.firstElementChild.textContent = glyph(state.volume <= 0 ? "F29E" : "F2A2");
};
volumeBar.progress.onchange = volumeBar.progress.ondrag = setVolume;
muteButton.onclick = () => { if (state.volume > 0) { previousVolume = state.volume; setVolume(0); } else setVolume(previousVolume); volumeBar.progress.value = state.volume; };
// 滚轮：在控件栏上调音量，其余地方转动歌词转盘（触控板的细小滚动累计到一格再转）。
document.addEventListener("wheel", event => {
    if (!event.deltaY || event.target.closest("#queueDrawer") || document.body.classList.contains("queueOpen") || document.body.classList.contains("lyricsHidden")) return;
    if (event.target.closest("#controlBar")) { setVolume(state.volume + (event.deltaY < 0 ? .05 : -.05)); volumeBar.progress.value = state.volume; return; }
    wheelTravel += event.deltaY;
    const steps = Math.trunc(wheelTravel / 60);
    if (!steps || lines.length < 2) return;
    wheelTravel -= steps * 60;
    browseIndex = Math.max(0, Math.min(lines.length - 1, (browseIndex >= 0 ? browseIndex : sungIndex(simPlayer.position())) + steps));
    clearTimeout(browseTimer);
    browseTimer = setTimeout(() => { stopBrowsing(); turnWheel(); }, 3000);
    turnWheel();
}, { passive: true });
document.addEventListener("contextmenu", event => { event.preventDefault(); simPlayer.showMenu(); });
