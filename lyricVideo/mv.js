// 歌词 MV：整屏的动态背景，歌词居中，一句一个版式；换句时上一句先淡出，这一句再逐字快速淡入。
// 页面只通过宿主的 simPlayer 读取状态、控制播放；歌词由宿主解析，这里只用每一句的起止时间。
const state = simPlayer.state;
const escapeText = value => su5.utils.formatText(value ?? "");
const glyph = code => String.fromCodePoint(parseInt(code, 16));
const placeholder = "/.sim/assets/placeholder.png";
const formatTime = seconds => {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
const settings = { font: "serif", fontName: "", layout: "auto", perWord: true, ghost: true, particles: true, grain: true, shake: true };
let lineTurn = 0;
let lines = [];
let linesKey = "";
let shownLine = -2;
let frameId = 0;
let lastFrame = 0;
let lastScene = "";
// 逐字歌词：当前这一句的各个片段和它们的节点。
let sungWords = [];
let sungNodes = [];
let sungLine = null;

// ---------- 颜色：取封面的主色，展开成从深到亮的一组 ----------
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
const hueOf = ([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
    if (span < 10) return [335, .55];
    const hue = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
    return [(hue * 60 + 360) % 360, Math.max(.4, Math.min(.85, span / 255 + .25))];
};
const hsl = (hue, saturation, lightness) => `hsl(${hue.toFixed(1)}, ${(saturation * 100).toFixed(1)}%, ${lightness}%)`;
const hslHex = (hue, saturation, lightness) => {
    const amount = saturation * Math.min(lightness, 1 - lightness);
    const channel = n => { const k = (n + hue / 30) % 12; return Math.round(255 * (lightness - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
};
let sprite = null;
const applyColors = color => {
    const [hue, saturation] = hueOf(color);
    const root = simCss(document.documentElement);
    root.setProperty("--deep", hsl(hue, saturation * .78, 15));
    root.setProperty("--mid", hsl(hue, saturation * .82, 37));
    root.setProperty("--bright", hsl(hue + 8, Math.min(1, saturation * 1.05), 60));
    root.setProperty("--ink", hsl(hue + 4, 1, 88));
    root.setProperty("--shade", hsl(hue, saturation * .7, 8));
    // 主界面在本页面下方垫的底色。
    simPlayer.setTitleBar({ color: hslHex(hue, saturation * .78, .15), dark: true });
    // 光斑：一枚柔和的亮点，绘制时只是贴图。
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = 128;
    const context = sprite.getContext("2d");
    const light = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    light.addColorStop(0, hsl(hue + 6, 1, 90));
    light.addColorStop(.25, `hsla(${hue + 6}, 100%, 82%, .55)`);
    light.addColorStop(1, `hsla(${hue + 6}, 100%, 70%, 0)`);
    context.fillStyle = light;
    context.fillRect(0, 0, 128, 128);
};
let coverLoading = null;
const loadCover = track => {
    const address = track && track.infoReady ? track.largeCover : placeholder;
    discCover.src = barCover.src = address;
    const image = coverLoading = new Image();
    image.onload = () => { if (coverLoading === image) applyColors(track ? coverColor(image) : [200, 60, 110]); };
    image.onerror = () => { if (coverLoading === image) applyColors([200, 60, 110]); };
    image.src = address;
};

// ---------- 歌词 ----------
// 一句歌词什么时候算唱完：宿主给了逐字歌词就用它的行尾，否则按字数估一个时长，不拖过整段间奏。
const glyphs = text => text.replace(/\s/g, "").length;
const sceneFor = (index, text) => {
    const count = glyphs(text);
    const latin = /[A-Za-z]{2}/.test(text);
    let options = count <= 5 ? ["sceneCenter", "sceneVertical"] : count <= 10 ? ["sceneCenter", "sceneStack", "sceneVertical"] : count <= 18 ? ["sceneCenter", "sceneStack"] : ["sceneCenter"];
    if (latin) options = options.filter(scene => scene !== "sceneVertical");
    let scene = options[(index * 5 + count) % options.length];
    if (scene === lastScene && options.length > 1) scene = options[(options.indexOf(scene) + 1) % options.length];
    return lastScene = scene;
};
// 这一句里的词组：按词切分，取两到四个字的词；背后的虚影每句从中随机取一个。
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const phrasesOf = text => {
    const words = [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment.trim());
    const phrases = words.filter(word => word.length >= 2 && word.length <= (/[A-Za-z]/.test(word) ? 9 : 4));
    // 全是单字时把相邻的两个字并在一起。
    return phrases.length ? phrases : words.length > 1 ? words.slice(0, -1).map((word, index) => word + words[index + 1]).filter(word => word.length <= 4) : words;
};
const buildLines = () => {
    const key = JSON.stringify(state.lyrics);
    if (key === linesKey) return;
    linesKey = key;
    const plain = state.lyrics.traditional;
    lines = state.lyrics.perWord ? state.lyrics.perWord.map(line => ({ start: line.start, end: line.end, text: line.text, translation: line.translation, words: line.words.filter(word => word.text) })) : plain.map((line, index) => {
        const gap = (plain[index + 1]?.time ?? (state.duration > line.time ? state.duration : line.time + 5)) - line.time;
        return { start: line.time, end: line.time + Math.max(.6, Math.min(gap, Math.max(1.6, glyphs(line.text) * .42))), text: line.text, translation: line.translation };
    });
    lastScene = "";
    lines.forEach((line, index) => {
        line.scene = sceneFor(index, line.text);
        line.phrases = phrasesOf(line.text);
    });
    shownLine = -2;
};
const kick = (element, keyframes, duration) => { if (settings.shake) element.animate(keyframes, { duration, easing: "cubic-bezier(.16, 1, .3, 1)" }); };
// 一个片段是一个汉字（或假名、谚文）连同其后的标点，或一个西文词连同其后的空格：逐字淡入按它来。
const pieces = text => text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][^\p{L}\p{N}]*|[\p{L}\p{N}'’-]+[^\p{L}\p{N}]*|[^\p{L}\p{N}]+/gu) || [];
// 一句分成两行时从哪里断：尽量靠近正中，原文里有空格的地方优先。
const splitAt = parts => {
    const total = glyphs(parts.join(""));
    let best = 0, cost = Infinity, before = 0;
    for (let index = 1; index < parts.length; index++) {
        before += glyphs(parts[index - 1]);
        const value = Math.abs(before - total / 2) - (/\s$/.test(parts[index - 1]) ? 1.6 : 0);
        if (value < cost) { cost = value; best = index; }
    }
    return best;
};
// 这一句是否按逐字歌词显示：设置开着，并且宿主给了它的逐字时间。
const sungByWord = line => settings.perWord && line.words?.length > 0;
// 一句拆成的片段：逐字歌词按宿主给的片段（一个词、一个音节或一个字），否则按字。
const partsOf = line => sungByWord(line) ? line.words.map(word => word.text) : pieces(line.text);
const lineHtml = (line, split) => {
    const parts = partsOf(line);
    const piece = text => `<b class="c">${escapeText(text)}</b>`;
    const row = list => `<span class="row">${list.map(piece).join("").replace(/\s+(<\/b>)$/, "$1")}</span>`;
    return (split > 0 ? row(parts.slice(0, split)) + row(parts.slice(split)) : parts.map(piece).join("")) + (line.translation ? `<span class="tr">${escapeText(line.translation)}</span>` : "");
};
const forced = { center: "sceneCenter", stack: "sceneStack", vertical: "sceneVertical" };
const lineNode = line => {
    const scene = forced[settings.layout] || line.scene;
    const count = glyphs(line.text) / (scene === "sceneStack" ? 1.7 : 1);
    const node = document.createElement("div");
    node.className = `line current ${scene} ${count <= 6 ? "sizeS" : count <= 10 ? "sizeM" : count <= 18 ? "sizeL" : "sizeX"}`;
    node.classList.toggle("byWord", sungByWord(line));
    node.innerHTML = lineHtml(line, scene === "sceneStack" ? splitAt(partsOf(line)) : 0);
    return node;
};
// 一句歌词不会自己折行（否则常常只有一两个字掉到下一行）。放不下时：差得不多就整句缩小；差得多就从中间
// 断成长短相近的两行，再不够才缩小。竖排按高度同样处理，断开后是两列。
const fitLine = (node, line) => {
    const vertical = node.classList.contains("sceneVertical");
    const room = vertical ? stage.clientHeight * .86 : stage.clientWidth * .9;
    const extent = () => vertical ? node.offsetHeight : node.offsetWidth;
    const shrink = () => { const size = parseFloat(getComputedStyle(node).fontSize); if (extent() > room) simCss(node).setProperty("--size", `${(size * room / extent()).toFixed(1)}px`); };
    if (extent() <= room) return;
    if (!node.querySelector(".row") && extent() > room / .74) {
        const split = splitAt(partsOf(line));
        if (split > 0) node.innerHTML = lineHtml(line, split);
    }
    shrink();
};

// 换句：上一句先淡出，然后这一句逐字快速淡入；背后的虚影换成这一句里随机的一个词组，两侧的光环亮一下。
// instant 用于页面刚被展开时：画面直接就是当前这一句，不播放任何过渡。
const showLine = (index, instant = false) => {
    shownLine = index;
    const turn = ++lineTurn;
    const line = index >= 0 ? lines[index] : null;
    const old = [...stage.querySelectorAll(".line")];
    document.body.classList.toggle("idle", !line);
    sungWords = sungNodes = [];
    sungLine = null;
    const enter = () => {
        if (turn !== lineTurn) return;
        old.forEach(node => node.remove());
        if (!line) return;
        const node = lineNode(line);
        if (!instant) node.classList.add("entering");
        stage.append(node);
        fitLine(node, line);
        if (sungByWord(line)) { sungWords = line.words; sungNodes = [...node.querySelectorAll(".c")]; sungLine = node; paintWords(simPlayer.position()); }
        ghost.textContent = line.phrases.length ? line.phrases[Math.floor(Math.random() * line.phrases.length)] : "";
        if (instant) return;
        ghost.classList.remove("beat");
        void ghost.offsetWidth;
        ghost.classList.add("beat");
        if (state.playing) {
            kick(shot, [{ transform: "scale(1.03)" }, { transform: "scale(1)" }], 1200);
            [ringsLeft, ringsRight].forEach(ring => kick(ring, [{ opacity: .55 }, { opacity: 1 }], 700));
        }
    };
    if (instant || !old.length) { enter(); return; }
    old.forEach(node => { node.classList.remove("current", "entering"); node.classList.add("leaving"); });
    ghost.classList.remove("beat");
    setTimeout(enter, 240);
};


// 逐字歌词：整句一起出现，唱过的片段完全显示，没唱到的半透明，正在唱的片段随时间显现（横排从左到右，竖排从上到下）。
let wordProgress = "";
const paintWords = position => {
    if (!sungLine || sungNodes.length !== sungWords.length) return;
    let progress = "";
    sungWords.forEach((word, index) => {
        const sung = position >= word.end, singing = !sung && position >= word.start;
        sungNodes[index].classList.toggle("sung", sung);
        sungNodes[index].classList.toggle("singing", singing);
        if (singing) progress = `${(100 * (position - word.start) / Math.max(.001, word.end - word.start)).toFixed(1)}%`;
    });
    if (progress && progress !== wordProgress) simCss(stage).setProperty("--wordProgress", wordProgress = progress);
};

// ---------- 光斑 ----------
const dots = Array.from({ length: 44 }, () => ({ x: Math.random(), y: Math.random(), size: .02 + Math.random() * .09, speed: .012 + Math.random() * .03, sway: Math.random() * 6.28, alpha: .08 + Math.random() * .2 }));
const drawParticles = seconds => {
    const width = particles.width, height = particles.height;
    const context = particles.getContext("2d");
    context.clearRect(0, 0, width, height);
    if (!sprite) return;
    dots.forEach(dot => {
        dot.y -= dot.speed * seconds;
        dot.sway += seconds * .6;
        if (dot.y < -.15) { dot.y = 1.15; dot.x = Math.random(); }
        const size = dot.size * height;
        context.globalAlpha = dot.alpha * (.7 + .3 * Math.sin(dot.sway * 1.7));
        context.drawImage(sprite, (dot.x + Math.sin(dot.sway) * .02) * width - size / 2, dot.y * height - size / 2, size, size);
    });
};
const sizeParticles = () => { particles.width = Math.ceil(innerWidth / 2); particles.height = Math.ceil(innerHeight / 2); };
addEventListener("resize", sizeParticles);
sizeParticles();
{
    // 颗粒：一小块噪点平铺，位置逐帧跳动。
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    const noise = context.createImageData(128, 128);
    for (let index = 0; index < noise.data.length; index += 4) { noise.data[index] = noise.data[index + 1] = noise.data[index + 2] = Math.random() * 255; noise.data[index + 3] = 255; }
    context.putImageData(noise, 0, 0);
    simCss(grain).backgroundImage = `url(${canvas.toDataURL()})`;
}

// ---------- 逐帧 ----------
// 位置由宿主每 250ms 报告一次，simPlayer.position() 在其间连续推算。暂停或页面不在显示时不再绘制。
let instantNext = false;
const canDraw = () => state.visible && !document.hidden;
const frame = now => {
    frameId = 0;
    if (!canDraw()) return;
    const seconds = Math.min(.1, (now - lastFrame) / 1000 || 0);
    lastFrame = now;
    const position = simPlayer.position();
    let index = -1;
    for (let i = 0; i < lines.length && lines[i].start <= position; i++) index = i;
    if (index >= 0) {
        // 一句唱完后停留片刻；到下一句之间是一段间奏的，回到封面与歌名并一直留到下一句开始，
        // 不在间奏快结束时把间奏前的那一句再放出来。
        const next = lines[index + 1];
        if (position > lines[index].end + 1.6 && (!next || next.start - lines[index].end > 4.1)) index = -1;
    }
    // 第一句歌词就是歌名的歌：唱到它时显示的是歌名那一页，而不是把歌名当作一句歌词。
    if (index === 0 && lines[0].text.trim() === String(state.current?.title || "").trim()) index = -1;
    if (index !== shownLine) showLine(index, instantNext);
    instantNext = false;
    paintWords(position);
    simCss(progressLine).setProperty("--played", (state.duration ? Math.min(1, position / state.duration) : 0).toFixed(4));
    if (settings.particles) drawParticles(state.playing ? seconds : 0);
    if (state.playing && !state.loading) frameId = requestAnimationFrame(frame);
};
const schedule = () => { if (canDraw() && !frameId) frameId = requestAnimationFrame(frame); };

// ---------- 状态 ----------
// 歌名放不下时会折行：折下去的最后一行至少要有最长一行的一半，否则缩小字号，让它回到上一行。
const titleRows = () => {
    const range = document.createRange();
    range.selectNodeContents(idleTitle);
    const rows = [];
    for (const rect of range.getClientRects()) {
        const row = rows.find(item => Math.abs(item.top - rect.top) < rect.height / 2);
        if (row) row.width += rect.width; else rows.push({ top: rect.top, width: rect.width });
    }
    return rows;
};
const fitTitle = () => {
    let fit = 1;
    simCss(idleTitle).removeProperty("--titleFit");
    for (let step = 0; step < 14; step++) {
        const rows = titleRows();
        if (rows.length < 2 || rows[rows.length - 1].width >= Math.max(...rows.map(row => row.width)) / 2) break;
        simCss(idleTitle).setProperty("--titleFit", (fit *= .95).toFixed(3));
    }
};
addEventListener("resize", fitTitle);
document.fonts.ready.then(fitTitle);
let trackKey = "";
const syncTrack = () => {
    const track = state.current;
    const key = track ? `${track.source}\0${track.id}:${track.infoRevision}:${track.infoReady}` : "";
    if (key === trackKey) return;
    trackKey = key;
    const artist = track && track.artist && track.artist !== "未知艺术家" ? track.artist : "";
    idleTitle.textContent = barTitle.textContent = track?.title || "";
    idleArtist.textContent = barArtist.textContent = artist;
    topTitle.textContent = [track?.title, artist].filter(Boolean).join(" - ");
    fitTitle();
    loadCover(track);
};
const syncStatus = () => {
    document.body.classList.toggle("playing", state.playing && !state.loading);
    toggleButton.firstElementChild.textContent = glyph(state.playing ? "F507" : "F508");
    modeButton.firstElementChild.textContent = glyph(["F072", "F075", "F124"][state.mode || 0]);
    modeButton.title = ["列表循环", "单曲循环", "随机播放"][state.mode || 0];
    muteButton.firstElementChild.textContent = glyph(state.volume <= 0 ? "F29E" : "F2A2");
    const duration = Math.max(1, state.duration);
    if (Number(seekBar.progress.max) !== duration) seekBar.progress.max = duration;
    volumeBar.progress.value = state.volume;
    durationLabel.textContent = formatTime(state.duration);
    maximizeButton.textContent = glyph(state.windowMaximized ? "EABB" : "EAB9");
    document.body.classList.toggle("fullscreen", !!state.fullscreen);
    fullscreenButton.title = state.fullscreen ? "退出全屏" : "全屏";
    const font = String(state.settings["general.font"] || "").replace(/["\\]/g, "");
    simCss(document.documentElement).setProperty("--appFont", `"${font || "Microsoft YaHei"}"`);
    schedule();
};
const syncPosition = () => {
    seekBar.progress.value = state.position;
    positionLabel.textContent = formatTime(state.position);
    schedule();
};
// ---------- 播放队列：与内置播放页的队列一样，点一行播放、× 移出、拖动排序、右键是这首歌的菜单 ----------
const trackId = track => `${track.source}\0${track.id}`;
const coverOf = track => track.infoReady ? track.cover : placeholder;
const artistOf = track => track.artist && track.artist !== "未知艺术家" ? track.artist : "";
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
let infoTimer;
// 可见的行里还没有读到信息的歌曲，请宿主读取；读到后随状态送达。
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
    queueList.replaceChildren(...state.queue.map((track, index) => {
        const row = document.createElement("div");
        row.className = "queueRow";
        row.classList.toggle("current", index === state.index);
        row.innerHTML = `<img loading="lazy" src="${coverOf(track)}"><div><b>${escapeText(track.title)}</b><span>${escapeText(artistOf(track))}</span></div><button class="removeButton" title="移出队列">×</button>`;
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
    if (dragging || !document.body.classList.contains("queue")) return;
    if (JSON.stringify([state.queue.map(trackId), state.index]) !== queueKeys) { renderQueue(); return; }
    queueList.querySelectorAll(".queueRow").forEach((row, index) => {
        const track = state.queue[index];
        row.querySelector("b").textContent = track.title;
        row.querySelector("span").textContent = artistOf(track);
        const image = row.querySelector("img");
        if (image.getAttribute("src") !== coverOf(track)) image.src = coverOf(track);
    });
};
queueList.onscroll = loadVisibleInfo;
// 队列从右侧展开并一直停留，歌词区域随之收窄；再点一次按钮收起。
const setQueue = open => {
    document.body.classList.toggle("queue", open);
    queueButton.classList.toggle("active", open);
    fitTitle();
    if (open) { renderQueue(); queueList.querySelector(".current")?.scrollIntoView({ block: "center" }); }
    // 歌词区域的宽度变了：等它变完，当前这一句按新的宽度重新排一次。
    setTimeout(() => { if (shownLine >= 0) { shownLine = -2; instantNext = true; schedule(); } }, 480);
};

let wasVisible = false;
const syncRendering = () => {
    const drawing = canDraw();
    document.body.classList.toggle("rendering", drawing);
    if (!drawing) { cancelAnimationFrame(frameId); frameId = 0; }
    else { instantNext = true; lastFrame = performance.now(); schedule(); }
};
addEventListener("visibilitychange", syncRendering);
const syncView = () => {
    document.body.classList.toggle("shown", state.visible);
    syncRendering();
    if (state.visible && !wasVisible) {
        // 展开：画面直接就是当前这一句，不重播换句的过渡（页面是随窗口滑入的）。主界面要求显示队列时
        // 把它打开，并让控件露一会儿。
        instantNext = true;
        cancelAnimationFrame(frameId);
        frame(performance.now());
        setQueue(state.side === "queue");
        if (state.side === "queue") showControls();
    }
    if (!state.visible) {
        // 收起后不留着这一句：再展开时不会先看到一句过时的歌词。
        setQueue(false);
        lineTurn++;
        stage.replaceChildren();
        ghost.textContent = "";
        shownLine = -2;
    }
    wasVisible = state.visible;
    schedule();
};
simPlayer.on("track", syncTrack);
simPlayer.on("queue", () => { syncTrack(); syncQueue(); });
simPlayer.on("lyrics", () => { buildLines(); schedule(); });
simPlayer.on("status", syncStatus);
simPlayer.on("position", syncPosition);
simPlayer.on("view", syncView);
simPlayer.on("message", data => {
    if (data?.type !== "settings") return;
    Object.assign(settings, data.values);
    // 自定义字体：填写了就用它，按字体本身的字重显示；否则是粗宋体或界面字体。
    const custom = String(settings.fontName || "").replace(/["\\;{}<>]/g, "").trim();
    document.body.classList.toggle("serif", !custom && settings.font !== "sans");
    document.body.classList.toggle("customFont", !!custom);
    if (custom) simCss(document.documentElement).setProperty("--lyricFont", `"${custom}"`); else simCss(document.documentElement).removeProperty("--lyricFont");
    document.body.classList.toggle("noParticles", !settings.particles);
    document.body.classList.toggle("noGrain", !settings.grain);
    document.body.classList.toggle("noGhost", !settings.ghost);
    fitTitle();
    // 版式或逐字歌词的开关换了：当前这一句按新的设置重新显示。
    if (shownLine >= 0) { shownLine = -2; instantNext = true; }
    schedule();
});
document.body.classList.add("serif");
simPlayer.postMessage({ type: "settings" });

// ---------- 控件：移动鼠标出现，停下片刻后隐去 ----------
let controlsTimer;
const showControls = () => {
    document.body.classList.add("controls");
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
        // 指针停在控件上、或正在拖动进度时不隐去。
        if (dragging || document.querySelector("#controlBar:hover, #topBar:hover")) { showControls(); return; }
        document.body.classList.remove("controls");
    }, 2600);
};
addEventListener("pointermove", showControls);
addEventListener("pointerdown", showControls);
// 顶栏是拖动窗口的区域，指针进到那里页面就收不到任何事件了，和离开窗口一样。从上边离开的，控件留着
// 不收起（否则指针一靠近顶栏，顶栏反而消失）；从别处离开窗口、或窗口失去焦点时才收起。
document.documentElement.addEventListener("pointerleave", event => {
    clearTimeout(controlsTimer);
    if (event.clientY <= 48 && event.clientX > 0 && event.clientX < innerWidth) document.body.classList.add("controls");
    else document.body.classList.remove("controls");
});
addEventListener("blur", () => { clearTimeout(controlsTimer); document.body.classList.remove("controls"); });
collapseButton.onclick = () => simPlayer.close();
minimizeButton.onclick = () => simPlayer.window("minimize");
maximizeButton.onclick = () => simPlayer.window("maximize");
closeButton.onclick = () => simPlayer.window("close");
previousButton.onclick = () => simPlayer.previous();
nextButton.onclick = () => simPlayer.next();
toggleButton.onclick = () => simPlayer.toggle();
modeButton.onclick = () => simPlayer.cycleMode();
queueButton.onclick = () => setQueue(!document.body.classList.contains("queue"));
moreButton.onclick = event => simPlayer.showMenu();
seekBar.progress.onchange = seconds => simPlayer.seek(seconds);
let previousVolume = .8;
let volumeSending = false, volumeWanted = null;
const setVolume = async value => {
    state.volume = Math.max(0, Math.min(1, value));
    muteButton.firstElementChild.textContent = glyph(state.volume <= 0 ? "F29E" : "F2A2");
    // 拖动时只发送最新的值。
    volumeWanted = state.volume;
    if (volumeSending) return;
    volumeSending = true;
    while (volumeWanted !== null) { const next = volumeWanted; volumeWanted = null; await simPlayer.setVolume(next).catch(() => {}); }
    volumeSending = false;
};
volumeBar.progress.onchange = volumeBar.progress.ondrag = setVolume;
muteButton.onclick = () => { if (state.volume > 0) { previousVolume = state.volume; setVolume(0); } else setVolume(previousVolume); volumeBar.progress.value = state.volume; };
fullscreenButton.onclick = () => simPlayer.toggleFullscreen();
shot.addEventListener("dblclick", () => simPlayer.toggleFullscreen());
document.addEventListener("contextmenu", event => { event.preventDefault(); if (!event.target.closest("#controlBar, #topBar, #queueDrawer")) simPlayer.showMenu(); });
document.addEventListener("wheel", event => { if (!event.deltaY || event.target.closest("#queueDrawer")) return; setVolume(state.volume + (event.deltaY < 0 ? .05 : -.05)); volumeBar.progress.value = state.volume; showControls(); }, { passive: true });
