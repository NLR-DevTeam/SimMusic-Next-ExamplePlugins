(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
    const codes = { play:"F00B", plus:"EA13", like:"EE0F", liked:"EE0F", folder:"ED6E", refresh:"F064", user:"F264", back:"EA64", more:"EF79", calendar:"EB27", arrow:"EA6E", edit:"EC86", trash:"EC2A", lock:"EECE", close:"EB99", check:"EB7B" };
    const icon = name => `<i>${String.fromCodePoint(parseInt(codes[name] || name,16))}</i>`;
    const placeholder = "/.sim/assets/placeholder.png";
    const cover = (url,classes="",lazy=true) => `<img class="${classes}" src="${escape(url || placeholder)}" alt="" ${lazy?'loading="lazy"':""} draggable="false">`;
    const light = (label,action,classes="",extra="") => `<div class="clickable ${classes}" data-action="${action}" ${extra}>${label}</div>`;
    const button = (label,action,sub=true,extra="") => `<button ${sub?'class="sub"':""} data-action="${action}" ${extra}>${label}</button>`;
    const formatDuration = seconds => `${Math.floor(seconds/60)||0}:${String(Math.floor(seconds%60)||0).padStart(2,"0")}`;
    const formatCount = count => count>=100000000?(count/100000000).toFixed(1)+"亿":count>=10000?(count/10000).toFixed(1)+"万":String(count||0);
    const centeredText = value => String(value??"").replace(/[。．.!！?？,，;；:：、…\s]+$/u,"");
    const pending = new Map(), history = [], selected = new Set(), liked = new Set(), likesBusy = new Set(), rowOperations = new Map();
    const client = Date.now().toString(36)+Math.random().toString(36).slice(2);
    let serial=0,generation=0,bootGeneration=0,info={},route={tab:"home"},result={},songs=[],lists=[],current=null,loading=false,formBusy=false,anchor=-1,filter="",pendingPlay=null,playSerial=0,playerState={},loadTimer,libraryTimer,moreFailed=false;
    const request = (action,data={}) => new Promise((resolve,reject)=>{
        const token=++serial,timer=setTimeout(()=>{pending.delete(token);reject(Object.assign(new Error("服务响应超时，请重试。"),{kind:"timeout"}));},["dialogForm","dialogPrompt","dialogConfirm"].includes(action)?310000:45000);
        pending.set(token,{resolve,reject,timer});simHost.postMessage({...data,action,request:token,client});
    });
    su5.toast = text => request("toast",{text:String(text)}).catch(()=>{});
    const toast = text => su5.toast(String(text));
    const busy = (element,value) => {
        if(!element)return;
        element.classList.toggle("disabled",value);
        if(element.tagName==="BUTTON")element.disabled=value;
    };
    const run = async (element,work) => {
        if(element?.disabled || element?.classList.contains("disabled"))return;
        busy(element,true);
        try{return await work();}
        catch(error){if(error.kind==="auth"){info.user=null;updateAccount();toast("请先登录网易云账号");login();}else if(error.kind==="setup")connect();else toast(error.message||"操作失败，请重试。");}
        finally{if(element?.isConnected)busy(element,false);}
    };
    const closeDropdowns = () => document.querySelectorAll(".dropdown.active").forEach(element=>su5.dropDown.hide(element));
    const menuItem = (text,action,code,extra="",danger=false) => `<div class="clickable ${danger?"danger":""}" data-action="${action}" ${extra}>${icon(code)} <span>${escape(text)}</span></div>`;
    const updateAccount = () => {
        $("accountAvatar").src=info.user?.avatar||placeholder;$("accountName").textContent=info.user?.name||"登录账号";
        $("accountName").title=info.user?.name||"登录账号";
        $("accountDropdown").innerHTML=`<div class="profileSummary">${cover(info.user?.avatar)}<span><p>${escape(info.user?.name||"未登录")}</p><small>${info.user?"网易云音乐账号":"登录后同步你的音乐"}</small></span></div>${menuItem(info.user?"切换账号":"登录账号","login","user")}${menuItem("API 端点配置","connect","folder")}${info.user?menuItem("退出登录","disconnect","close","",true):""}`;
    };
    const titleFor = () => ({home:"网易云",daily:"每日推荐",liked:"喜欢的音乐",collection:"收藏歌单",owned:"我的歌单",playlist:result.playlist?.name||"歌单"})[route.tab]||"网易云";
    const updateScrollTitle = () => document.querySelector(".pageHeader").classList.toggle("hasScrolled",$("content").scrollTop>24);
    const header = () => {
        $("pageTitle").textContent=titleFor();
        $("pageTitle").title=$("pageTitle").textContent;
        $("backControl").hidden=history.length===0;
        updateScrollTitle();
    };
    const showForm = ({title,subtitle="",items,submit="保存",save}) => run(null,async()=>{
        closeDropdowns();let fields=items;
        for(;;){
            const values=await request("dialogForm",{form:{title,subtitle,items:fields,submit}});
            if(!values)return;
            try{await save(values);return;}
            catch(error){
                const again=await request("dialogConfirm",{text:`保存失败：${error.message}。是否重新编辑？`});
                if(!again)return;
                fields=fields.map(field=>({...field,value:values[field.name]??field.value??""}));
            }
        }
    });
    const nativeInput = (config,save) => {
        if(formBusy)return;
        return run(null,async()=>{
            formBusy=true;closeDropdowns();let value=config.value||"";
            try{
                for(;;){
                    const answer=await request("dialogPrompt",{...config,value});
                    if(answer===null)return;
                    value=answer;
                    try{await save(answer);return;}
                    catch(error){if(!await request("dialogConfirm",{text:`保存失败：${centeredText(error.message)}。是否重新编辑？`}))return;}
                }
            }finally{formBusy=false;}
        });
    };
    const connect = () => info.canForm?showForm({title:"连接网易云 API",items:[{name:"endpoint",type:"input",placeholder:"API 地址，例如 https://api.example.com",value:info.endpoint||""}],submit:"连接",save:values=>request("connect",values)}):nativeInput({title:"API 端点配置",placeholder:"API 地址，例如 https://api.example.com",value:info.endpoint||""},endpoint=>request("connect",{endpoint}));
    const login = () => {
        closeDropdowns();if(!info.endpoint){connect();return;}
        run(null,async()=>{await request("login",{switchAccount:!!info.user});toast("请在窗口中完成登录");});
    };
    const createdList = async values => {
        const created=await request("createPlaylist",{name:values.name,private:values.private==="10"});toast("歌单已创建");
        navigate("playlist",created.id);
    };
    const showEditMenu = (event,html,entry=null) => {
        closeDropdowns();const menu=$("editDropdown");menu.entry=entry;menu.innerHTML=html;su5.dropDown.show(menu,event.clientX,event.clientY);
    };
    const createList = event => {
        if(info.canForm)return showForm({title:"新建歌单",subtitle:"歌单将同步到你的网易云账号。",submit:"创建",items:[{name:"name",type:"input",placeholder:"为歌单起一个名字"},{name:"private",type:"select",value:"0",options:{"0":"公开歌单","10":"私密歌单"}}],save:createdList});
        showEditMenu(event,menuItem("新建公开歌单","createPublic","folder")+menuItem("新建私密歌单","createPrivate","lock"));
    };
    const saveList = async (entry,values) => {await request("editPlaylist",{id:entry.id,...values});toast("歌单已保存");await load(false,true);};
    const editList = (entry,event) => {
        if(info.canForm)return showForm({title:"编辑歌单",items:[{name:"name",type:"input",placeholder:"歌单名称",value:entry.name},{name:"description",type:"textarea",placeholder:"介绍一下这个歌单",value:entry.description||"",allowEmpty:true}],save:values=>saveList(entry,values)});
        showEditMenu(event,menuItem("修改歌单名称","renameList","edit")+menuItem("编辑歌单简介","describeList","edit")+(entry.description?menuItem("清空歌单简介","clearDescription","trash"):""),entry);
    };
    const confirmAction = (title,text,submit,work) => run(null,async()=>{if(await request("dialogConfirm",{text}))await work();});
    const deleteList = entry => confirmAction("删除歌单",`删除「${entry.name}」？网易云账号中的这个歌单也会被删除，歌曲本身不受影响。`,"删除",async()=>{await request("deletePlaylist",{id:entry.id});toast("歌单已删除");if(route.tab==="playlist"&&route.id===entry.id)navigate("owned");else await load(false,true);});
    const removeSongs = () => {
        const ids=[...selected];if(!ownPlaylist()||!ids.length)return;
        confirmAction("从歌单移除",`将选中的 ${ids.length} 首歌曲从「${result.playlist.name}」移除？`,"移除",()=>waitForSongs(ids,async()=>{await request("removeSongs",{id:route.id,ids});selected.clear();toast("已从歌单移除");await load(false,true);}));
    };
    const errorView = error => {
        let title="内容加载失败",text=error.message||"网络暂时不可用，请稍后重试。",action="retry",label="重新加载",code="folder";
        if(error.kind==="auth"){title="连接你的网易云音乐";text="登录后即可查看每日推荐、喜欢的音乐和收藏歌单。";action="login";label="登录账号";code="user";}
        if(error.kind==="setup"){title="尚未连接 API 服务";text="填写你使用的网易云 NodeJS API 地址。";action="connect";label="连接服务";}
        if(error.kind==="unsupported"){title="当前服务暂不支持此功能";text="你连接的 API 尚未提供这个接口，更新服务后可以重新加载。";}
        return `<div class="emptyState">${icon(code)}<h2>${escape(centeredText(title))}</h2><p>${escape(centeredText(text))}</p>${button(label,action)}</div>`;
    };
    const empty = (title,text,create=false) => `<div class="emptyState">${icon("folder")}<h2>${escape(centeredText(title))}</h2><p>${escape(centeredText(text))}</p>${create?button("新建歌单","createList",false):""}</div>`;
    const quickEntries = () => `<div class="quickEntries">${[["daily","每日推荐","今天的专属推荐","calendar"],["liked","喜欢的音乐","留住每一次心动","like"],["collection","收藏歌单","你的音乐收藏库","folder"]].map(([tab,title,description,code])=>light(`<div class="entryIcon">${icon(code)}</div><span><h3>${title}</h3><p>${description}</p></span>${icon("arrow")}`,tab,"quickEntry")).join("")}</div>`;
    const playlistCard = entry => `<article class="clickable playlistCard" data-action="playlist" data-id="${entry.id}" data-playlist="${entry.id}"><div class="coverFrame">${cover(entry.cover)}<span class="coverCount">${icon("play")} ${formatCount(entry.plays)}</span>${light(icon("play"),"playPlaylist","cardPlay",`data-id="${entry.id}" title="播放歌单"`)}</div>${light(icon("more"),"playlistMenu","cardMore",`data-id="${entry.id}" title="歌单操作"`)}<h3 title="${escape(entry.name)}">${escape(entry.name)}</h3><p class="cardAuthor" data-author-id="${entry.id}" title="${escape(entry.creator)}">${entry.creator?escape(entry.creator):route.tab==="home"?'<span class="skeleton authorPlaceholder"></span>':""}${entry.private?" · 私密":""}</p></article>`;
    const newPlaylistCard = () => `<article class="clickable playlistCard newPlaylistCard" data-action="createList"><div class="coverFrame">${icon("plus")}</div><h3>新建歌单</h3><p>按你的喜好整理音乐</p></article>`;
    const likeControl = id => light(icon(liked.has(id)?"liked":"like"),"like",`rowControl ${liked.has(id)?"isLiked":""} ${likesBusy.has(id)?"disabled":""}`,`data-id="${id}" title="${liked.has(id)?"取消喜欢":"喜欢"}"`);
    const rowActions = id => `<div class="songActions">${likeControl(id)}${light(icon("more"),"songMenu","rowControl",`data-id="${id}" title="歌曲菜单"`)}</div>`;
    const miniSong = song => `<div class="clickable songRow ${current?.source==="ncm"&&current.id===song.id?"current":""} ${pendingPlay?.id===song.id?"pending":""}" data-song="${song.id}">${cover(song.cover)}<span class="miniLoading"><span class="spinner"></span></span><div class="songText"><span class="songName" title="${escape(song.title)}" data-action="song" data-id="${song.id}">${escape(song.title)}</span><span class="songArtist">${escape(song.artist||"未知歌手")}</span></div>${light(icon("play"),"song","rowControl",`data-id="${song.id}" title="播放"`)}${rowActions(song.id)}</div>`;
    const tableRow = (song,index) => `<tr class="trackRow ${selected.has(song.id)?"selected":""} ${current?.source==="ncm"&&current.id===song.id?"current":""} ${pendingPlay?.id===song.id?"pending":""} ${song.unavailable?"unavailable":""}" data-song="${song.id}"><td><span class="rowIndex">${String(index+1).padStart(2,"0")}</span>${light(icon("play"),"song","rowPlay",`data-id="${song.id}" title="播放"`)}<span class="spinner rowSpinner"></span></td><td><div class="songIdentity">${cover(song.cover)}<span class="songText"><span class="songName" title="${escape(song.title)}" data-action="song" data-id="${song.id}">${escape(song.title)}</span><span class="songArtist">${escape(song.artist||"未知歌手")}</span></span></div></td><td class="albumColumn" title="${escape(song.album)}">${escape(song.album||"—")}</td><td class="durationColumn">${formatDuration(song.duration)}</td><td>${rowActions(song.id)}</td></tr>`;
    const table = () => `<div class="tableToolbar"><span class="selectionCount" id="selectionCount">${result.total??songs.length} 首歌曲</span><div class="input allowEmpty"><i>&#xF0D1;</i><input id="filterInput" placeholder="筛选歌曲、歌手" value="${escape(filter)}"><i class="clickable"></i></div></div><div class="musicWrapper"><table class="trackTable"><thead><tr><th>#</th><th>歌曲</th><th class="albumColumn">专辑</th><th class="durationColumn">时长</th><th></th></tr></thead><tbody>${songs.map(tableRow).join("")}</tbody></table></div>`;
    const ownPlaylist = () => route.tab==="playlist"&&result.playlist?.owner===info.user?.id&&result.playlist?.special!==5;
    const summary = () => {
        const entry=result.playlist,title=route.tab==="daily"?"今天，为你推荐":route.tab==="liked"?"我喜欢的音乐":entry?.name||"歌单";
        const description=entry?.description||(route.tab==="daily"?"根据你的聆听偏好，每天带来新的音乐。":route.tab==="liked"?"点击红心喜欢的歌曲，会同步保存在这里。":"");
        const visual=entry?cover(entry.cover,"summaryCover",false):`<div class="summaryCover summarySymbol">${icon(route.tab==="daily"?"calendar":"like")}</div>`;
        return `<section class="listSummary">${visual}<div class="summaryText"><h2 title="${escape(title)}">${escape(title)}</h2><p>${escape(description)}</p><div class="summaryActions"><div class="buttonGroup">${button(icon("F508")+" 全部播放","playAll",false,songs.length&&info.canPlay?"":"disabled")}<button class="sub squareButton" data-action="appendAll" title="添加到播放队列" ${songs.length&&info.canPlay?"":"disabled"}>${icon("F00F")}</button></div>${ownPlaylist()?light(icon("edit")+" 编辑信息","editList","lightAction")+light(icon("more"),"playlistMenu","roundControl",`data-id="${route.id}" title="歌单操作"`):route.tab==="playlist"?button(entry?.subscribed?"已收藏":"收藏歌单","subscribe"):""}${ownPlaylist()?`<span id="removeSelected" ${selected.size?"":"hidden"}>${light("移除所选","removeSongs","lightAction")}</span>`:""}</div></div></section>`;
    };
    const draw = () => {
        header();let html="";
        if(route.tab==="home"){
            html=quickEntries()+(result.errors||[]).map(error=>`<div class="inlineError"><span>${escape(error.section)}：${escape(error.message)}</span>${button("重试","retry")}</div>`).join("");
            html+=`<div class="sectionHeading"><h2>推荐歌单</h2><small>${lists.length} 个歌单</small></div>${lists.length?`<div class="playlistGrid">${lists.map(playlistCard).join("")}</div>`:empty("暂无推荐歌单","稍后刷新试试。")}<div class="sectionHeading"><h2>推荐新歌</h2><small>发现新的旋律</small></div><div class="newSongs">${songs.map(miniSong).join("")}</div>`;
        }else if(["collection","owned"].includes(route.tab)){
            html=`<div class="tabsAndActions"><div class="segmentTabs">${light("收藏歌单","collection",route.tab==="collection"?"active":"")}${light("我创建的","owned",route.tab==="owned"?"active":"")}</div>${button(icon("plus")+" 新建歌单","createList")}</div><div class="playlistGrid">${route.tab==="owned"?newPlaylistCard():""}${lists.map(playlistCard).join("")}</div>`;
            if(!lists.length&&!result.more&&route.tab!=="owned")html+=empty("这里还没有歌单","你在网易云收藏或创建的歌单会出现在这里。");
        }else html=summary()+(songs.length?table():empty(route.tab==="liked"?"还没有喜欢的音乐":"这里还没有歌曲",route.tab==="playlist"&&ownPlaylist()?"从歌曲菜单选择收藏到歌单，为这里添加第一首音乐。":"在歌曲旁点击红心，或稍后刷新试试。"));
        if(result.more)html+='<div id="moreSentinel" class="moreSentinel">正在加载更多</div>';
        $("content").innerHTML=html;
        if($("filterInput"))su5.form.init($("filterInput").parentElement);
        updateSelection();applyFilter();updatePending();
    };
    const hydratePage = ticket => {
        if(route.tab==="home"){
            const ids=lists.filter(entry=>!entry.creator).map(entry=>entry.id);
            if(ids.length)request("playlistAuthors",{ids}).then(authors=>{
                if(ticket!==generation)return;
                authors.forEach(author=>{const entry=lists.find(item=>item.id===author.id);if(entry)entry.creator=author.creator;const label=document.querySelector(`[data-author-id="${author.id}"]`);if(label){label.textContent=author.creator||"";label.title=author.creator||"";}});
            }).catch(()=>{if(ticket===generation)document.querySelectorAll('.cardAuthor .authorPlaceholder').forEach(element=>element.remove());});
        }
        if(info.user&&songs.length)request("likes").then(ids=>{if(ticket===generation){liked.clear();ids.forEach(id=>liked.add(id));updateLikes();}}).catch(()=>{});
    };
    const moreObserver = new IntersectionObserver(entries=>{
        if(entries.some(entry=>entry.isIntersecting)&&result.more&&!loading&&!moreFailed)load(true);
    },{root:$("content"),rootMargin:"0px 0px 360px 0px",threshold:0});
    const observeMore = () => {
        moreObserver.disconnect();
        const sentinel=$("moreSentinel");
        if(sentinel&&result.more&&!moreFailed)moreObserver.observe(sentinel);
    };
    const skeleton = () => {
        const columns=Math.max(2,Math.floor(($("content").clientWidth-56)/165));
        const cards=Array.from({length:columns*(route.tab==="home"?1:2)},()=>'<div class="loadingPoster"><div class="skeleton"></div><div class="skeleton loadingLine"></div><div class="skeleton loadingLine short"></div></div>').join("");
        const rows=Array.from({length:7},()=>'<div class="loadingRow"><div class="skeleton loadingThumb"></div><div class="loadingWords"><div class="skeleton"></div><div class="skeleton"></div></div></div>').join("");
        if(route.tab==="home")return quickEntries()+`<div class="sectionHeading"><h2>推荐歌单</h2></div><div class="loadingCards">${cards}</div><div class="sectionHeading"><h2>推荐新歌</h2></div><div class="loadingRows">${rows}</div>`;
        if(["collection","owned"].includes(route.tab))return `<div class="loadingCards">${cards}</div>`;
        return `<div class="loadingProfile"><div class="skeleton loadingCover"></div><div class="loadingWords"><div class="skeleton"></div><div class="skeleton"></div></div></div><div class="loadingRows">${rows}</div>`;
    };
    const load = async (append=false,refresh=false) => {
        const keepContent=!append&&refresh&&result.tab===route.tab&&(route.tab!=="playlist"||result.playlist?.id===route.id);
        const ticket=++generation,oldOffset=result.offset;loading=true;moreFailed=false;moreObserver.disconnect();$("refreshControl").classList.add("busy");closeDropdowns();clearTimeout(loadTimer);header();
        if(append&&$("moreSentinel")){const sentinel=$("moreSentinel");sentinel.textContent="正在加载更多";sentinel.classList.remove("clickable");sentinel.onclick=null;}
        if(!append){selected.clear();if(!keepContent){filter="";result={};songs=[];lists=[];$("content").innerHTML="";$("content").scrollTop=0;updateScrollTitle();loadTimer=setTimeout(()=>{if(ticket===generation)$("content").innerHTML=skeleton();},100);}}
        try{
            const value=await request("load",{...route,refresh,offset:append?oldOffset:0});if(ticket!==generation)return;clearTimeout(loadTimer);
            if(append&&value.more&&!(value.offset>oldOffset))value.more=false;
            songs=[...new Map([...(append?songs:[]),...(value.songs||[])].map(song=>[song.id,song])).values()];lists=[...new Map([...(append?lists:[]),...(value.items||value.playlists||[])].map(item=>[item.id,item])).values()];result=value;draw();
            hydratePage(ticket);
        }catch(error){if(ticket!==generation)return;clearTimeout(loadTimer);if(error.kind==="auth"){info.user=null;updateAccount();}if(append){moreFailed=true;toast(error.message);const sentinel=$("moreSentinel");if(sentinel){sentinel.textContent="加载失败，点击重试";sentinel.classList.add("clickable");sentinel.onclick=()=>load(true);}}else if(keepContent&&!["auth","setup","stale"].includes(error.kind))toast(error.message);else $("content").innerHTML=errorView(error);}
        finally{if(ticket===generation){loading=false;$("refreshControl").classList.remove("busy");observeMore();}}
    };
    const navigate = (tab,id) => {history.push({...route});route={tab,...(id?{id}:{})};$("content").scrollTop=0;load();};
    const back = () => {const previous=history.pop();if(previous){route=previous;load();}};
    const boot = async (preserve=false,refresh=false) => {
        const ticket=++bootGeneration;$("refreshControl").classList.add("busy");
        try{const value=await request("ready",{refresh});if(ticket!==bootGeneration)return;info=value;playerState=value;current=info.current;updateAccount();if(!preserve)route={tab:info.tab};header();if(!info.endpoint){$("content").innerHTML=errorView({kind:"setup"});return;}await load(false,refresh);}
        catch(error){if(ticket===bootGeneration)$("content").innerHTML=errorView(error);}finally{if(ticket===bootGeneration&&!loading)$("refreshControl").classList.remove("busy");}
    };
    const updateLikes = () => document.querySelectorAll('[data-action="like"]').forEach(element=>{const active=liked.has(element.dataset.id);element.classList.toggle("isLiked",active);element.innerHTML=icon(active?"liked":"like");element.title=active?"取消喜欢":"喜欢";busy(element,likesBusy.has(element.dataset.id));});
    const waitForSongs = async (ids,work) => {
        ids.forEach(id=>rowOperations.set(id,(rowOperations.get(id)||0)+1));updatePending();
        try{return await work();}finally{ids.forEach(id=>{const count=(rowOperations.get(id)||1)-1;count?rowOperations.set(id,count):rowOperations.delete(id);});updatePending();}
    };
    const changeLike = async id => {if(likesBusy.has(id))return;likesBusy.add(id);updateLikes();await waitForSongs([id],()=>run(null,async()=>{const value=await request("like",{id,liked:!liked.has(id)});value.liked?liked.add(id):liked.delete(id);toast(value.liked?"已加入喜欢":"已取消喜欢");}));likesBusy.delete(id);updateLikes();if(route.tab==="liked"&&!liked.has(id))load(false,true);};
    const contextPayload = () => ({...route,...(route.tab==="home"?{ids:songs.map(song=>song.id)}:{})});
    const updatePending = () => {
        document.querySelectorAll("[data-song]").forEach(row=>row.classList.toggle("pending",rowOperations.has(row.dataset.song)||(!pendingPlay?.playlist&&!!pendingPlay?.id&&pendingPlay.id===row.dataset.song)));
        document.querySelectorAll("[data-playlist]").forEach(card=>card.classList.toggle("pending",!!pendingPlay?.playlist&&pendingPlay.playlist===card.dataset.playlist));
    };
    const playbackFailed = () => {pendingPlay=null;updatePending();su5.toast("歌曲播放失败");};
    const startPlay = async (id,extra=null) => {
        const payload=extra||contextPayload(),target=id||(extra?null:songs[0]?.id),token=++playSerial;
        pendingPlay={id:target,playlist:extra?.tab==="playlist"?extra.id:null,token,seen:false,accepted:false};updatePending();
        try{const value=await request("play",{...payload,song:target});if(pendingPlay?.token===token){pendingPlay.id=value.id||target;pendingPlay.accepted=true;updatePending();applyPlayer(playerState);}}
        catch(error){if(pendingPlay?.token===token)playbackFailed();}
    };
    const applyPlayer = state => {
        playerState=state;
        current=state.current;document.querySelectorAll("[data-song]").forEach(row=>row.classList.toggle("current",current?.source==="ncm"&&current.id===row.dataset.song));
        if(!pendingPlay)return;
        if(current?.source==="ncm"&&current.id===pendingPlay.id){pendingPlay.seen=true;if(!state.loading&&(state.playing||pendingPlay.accepted)){pendingPlay=null;updatePending();}}
        else if(pendingPlay.seen){if(!current)playbackFailed();else{pendingPlay=null;updatePending();}}
    };
    const updateSelection = () => {
        document.querySelectorAll(".trackRow").forEach(row=>row.classList.toggle("selected",selected.has(row.dataset.song)));
        if($("selectionCount"))$("selectionCount").textContent=selected.size?`已选 ${selected.size} 首`:`${result.total??songs.length} 首歌曲`;
        if($("removeSelected"))$("removeSelected").hidden=!ownPlaylist()||!selected.size;
    };
    const selectRow = (id,event,right=false) => {
        const index=songs.findIndex(song=>song.id===id);if(index<0)return;
        if(right&&selected.has(id))return;
        if(event.shiftKey&&anchor>=0){if(!event.ctrlKey)selected.clear();songs.slice(Math.min(anchor,index),Math.max(anchor,index)+1).forEach(song=>selected.add(song.id));}
        else if(event.ctrlKey||event.metaKey){selected.has(id)?selected.delete(id):selected.add(id);anchor=index;}
        else{selected.clear();selected.add(id);anchor=index;}updateSelection();
    };
    const showSongMenu = (id,event={}) => {
        selectRow(id,event,true);if(!selected.has(id)){selected.clear();selected.add(id);updateSelection();}
        const ids=result.ids||songs.map(song=>song.id),chosen=[...selected];
        closeDropdowns();waitForSongs(chosen,()=>run(null,()=>request("songMenu",{...contextPayload(),ids,selected:chosen})));
    };
    const showPlaylistMenu = (id,event) => {
        const entry=lists.find(item=>item.id===id)||(result.playlist?.id===id?result.playlist:null);if(!entry)return;
        const own=info.user?.id===entry.owner&&entry.special!==5,dropdown=$("playlistDropdown");dropdown.entry=entry;
        dropdown.innerHTML=menuItem("打开歌单","playlist","folder",`data-id="${id}"`)+(own?menuItem("编辑信息","editCard","edit")+menuItem("删除歌单","deleteCard","trash","",true):menuItem(entry.subscribed?"取消收藏":"收藏歌单","subscribeCard","folder"));
        su5.dropDown.show(dropdown,event.clientX,event.clientY);
    };
    const applyFilter = () => document.querySelectorAll(".trackRow").forEach((row,index)=>row.hidden=![songs[index]?.title,songs[index]?.artist,songs[index]?.album].join(" ").toLowerCase().includes(filter.toLowerCase()));
    document.addEventListener("click",event=>{
        const target=event.target.closest("[data-action]"),row=event.target.closest(".trackRow");
        if(!target){if(row)selectRow(row.dataset.song,event);return;}if(target.disabled||target.classList.contains("disabled"))return;
        const {action,id}=target.dataset;
        if(row&&action==="song"&&(event.ctrlKey||event.metaKey||event.shiftKey)){selectRow(id,event);return;}
        if(target.closest(".dropdown"))closeDropdowns();
        if(["daily","liked","collection","owned"].includes(action))navigate(action);
        else if(action==="playlist")navigate("playlist",id);
        else if(action==="retry")boot(true,true);
        else if(action==="connect")connect();
        else if(action==="login")login();
        else if(action==="disconnect")run(null,async()=>{const value=await request("disconnect");toast(value.customCookie?"网页登录已清除，自定义 Header 中的 Cookie 保持不变。":"已断开网页登录");});
        else if(action==="like")changeLike(id);
        else if(action==="createList")createList(event);
        else if(action==="createPublic"||action==="createPrivate")nativeInput({title:action==="createPrivate"?"新建私密歌单":"新建公开歌单",placeholder:"为歌单起一个名字"},name=>createdList({name,private:action==="createPrivate"?"10":"0"}));
        else if(action==="editList")editList(result.playlist,event);
        else if(action==="renameList"||action==="describeList"){
            const entry=$("editDropdown").entry,field=action==="renameList"?"name":"description";
            if(entry)nativeInput({title:field==="name"?"修改歌单名称":"编辑歌单简介",placeholder:field==="name"?"歌单名称":"歌单简介",value:entry[field]||""},value=>saveList(entry,{[field]:value}));
        }
        else if(action==="clearDescription"){const entry=$("editDropdown").entry;if(entry)confirmAction("清空歌单简介",`清空「${entry.name}」的歌单简介？`,"清空",()=>saveList(entry,{description:""}));}
        else if(action==="deleteList")deleteList(result.playlist);
        else if(action==="removeSongs")removeSongs();
        else if(action==="editCard")editList($("playlistDropdown").entry,event);
        else if(action==="deleteCard")deleteList($("playlistDropdown").entry);
        else if(action==="playlistMenu")showPlaylistMenu(id,event);
        else if(action==="songMenu")showSongMenu(id,event);
        else if(action==="song"||action==="playAll"){if(row)selectRow(id,event);startPlay(id);}
        else if(action==="playPlaylist")startPlay(null,{tab:"playlist",id});
        else if(action==="appendAll")waitForSongs(songs[0]?[songs[0].id]:[],()=>run(target,async()=>{await request("play",{...contextPayload(),mode:"append"});toast("已加入播放队列");}));
        else if(action==="subscribe"||action==="subscribeCard")run(target,async()=>{const entry=action==="subscribe"?result.playlist:$("playlistDropdown").entry;await request("subscribe",{id:entry.id,subscribed:!entry.subscribed});toast(entry.subscribed?"已取消收藏":"已收藏歌单");await load(false,true);});
    });
    document.addEventListener("dblclick",event=>{const row=event.target.closest("[data-song]");if(row&&!event.target.closest("[data-action]"))startPlay(row.dataset.song);});
    document.addEventListener("contextmenu",event=>{const row=event.target.closest("[data-song]"),card=event.target.closest("[data-playlist]");if(row){event.preventDefault();showSongMenu(row.dataset.song,event);}else if(card){event.preventDefault();showPlaylistMenu(card.dataset.playlist,event);}else if(event.target.closest("#accountControl")){event.preventDefault();closeDropdowns();su5.dropDown.show($("accountDropdown"),event.clientX,event.clientY);}});
    document.addEventListener("input",event=>{if(event.target.id==="filterInput"){filter=event.target.value;applyFilter();}});
    document.addEventListener("keydown",event=>{if(event.target.closest("input,textarea,select")||document.querySelector(".modalContainer[open]"))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"&&document.querySelector(".trackTable")){event.preventDefault();songs.forEach(song=>selected.add(song.id));updateSelection();}});
    document.addEventListener("error",event=>{if(event.target.tagName==="IMG"&&!event.target.src.endsWith(placeholder))event.target.src=placeholder;},true);
    simHost.addEventListener("message",event=>{
        const data=event.data||{};
        if(data.reply){const value=pending.get(data.reply);if(!value)return;clearTimeout(value.timer);pending.delete(data.reply);data.error?value.reject(Object.assign(new Error(data.error.message),{kind:data.error.kind})):value.resolve(data.result);}
        else if(data.type==="accountChanged"){generation++;liked.clear();result={};songs=[];lists=[];$("content").innerHTML="";boot(true);}
        else if(data.type==="profileChanged"){info.user=data.user;updateAccount();}
        else if(data.type==="pagesInvalidated"){generation++;boot(true);}
        else if(data.type==="pageUpdated"){
            const root=`${route.tab}:${route.id||""}`,value=data.value;
            if(data.root!==root||data.offset!==0||loading||(result.offset||0)>(value.offset||0))return;
            const scroll=$("content").scrollTop;
            result=value;songs=value.songs||[];lists=value.items||value.playlists||[];
            const ids=new Set(songs.map(song=>song.id));for(const id of selected)if(!ids.has(id))selected.delete(id);
            draw();$("content").scrollTop=scroll;updateScrollTitle();observeMore();hydratePage(generation);
        }
        else if(data.type==="likedChanged"){data.liked?liked.add(data.id):liked.delete(data.id);updateLikes();}
        else if(data.type==="songsBusy"){
            (data.ids||[]).forEach(id=>{const count=(rowOperations.get(id)||0)+(data.busy?1:-1);if(count>0)rowOperations.set(id,count);else rowOperations.delete(id);});updatePending();
            if(!data.busy&&route.tab==="liked"){clearTimeout(libraryTimer);libraryTimer=setTimeout(()=>{if(!loading)load(false,true);},150);}
        }
        else if(data.type==="player")applyPlayer(data);
        else if(data.type==="libraryChanged"){
            if(data.kind==="deleted"&&route.tab==="playlist"&&route.id===data.id){navigate("owned");return;}
            if(["collection","owned"].includes(route.tab)||(route.tab==="playlist"&&route.id===data.id)){
                clearTimeout(libraryTimer);libraryTimer=setTimeout(()=>{if(!loading)load(false,true);},150);
            }
        }
    });
    $("backControl").onclick=back;$("refreshControl").onclick=()=>{if(!loading)boot(true,true);};
    $("content").addEventListener("scroll",updateScrollTitle,{passive:true});
    su5.dropDown.create($("accountDropdown"),$("accountControl"));
    boot();
})();
