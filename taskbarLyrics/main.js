// 任务栏歌词：歌词窗口由随扩展附带的 taskbarLyrics.exe 嵌进系统任务栏（源码在 native/），这里只做两件事：
// 用播放控制（sim.player）跟随播放状态，把该显示的那一句和封面交给它；把它报告的按钮操作交还给播放器。
// 两边经标准输入 / 输出逐行通信，格式见 native/taskbarLyrics.c 开头。
const items = [
  { type: "slider", key: "width", label: "宽度", desc: "歌词区域（含封面）在任务栏上占的宽度，单位是像素，随系统缩放放大。", min: 120, max: 800, default: 280 },
  { type: "select", key: "align", label: "对齐方式", options: [{ value: "left", label: "靠左" }, { value: "center", label: "居中" }, { value: "right", label: "靠右" }], default: "left" },
];
const setting = key => sim.settings.get(key, items.find(item => item.key === key).default);
const clean = text => String(text || "").replace(/[\t\r\n]+/g, " ").trim();
const player = sim.player;

let child = null;
let failures = 0;
let lines = [];
let sentLine = "";
let coverTurn = 0;
let coverPath = "";
let expected = null; // 上次算出的位置与时刻，用来发现跳转

const send = text => { if (child) child.write(text + "\n"); };
const sendOptions = () => send(["opt", Math.round(setting("width")), ["left", "center", "right"].indexOf(setting("align"))].join("\t"));
const isPlaying = () => player.state.playing && !player.state.loading;
const sendStatus = () => {
  const state = player.state;
  send(["state", isPlaying() ? 1 : 0, state.mode, Math.round(state.volume * 100), Math.round((state.speed || 1) * 100)].join("\t"));
};

// 歌词由主程序解析好：有逐字歌词时用它的行（带结束时间），否则一行唱到下一行开始。
const readLyrics = () => {
  const lyrics = player.state.lyrics || {};
  const plain = lyrics.traditional || [];
  lines = (lyrics.perWord ? lyrics.perWord.map(line => ({ start: line.start, end: line.end, text: line.text }))
    : plain.map((line, index) => ({ start: line.time, end: index + 1 < plain.length ? plain[index + 1].time : Math.max(player.state.duration, line.time + 5), text: line.text })))
    .filter(line => clean(line.text));
  sentLine = "";
};

// 封面是主程序给的图片本身，写成文件后由窗口读取。两个文件轮换着用：窗口读上一张时不会正好被覆盖。
const showCover = () => {
  const turn = ++coverTurn;
  const show = path => { if (turn === coverTurn) { coverPath = path; send("cover\t" + path); } };
  if (!player.state.current) { show(""); return; }
  player.cover().then(file => {
    if (turn !== coverTurn) return;
    if (!file) { show(""); return; }
    const path = sim.path.join(sim.plugin.dataDir, "cover-" + (turn % 2));
    sim.fs.writeFile(path, file);
    show(path);
  }).catch(() => show(""));
};

// 该显示哪一句：歌词下面一行是「歌名  艺术家」，没有艺术家信息时只有歌名。
const showLine = () => {
  if (!child) return;
  const state = player.state, track = state.current, position = player.position(), playing = isPlaying();
  let main = "", sub = "", elapsed = 0, total = 0;
  if (track) {
    const artist = track.artist && track.artist !== "未知艺术家" ? clean(track.artist) : "";
    let line = null;
    for (let i = 0; i < lines.length && lines[i].start <= position; i++) line = lines[i];
    if (line) {
      main = clean(line.text);
      sub = [clean(track.title), artist].filter(Boolean).join("  ");
      elapsed = (position - line.start) * 1000;
      total = Math.max(0, line.end - line.start) * 1000;
    } else {
      // 还没唱到第一句，或者这首歌没有歌词：歌名在上，艺术家在下。
      main = clean(track.title);
      sub = artist;
    }
  }
  // 换了一句、播放与暂停之间切换、或者跳转过，才重新告诉窗口这一句唱到了哪里；其间它自己计时。
  const now = Date.now();
  const jumped = expected && Math.abs(position - (expected.position + (expected.playing ? (now - expected.at) / 1000 * (state.speed || 1) : 0))) > .4;
  expected = { position, at: now, playing };
  const text = [main, sub, playing].join("\t");
  if (text !== sentLine || jumped) { sentLine = text; send(["line", Math.round(elapsed), Math.round(total), main, sub].join("\t")); }
};

const control = text => {
  const parts = text.trim().split(" ");
  const done = promise => promise.catch(error => sim.log("播放控制失败", String(error && error.message || error)));
  if (parts[0] === "toggle") done(player.toggle());
  if (parts[0] === "previous") done(player.previous());
  if (parts[0] === "next") done(player.next());
  if (parts[0] === "mode") done(player.cycleMode());
  if (parts[0] === "show") done(player.showWindow());
  if (parts[0] === "menu") done(player.showMenu());
  if (parts[0] === "volume") done(player.setVolume(Math.max(0, Math.min(100, Number(parts[1]) || 0)) / 100));
};

const start = () => {
  if (sim.platform !== "windows" || !sim.plugin.dir) return;
  try {
    child = sim.shell.spawn(sim.path.join(sim.plugin.dir, "taskbarLyrics.exe"));
  } catch (error) {
    sim.log("无法启动任务栏歌词窗口", String(error && error.message || error));
    return;
  }
  const started = Date.now();
  child.onstdout = event => control(event.data);
  child.onexit = event => {
    child = null;
    // 窗口进程意外退出时重新启动；刚启动就退出的连续几次之后不再尝试。
    failures = Date.now() - started < 10000 ? failures + 1 : 0;
    sim.log("任务栏歌词窗口已退出", event.code);
    if (failures < 3) setTimeout(start, 3000);
  };
  // 新窗口什么都不知道：把选项、状态、封面和当前这一句都告诉它。
  sentLine = "";
  expected = null;
  sendOptions();
  sendStatus();
  send("cover\t" + coverPath);
  showLine();
};

module.exports = {
  init: () => {
    player.on("track", () => { showCover(); showLine(); });
    player.on("lyrics", () => { readLyrics(); showLine(); });
    player.on("status", () => { sendStatus(); showLine(); });
    readLyrics();
    showCover();
    start();
    // 换句的时刻落在两次状态报告之间：按连续推算的位置自己看。
    setInterval(showLine, 100);
  },
  getSettings: () => items,
  onSettingChange: () => sendOptions(),
};
