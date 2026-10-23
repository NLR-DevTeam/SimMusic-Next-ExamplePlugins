// 一起听页面：没在分享里时给出两个入口，点开后在页面中间的卡片里完成；分享中显示状态。操作都交给扩展脚本。
const post = data => simHost.postMessage(data);
let server = false;

const showPopup = popup => {
    document.querySelectorAll(".popup").forEach(item => item.classList.toggle("shown", item === popup));
    document.body.classList.toggle("popupOpen", !!popup);
    if (popup) popup.querySelector("input").focus();
};
document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => showPopup(null));
// 点卡片外面或按 Esc 收起。
popupLayer.onpointerdown = event => { if (event.target === popupLayer) showPopup(null); };
addEventListener("keydown", event => { if (event.key === "Escape") showPopup(null); });

simHost.onmessage = event => {
    const data = event.data;
    if (!data || data.type !== "status") return;
    const session = data.session;
    server = data.server;
    idleView.hidden = !!session;
    sessionView.hidden = !session;
    createButton.disabled = confirmJoinButton.disabled = leaveButton.disabled = data.busy;
    if (!session) return;
    showPopup(null);
    sessionStatus.textContent = `${session.host ? "正在分享" : "已加入分享"} · ${session.members} 人在线`;
    nowTitle.textContent = session.playing || "";
    leaveButton.textContent = session.host ? "结束分享" : "退出分享";
};

// 没有设置服务器时直接交给扩展，由它提示。
shareButton.onclick = () => server ? showPopup(sharePopup) : post({ type: "create", password: "" });
joinButton.onclick = () => showPopup(joinPopup);
createButton.onclick = () => post({ type: "create", password: passwordInput.value });
confirmJoinButton.onclick = () => post({ type: "join", link: linkInput.value });
passwordInput.onkeydown = event => { if (event.key === "Enter") createButton.click(); };
linkInput.onkeydown = event => { if (event.key === "Enter") confirmJoinButton.click(); };
copyButton.onclick = () => post({ type: "copy" });
leaveButton.onclick = () => post({ type: "leave" });
post({ type: "ready" });
