// 一起听：创建分享的一方得到一个链接，其他人把它粘贴到本扩展的“一起听”页面，或直接用浏览器打开，即可加入。
// 同一分享里的各端共用一个播放队列与进度，任何一端都可以操作；创建者结束分享（或离开太久）时分享随之销毁。
// 歌曲的音频来自把它加进队列的那一端：地址连同请求头原样交给其他人，文件由随附的 musicSyncUpload 经中继
// 边传边播。中继服务与它的接口见 relay/main.go。
//
// 共享状态：{ queue: [{ key, title, artist, album, duration }], index, playing, position, at, mode, speed, actions }，见“共享状态”一节。
// key 为“带来这首歌的成员 id.来源与 id 的散列”；at 是 position 对应的中继时间（毫秒）。
// 在别人那里，一首歌是本扩展协议 musicsync 的歌曲，id 就是 key；在带来它的那一端，它仍是原来的歌曲。
const scheme = "musicsync";
const player = sim.player;

const clientId = (() => {
  let id = sim.settings.get("clientId", "");
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sim.settings.set("clientId", id);
  }
  return id;
})();

// 歌曲的来源与 id 不出本机：其他成员只见到它们的散列。
const hash = text => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
const originOf = key => String(key).split(".")[0];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (text, error) => console.error(text + (error ? "：" + (error.message || error) : ""));

let session = null; // { base, id, password, token, link, seq, version, shared, members, offset, applying, jumped, ownSeek }
const known = new Map(); // key → 共享的歌曲条目
const own = new Map(); // 本机带来的歌曲：key → { source, id }
let panel = null;
let busy = false;

const entry = (key, track) => ({ key, title: track.title || "", artist: track.artist || "", album: track.album || "", duration: track.duration || 0 });
const keyOf = track => track.source === scheme ? track.id : clientId + "." + hash(track.source + "\n" + track.id);
const entryOf = track => {
  const key = keyOf(track);
  if (track.source === scheme) return known.get(key) || entry(key, track);
  own.set(key, { source: track.source, id: track.id });
  const value = entry(key, track);
  known.set(key, value);
  return value;
};

// ---------- 与中继通信 ----------

