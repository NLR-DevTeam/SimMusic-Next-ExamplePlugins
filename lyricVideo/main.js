// 歌词 MV 播放页本身在 mv.html 中，经宿主的 simPlayer 读取状态、控制播放。
// 这里只提供它的几项设置：保存在扩展自己的 settings.json，页面加载时索取，更改时推送给页面。
const items = [
  { type: "select", key: "font", label: "歌词字体", options: [{ value: "serif", label: "默认" }, { value: "sans", label: "跟随界面字体" }], default: "serif" },
  { type: "text", key: "fontName", label: "自定义歌词字体", desc: "填写本机已安装字体的名称，例如「思源宋体 Heavy」；填写后优先于上面的选项，留空则不使用。", default: "" },
  { type: "select", key: "layout", label: "歌词版式", desc: "「默认规则」按每句的长短在几种版式之间变换；也可以让所有歌词固定用一种。", options: [{ value: "auto", label: "默认规则" }, { value: "center", label: "横排" }, { value: "stack", label: "上小下大两行" }, { value: "vertical", label: "竖排" }], default: "auto" },
  { type: "toggle", key: "perWord", label: "逐字歌词", desc: "歌曲带有逐字歌词时，整句一起出现，没唱到的部分半透明，随演唱逐渐显现；关闭后所有歌词都逐字淡入。", default: true },
  { type: "toggle", key: "particles", label: "光斑粒子", desc: "在背景上绘制漂浮的光斑；关闭可减少对硬件资源的占用。", default: true },
  { type: "toggle", key: "ghost", label: "背景大字", default: true },
  { type: "toggle", key: "grain", label: "胶片颗粒", default: true },
  { type: "toggle", key: "shake", label: "镜头律动", desc: "换句时让画面随之轻微推拉。", default: true },
];
const publish = () => sim.playPage.postMessage({ type: "settings", values: Object.fromEntries(items.map((item) => [item.key, sim.settings.get(item.key, item.default)])) });

module.exports = {
  getSettings: () => items,
  onSettingChange: publish,
  onPlayPageMessage: (id, data) => { if (data && data.type === "settings") publish(); },
};