const auth = s => s.password ? { "X-Sync-Password": s.password } : {};
const request = async (s, method, path, body) => {
  const response = await sim.fetch(`${s.base}/api/s/${s.id}${path}`, {
    method, headers: { "Content-Type": "application/json", ...auth(s) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw Object.assign(new Error("HTTP " + response.status), { status: response.status });
  return response.json();
};
const parseLink = link => {
  const match = /^(https?:\/\/.+?)\/s\/([0-9a-f]+)\/?(?:[?#].*)?$/i.exec(String(link || "").trim());
  return match && { base: match[1], id: match[2].toLowerCase() };
};

// 对共享状态的处理逐个进行，不会交错。
let chain = Promise.resolve();
const enqueue = job => (chain = chain.then(job).catch(error => log("同步出错", error)));

const loop = async s => {
  let failures = 0;
  while (session === s) {
    try {
      const result = await request(s, "GET", `/poll?client=${clientId}&since=${s.seq}`);
      if (session !== s) return;
      failures = 0;
      s.offset = result.now - Date.now();
      if (s.members !== result.members) {
        s.members = result.members;
        notify();
        offerAhead(player.state);
        shareLyrics(player.state);
      }
      if (s.seq < 0 || result.state) {
        // 刚加入：分享里已有状态就照它播放，还没有（自己刚创建）就把自己的状态交出去。
        if (result.state) enqueue(() => receive(s, result.state, true));
        else if (!s.shared) enqueue(() => publish(s, ["sync"]));
      }
      for (const event of result.events) {
        if (event.type === "state") enqueue(() => receive(s, event.data, false));
        if (event.type === "need") answer(s, event.data);
        // 有人新加入：创建者交出此刻完整的状态，新成员据此对齐（之前的状态里可能还是几首歌以前）。
        if (event.type === "joined" && s.token) enqueue(() => publish(s, ["sync"]));
      }
      s.seq = result.seq;
    } catch (error) {
      if (session !== s) return;
      if (error.status === 404 || error.status === 401) {
        await leave(false, error.status === 404 ? "分享已结束" : "密码错误");
        return;
      }
      failures++;
      log("无法连接中继", error);
      await sleep(Math.min(10000, 1000 * failures));
    }
  }
};

// ---------- 共享状态 ----------
//
// 只有用户的操作才同步，各端自己播到哪里是自己的事。一次同步交出整个状态，别人整个照着对齐：队列、当前歌曲、
// 进度、播放与否、播放模式、倍速。actions 说明这次做了什么（track 切歌、seek 拖动进度、toggle 播放或暂停、queue
// 改了队列、mode 播放模式、speed 倍速）；sync 是创建者为刚加入的成员补发的状态，只有那个成员照着对齐。
// 歌曲自然放完切到下一首不算操作，各端各自切。被控每打开完一首歌，向创建者单向对齐一次进度。
// s.shared 是本机此刻的基准：本机的状态与它不同，就是用户在本机做了什么。

const viewOf = state => ({ queue: state.queue.map(entryOf), index: state.index, playing: !!state.playing, mode: state.mode === 2 ? 0 : state.mode, speed: state.speed || 1 });
const currentKeyOf = list => list.queue[list.index] ? list.queue[list.index].key : "";
// loading：本机的歌还在打开，位置还没走起来，别人照这个位置打开，不再加上经过的时间。
const baseline = s => ({ ...viewOf(player.state), position: player.position(), at: Date.now() + s.offset, loading: !!player.state.loading });

// 照别人提交时的位置与倍速推算此刻应在哪里。
const expectedPosition = (s, shared) => {
  if (!shared.playing || shared.loading) return shared.position;
  return shared.position + Math.max(0, Date.now() + s.offset - shared.at) / 1000 * (shared.speed || 1);
};

const publish = async (s, actions) => {
  if (session !== s) return;
  const state = player.state;
  const shared = { ...baseline(s), actions };
  s.shared = shared;
  s.jumped = false;
  // 自己带来的歌还没有信息时先请主程序读取，读到后随 queue 事件再交一次。
  const missing = state.queue.map((track, index) => track.source !== scheme && !track.infoReady ? index : -1).filter(index => index >= 0);
  if (missing.length) player.loadInfo(missing);
  try {
    const result = await request(s, "POST", `/state?client=${clientId}`, shared);
    s.version = Math.max(s.version, result.version);
  } catch (error) {
    log("无法提交播放状态", error);
  }
};

const receive = async (s, wrapped, fresh) => {
  if (session !== s || wrapped.version <= s.version) return;
  s.version = wrapped.version;
  const remote = wrapped.state;
  const changed = [];
  remote.queue = remote.queue.map(item => {
    const value = entry(item.key, item);
    const before = known.get(value.key);
    if (before && JSON.stringify(before) !== JSON.stringify(value) && originOf(value.key) !== clientId) changed.push(value.key);
    known.set(value.key, value);
    return value;
  });
  // 别人改了歌曲信息（例如刚读到标题）：主程序重新读取。
  if (changed.length) sim.index.remove(changed);
  if (wrapped.by === clientId && !fresh) return;
  // 创建者为新成员补发的状态只给刚加入的成员，其他人照常播放。
  if (fresh) s.syncUntil = Date.now() + 5000;
  else if ((remote.actions || []).includes("sync")) {
    if (Date.now() > (s.syncUntil || 0)) return;
    s.syncUntil = 0;
  }
  await apply(s, remote);
};

// 等歌曲打开再跳：打开期间的跳转会被忽略。
const seekWhenOpen = async (s, position) => {
  for (let i = 0; i < 40 && player.state.loading; i++) await sleep(250);
  s.ownSeek = Date.now();
  await player.seek(position);
};

// 照别人提交的状态整个对齐：播放模式、倍速、队列、当前歌曲、进度、播放与否。
const apply = async (s, remote) => {
  // 本机带来的歌按队列里的样子登记，才认得出它们的 key。
  player.state.queue.forEach(entryOf);
  const refs = [], keys = [];
  for (const item of remote.queue) {
    const ref = originOf(item.key) === clientId ? own.get(item.key) : { source: scheme, id: item.key };
    if (ref) {
      refs.push(ref);
      keys.push(item.key);
    }
  }
  const remoteKey = currentKeyOf(remote), index = keys.indexOf(remoteKey);
  const state = player.state, localKey = state.current ? keyOf(state.current) : "";
  s.applying = true;
  try {
    if (remote.mode !== state.mode && remote.mode !== 2) await player.setMode(remote.mode);
    if (remote.speed && Math.abs(remote.speed - (state.speed || 1)) > .001) await player.setSpeed(remote.speed);
    if (!refs.length) {
      if (state.queue.length) await player.clearQueue();
      return;
    }
    const expected = expectedPosition(s, remote);
    if (index >= 0 && localKey !== remoteKey) {
      // 换了歌：从别人此刻的位置打开。
      await player.setQueue(refs, { index, position: expected, play: remote.playing });
      return;
    }
    // 本机正在放的歌照常放，只换队列。
    if (state.queue.map(keyOf).join("\n") !== keys.join("\n")) await player.setQueue(refs, {});
    if (index >= 0 && Math.abs(player.position() - expected) > .5) await seekWhenOpen(s, expected);
    if (!!player.state.playing !== remote.playing) await (remote.playing ? player.play() : player.pause());
  } finally {
    // 主程序每 250 毫秒报告一次状态：等它报告了这些改动，再以本机此刻的样子为基准。
    await sleep(400);
    s.shared = baseline(s);
    s.applying = false;
  }
};

// 本机的播放器与基准不同：是用户在本机做了什么，交给其他人。
let checkTimer = null;
const check = () => {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    const s = session;
    if (!s || !s.shared || s.applying) return;
    const state = player.state;
    if (state.mode === 2) {
      // 一起听时不使用随机播放（各端的随机顺序不同）：切换播放模式时跳过它，回到列表循环。
      player.setMode(0);
      return;
    }
    const view = viewOf(state), shared = s.shared, actions = [];
    if (currentKeyOf(view) !== currentKeyOf(shared)) {
      // 上一首放到了结尾：自然切过来的，只更新基准，不交给别人。
      if (s.ending === currentKeyOf(shared) && Date.now() - s.endingAt < 5000) {
        s.shared = { ...shared, index: view.index };
        s.ending = "";
      } else actions.push("track");
    }
    if (s.jumped) actions.push("seek");
    if (view.playing !== s.shared.playing && !actions.includes("track")) actions.push("toggle");
    if (JSON.stringify(view.queue) !== JSON.stringify(s.shared.queue)) actions.push("queue");
    if (view.mode !== s.shared.mode) actions.push("mode");
    if (Math.abs(view.speed - (s.shared.speed || 1)) > .001) actions.push("speed");
    if (actions.length) enqueue(() => publish(s, actions));
  }, 150);
};

// 被控每打开完一首歌，向创建者要一次它此刻的进度，单向对齐。各端打开歌曲的快慢不同，别人提交时的位置未必准。
const calibrate = async (s, key) => {
  try {
    const result = await request(s, "GET", "/position");
    if (session !== s || result.key !== key || !player.state.current || keyOf(player.state.current) !== key) return;
    const expected = result.position + (result.playing ? Math.max(0, Date.now() + s.offset - result.at) / 1000 * (result.speed || 1) : 0);
    if (Math.abs(player.position() - expected) > .5) await seekWhenOpen(s, expected);
  } catch (error) {
    log("无法向创建者对齐进度", error);
  }
};

// 用户拖动了进度：相邻两次报告之间位置跳变。卡顿只会让位置走得慢，不算；刚打开歌曲、本机照别人跳转后的两秒内
// 不算；放到结尾回到开头（单曲循环）也不算。顺便记下歌曲放到了结尾，接下来的切歌是自然的。
let lastPosition = null;
const watchPosition = state => {
  const s = session, now = Date.now(), position = state.position, last = lastPosition;
  const key = state.current ? keyOf(state.current) : "";
  const running = state.playing && !state.loading;
  const openedAt = !last || last.key !== key || state.loading ? now : last.openedAt;
  lastPosition = { key, position, at: now, running, openedAt };
  if (!s) return;
  if (!last || last.key !== key) s.calibrateKey = key;
  if (key && s.calibrateKey === key && !state.loading) {
    s.calibrateKey = "";
    if (!s.token) calibrate(s, key);
  }
  if (running && state.duration > 0 && position >= state.duration - 1.5) {
    s.ending = key;
    s.endingAt = now;
  }
  if (!s.shared || !last || last.key !== key || s.applying || state.loading || now - openedAt < 2000 || now - (s.ownSeek || 0) < 2000) return;
  const moved = position - last.position, expectedMove = last.running ? (now - last.at) / 1000 * (state.speed || 1) : 0;
  const looped = moved < 0 && s.ending === key && now - s.endingAt < 5000;
  if (!looped && (moved > expectedMove + 1.5 || moved < -1.5)) {
    s.jumped = true;
    check();
  }
};

// 当前歌曲的歌词交给中继，浏览器里的听众也能看到。
const lrcOf = state => {
  const time = seconds => {
    const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
    return `[${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}]`;
  };
  return ((state.lyrics && state.lyrics.traditional) || []).map(line => time(line.time) + line.text + (line.translation ? "\n" + time(line.time) + line.translation : "")).join("\n");
};
const shareLyrics = state => {
  const s = session;
  if (!s || !state.current) return;
  const lrc = lrcOf(state);
  if (lrc) request(s, "POST", "/lyrics", { key: keyOf(state.current), lrc }).catch(error => log("无法提交歌词", error));
};

let following = false;
const follow = () => {
  if (following) return;
  following = true;
  player.on("queue", check).on("track", state => { check(); notify(); offerAhead(state); }).on("status", check).on("position", watchPosition).on("lyrics", shareLyrics);
};

// ---------- 别人要本机带来的歌 ----------

const mimeTypes = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };

// 这首歌此刻在本机打开着时的歌词；不等它读到，别人的播放器之后再经中继去取。
const lyricsNow = ref => {
  const state = player.state;
  return state.current && state.current.source === ref.source && state.current.id === ref.id && !state.loading ? lrcOf(state) : "";
};

// 这首歌在本机打开了（最多等六秒）。
const opened = async ref => {
  for (let i = 0; i < 24; i++) {
    const state = player.state;
    if (state.current && state.current.source === ref.source && state.current.id === ref.id && !state.loading) return true;
    await sleep(250);
  }
  return false;
};

const uploader = () => sim.path.join(sim.plugin.dir, sim.platform === "windows" ? "musicSyncUpload.exe" : "musicSyncUpload");
// 上传的只是音频本身（MP3 开头的 ID3 标签、FLAC 的封面与填充不传），大小由上传程序算出。
const uploadSize = async path => {
  const result = await sim.shell.exec(uploader(), ["size", path], { hide: true, timeout: 10000 });
  const size = Number(result.stdout.trim());
  if (result.code !== 0 || !(size > 0)) throw new Error("无法读取文件：" + result.stderr.trim());
  return size;
};

// 本机向中继的上传，同一时间只传一首：分享正在放的歌最先，其次是队列里下一首本机带来的歌，其余的排在后面。
// 切到别的歌时，没人要的那首先停下，中继记着它传到了哪里，轮到它时从那里接着传。
const uploads = new Map(); // key → { file, path, started }
let uploading = null; // { key, child, stopped }

const nextOwn = state => {
  for (let step = 1; step < state.queue.length; step++) {
    const track = state.queue[(state.index + step) % state.queue.length];
    if (track.source !== scheme) return track;
  }
  return null;
};
const wantedUploads = () => {
  const state = player.state, next = nextOwn(state);
  return [state.current ? keyOf(state.current) : "", next ? keyOf(next) : ""].filter(Boolean);
};

const scheduleUploads = () => {
  const s = session;
  if (!s) return;
  const wanted = wantedUploads();
  const rank = key => wanted.includes(key) ? wanted.indexOf(key) : wanted.length;
  const pick = [...uploads.keys()].sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) return;
  if (uploading) {
    // 正在传的比排第一的更要紧（或一样），就让它传完；否则停下它，让给要紧的那首。
    if (uploading.stopped || rank(uploading.key) <= rank(pick)) return;
    uploading.stopped = true;
    uploading.child.kill();
    return;
  }
  const job = uploads.get(pick);
  const args = [`${s.base}/api/s/${s.id}/files/${job.file}`, job.path, ...(job.started ? ["resume"] : [])];
  job.started = true;
  const current = { key: pick, stopped: false };
  current.child = sim.shell.spawn(uploader(), args, { hide: true, env: s.password ? { MUSICSYNC_PASSWORD: s.password } : {} });
  current.child.on("stderr", event => log("上传出错", event.data));
  current.child.on("exit", event => {
    if (uploading === current) uploading = null;
    // 停下的留着下次接着传；传完或出错的不再传。
    if (!current.stopped || event.code === 0) uploads.delete(pick);
    if (session === s) scheduleUploads();
  });
  uploading = current;
};
const wantUpload = (key, file, path) => {
  if (!uploads.has(key)) uploads.set(key, { file, path, started: false });
  scheduleUploads();
};
const stopUploads = () => {
  uploads.clear();
  if (uploading) {
    uploading.stopped = true;
    uploading.child.kill();
    uploading = null;
  }
};

// 自己带来的文件不等别人来要：放到它时就交给中继排队上传，队列里下一首本机带来的也是。
const offer = (s, track) => {
  const key = keyOf(track);
  if (s.offered.has(key)) return;
  s.offered.add(key);
  (async () => {
    const audio = await player.playback(track).catch(() => null);
    if (!(audio instanceof File) || session !== s) return;
    const extension = sim.path.extname(audio.name).slice(1).toLowerCase();
    const result = await request(s, "POST", "/offer", { key, size: await uploadSize(audio.path), type: mimeTypes[extension] || "" });
    if (result.file && session === s) wantUpload(key, result.file, audio.path);
  })().catch(error => log("无法预先上传", error));
};
const offerAhead = state => {
  const s = session;
  if (!s || s.members < 2 || !state.current) return;
  if (state.current.source !== scheme) offer(s, state.current);
  const next = nextOwn(state);
  if (next) offer(s, next);
  scheduleUploads();
};

const answer = async (s, need) => {
  const reply = body => request(s, "POST", `/answer?client=${clientId}`, { ticket: need.ticket, ...body }).catch(error => log("无法回复中继", error));
  if (need.kind === "position") {
    // 创建者此刻播放到哪里：自己的歌还在打开时，等它打开完再回答。
    for (let i = 0; i < 40 && player.state.loading; i++) await sleep(250);
    const state = player.state;
    return reply({ key: state.current ? keyOf(state.current) : "", position: player.position(), playing: !!state.playing, speed: state.speed || 1 });
  }
  const ref = own.get(need.key);
  if (!ref) return reply({ error: "unknown" });
  try {
    if (need.kind === "cover") {
      // 大图要等这首歌在本机打开后才有；在那之前给出的图不是最终的，中继不会记住它。
      const final = !need.large || await opened(ref);
      const file = await player.cover(ref, { large: !!need.large });
      return reply(file ? { data: file.data, type: file.type, final } : { error: "none" });
    }
    const audio = await player.playback(ref);
    const lyrics = lyricsNow(ref);
    if (audio instanceof File) {
      const extension = sim.path.extname(audio.name).slice(1).toLowerCase();
      await reply({ size: await uploadSize(audio.path), type: mimeTypes[extension] || "", lyrics });
      wantUpload(need.key, need.ticket, audio.path);
    } else {
      await reply({ url: audio.url, headers: audio.headers, lyrics });
    }
  } catch (error) {
    log("无法提供歌曲", error);
    reply({ error: "failed" });
  }
};

// ---------- 协议 ----------

exports.getMusicInfo = async (ids, scene) => {
  const s = session;
  return Promise.all(ids.map(async id => {
    const item = known.get(id) || entry(id, {});
    const coverURL = size => `${s.base}/api/s/${s.id}/cover?key=${encodeURIComponent(id)}&size=${size}`;
    const cover = s ? { url: coverURL("small"), headers: auth(s), expire: 86400 } : null;
    const info = { id, title: item.title, artist: item.artist, album: item.album, duration: item.duration, cover };
    if (scene === "list") return info;
    if (!s) throw new Error("没有加入分享");
    const result = await request(s, "POST", `/resolve?client=${clientId}`, { key: id });
    const playback = result.file ? { url: `${s.base}/api/s/${s.id}/files/${result.file}`, headers: auth(s) } : { url: result.url, headers: result.headers || {} };
    // 歌词还没有时给一个地址：主程序打开音频之后再去取，中继会等带来这首歌的人把歌词交上来。
    const lyrics = result.lyrics || { url: `${s.base}/api/s/${s.id}/lyrics.lrc?key=${encodeURIComponent(id)}`, headers: auth(s) };
    return { ...info, playback, largeCover: { url: coverURL("large"), headers: auth(s) }, lyrics };
  }));
};

// ---------- 加入与离开 ----------

const start = async details => {
  if (session) await leave(false);
  const s = { ...details, link: `${details.base}/s/${details.id}`, seq: -1, version: 0, shared: null, members: 1, offset: 0, applying: false, jumped: false, ownSeek: 0, ending: "", endingAt: 0, syncUntil: 0, calibrateKey: "", offered: new Set() };
  session = s;
  sim.settings.set("session", details);
  follow();
  if (player.state.mode === 2) await player.setMode(0);
  // 正在放的歌的歌词这时才交得出去：歌词变化时才交，开始分享前就在放的那首不会再变。
  shareLyrics(player.state);
  notify();
  loop(s);
};

// 离开分享；创建者离开即结束分享。只能在分享里播放的歌曲随之离开队列。
const leave = async (end, message) => {
  const s = session;
  if (!s) return;
  session = null;
  sim.settings.set("session", null);
  stopUploads();
  notify();
  if (end && s.token) {
    sim.fetch(`${s.base}/api/s/${s.id}`, { method: "DELETE", headers: { "X-Sync-Token": s.token } }).catch(error => log("无法结束分享", error));
  }
  const state = player.state;
  const kept = state.queue.filter(track => track.source !== scheme);
  if (kept.length !== state.queue.length) {
    const keepsCurrent = state.current && state.current.source !== scheme;
    await (kept.length ? player.setQueue(kept, keepsCurrent ? {} : { play: false }) : player.clearQueue());
  }
  if (message) sim.ui.toast(message);
};

const server = () => String(sim.settings.get("server", "")).trim().replace(/\/+$/, "");

const create = async password => {
  if (!server()) {
    sim.ui.alert("请先在设置中填写服务器地址。");
    return;
  }
  const headers = { "Content-Type": "application/json" };
  const key = String(sim.settings.get("serverKey", "")).trim();
  if (key) headers["X-Sync-Key"] = key;
  try {
    const response = await sim.fetch(server() + "/api/sessions", { method: "POST", headers, body: JSON.stringify({ client: clientId, password }) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const result = response.json();
    await start({ base: server(), id: result.id, password, token: result.token });
  } catch (error) {
    log("无法创建分享", error);
    sim.ui.alert("无法创建分享，请检查服务器地址与密钥。");
  }
};

const join = async link => {
  const target = parseLink(link);
  if (!target) {
    sim.ui.toast("链接无效");
    return;
  }
  try {
    const response = await sim.fetch(`${target.base}/api/s/${target.id}`, {});
    if (response.status === 404) {
      sim.ui.toast("分享已结束");
      return;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    let password = "";
    if (response.json().password) {
      password = await sim.dialog.prompt("加入分享", "密码", "");
      if (!password) return;
    }
    await start({ ...target, password, token: "" });
  } catch (error) {
    log("无法加入分享", error);
    sim.ui.toast("无法连接服务器");
  }
};

// ---------- 页面 ----------

const status = () => ({
  type: "status", busy, server: !!server(),
  session: session && {
    link: session.link, host: !!session.token, members: session.members, locked: !!session.password,
    playing: player.state.current ? [player.state.current.title, player.state.current.artist].filter(Boolean).join(" - ") : ""
  }
});
const notify = () => { if (panel && !panel.closed) panel.postMessage(status()); };
const run = async job => {
  if (busy) return;
  busy = true;
  notify();
  try { await job(); } finally { busy = false; notify(); }
};

exports.getSidebar = () => ({ tools: [{ id: "musicSync", name: "一起听", icon: "EE05" }] });

exports.onSidebarOpen = id => {
  if (id !== "musicSync") return null;
  panel = new sim.webview.panel({ url: "ext://page/index.html", backgroundColor: "#FFFFFF" });
  panel.onclose = () => { panel = null; };
  panel.onmessage = event => {
    if (event.origin !== "ext://") return;
    const data = event.data || {};
    if (data.type === "ready") notify();
    if (data.type === "create") run(() => create(String(data.password || "")));
    if (data.type === "join") run(() => join(data.link));
    if (data.type === "leave") run(() => leave(true));
    if (data.type === "copy" && session) {
      sim.clipboard.writeText(session.link);
      sim.ui.toast("已复制链接");
    }
  };
};

exports.getSettings = () => [
  { type: "text", key: "server", label: "服务器地址", default: "" },
  { type: "text", key: "serverKey", label: "服务器密钥", default: "" }
];

// 应用重新启动时回到上次的分享；它已结束时作罢。
exports.init = () => {
  const saved = sim.settings.get("session", null);
  if (saved && saved.base && saved.id) setTimeout(() => start(saved).catch(error => log("无法回到分享", error)), 0);
};
