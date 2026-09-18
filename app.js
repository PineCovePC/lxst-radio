const KEY="lxst.identity.v2",CHAT_KEY="lxst.chats.v1",FLAGS_KEY="lxst.flags.v1";
const $=s=>document.querySelector(s);
const state={id:null,tx:false,latch:false,logs:[],stations:[],selected:null,directed:null,chats:{},flags:{},installEvt:null,lastTap:0,sweep:0};
const hex=b=>[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
const shortHash=h=>h.slice(0,8)+"\u2026"+h.slice(-6);
const stamp=()=>new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
function log(line){state.logs=[stamp()+"  "+line,...state.logs].slice(0,40);renderLog();}
function hashNum(s,i=0){let h=2166136261^i;for(let c=0;c<s.length;c++)h=Math.imul(h^s.charCodeAt(c),16777619);return (h>>>0)/4294967295;}
async function hashSeed(seed){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("lxst:"+seed));return hex(new Uint8Array(d)).slice(0,32);}
async function loadIdentity(){try{const raw=localStorage.getItem(KEY);if(raw){const p=JSON.parse(raw);if(p.seed&&p.hash)return p;}}catch{}
const seed=hex(crypto.getRandomValues(new Uint8Array(16)));const hash=await hashSeed(seed);
const id={name:"LXST-"+hash.slice(0,4).toUpperCase(),seed,hash};localStorage.setItem(KEY,JSON.stringify(id));return id;}
function loadChats(){try{state.chats=JSON.parse(localStorage.getItem(CHAT_KEY)||"{}");}catch{state.chats={};}}
function saveChats(){localStorage.setItem(CHAT_KEY,JSON.stringify(state.chats));}
function loadFlags(){try{state.flags=JSON.parse(localStorage.getItem(FLAGS_KEY)||"{}");}catch{state.flags={};}}
function saveFlags(){localStorage.setItem(FLAGS_KEY,JSON.stringify(state.flags));}
function flag(hash){return state.flags[hash]||{pin:false,mute:false};}
const NAMES=["NETTLE","BRAMBLE","FEN","CAIRN","SKERRY","MOSS","TOR","WOLD"];
function seedGhosts(selfHash){return NAMES.map((name,i)=>{const h=hashNum(selfHash,i+3);const a=h*Math.PI*2;const r=0.28+hashNum(selfHash,i+11)*0.55;const hash=(name+selfHash).replace(/[^a-f0-9]/gi,"a").slice(0,8)+hex(crypto.getRandomValues(new Uint8Array(4)));return{hash:hash.slice(0,32).padEnd(32,"0"),name,ghost:true,x:0.5+Math.cos(a)*r*0.42,y:0.5+Math.sin(a)*r*0.42,rssi:Math.round(-40-h*50)};});}
let actx,osc,gain,mic;
async function ensureAudio(){if(!actx)actx=new AudioContext();if(actx.state==="suspended")await actx.resume();return actx;}
function stopTone(){try{osc&&osc.stop();}catch(e){}if(osc)osc.disconnect();if(gain)gain.disconnect();osc=gain=null;}
async function startTx(){const audio=await ensureAudio();stopTone();gain=audio.createGain();gain.gain.value=0.035;gain.connect(audio.destination);osc=audio.createOscillator();osc.frequency.value=920;osc.type="sine";osc.connect(gain);osc.start();try{mic=await navigator.mediaDevices.getUserMedia({audio:true});}catch(e){mic=null;}}
function stopTx(){stopTone();if(mic)mic.getTracks().forEach(t=>t.stop());mic=null;}
function stationByHash(hash){return state.stations.find(s=>s.hash===hash);}
function pushMsg(hash,msg){if(!state.chats[hash])state.chats[hash]={unread:0,msgs:[]};state.chats[hash].msgs.push(msg);if(msg.from==="them"&&state.selected&&state.selected.hash!==hash)state.chats[hash].unread+=1;saveChats();if(!$('#chat-room').hidden&&state.selected&&state.selected.hash===hash)renderMsgs(hash);renderThreads();}
async function setTalk(on){state.tx=on;$("#ptt").classList.toggle("hot",on);$("#ptt-label").textContent=on?"TX":"PTT";if(on){await startTx();log(state.directed?("TX "+shortHash(state.directed)):"TX open");}else{stopTx();log("RX");}renderBars();}
function onPttDown(){const now=Date.now();if(now-state.lastTap<280){state.latch=!state.latch;$("#ptt-cap").textContent=state.latch?"LATCHED":"HOLD / DBL TAP";setTalk(state.latch);}else if(!state.latch)setTalk(true);state.lastTap=now;}
function onPttUp(){if(!state.latch)setTalk(false);}
function setTab(tab){document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));document.querySelectorAll("[data-panel]").forEach(p=>{p.hidden=p.dataset.panel!==tab;});if(tab==="mesh")resizeRadar();if(tab==="chat")renderThreads();}
function renderLog(){$("#log").innerHTML=state.logs.slice(0,6).map(l=>"<div>"+escapeHtml(l)+"</div>").join("");}
function renderBars(){const n=state.tx?4:2;$("#bars").innerHTML=[1,2,3,4].map(i=>"<i class=\""+(i<=n?"on":"")+"\" style=\"height:"+(3+i*2)+"px\"></i>").join("");}
function escapeHtml(s){return String(s).replace(/[&<>\"']/g,c=>({"&":"&","<":"<",">":">","\"":""","'":"&#39;"}[c]));}
function renderThreads(){const el=$("#thread-list");if(!el)return;const rows=Object.keys(state.chats).map(hash=>{const st=stationByHash(hash);const msgs=state.chats[hash].msgs;return{hash,name:(st&&st.name)||shortHash(hash),last:msgs[msgs.length-1],unread:state.chats[hash].unread||0};}).sort((a,b)=>(b.last&&b.last.t||0)-(a.last&&a.last.t||0));el.innerHTML=rows.map(r=>"<button class=\"thread\" data-open=\""+r.hash+"\" type=\"button\"><div><strong>"+escapeHtml(r.name)+"</strong><div class=\"preview\">"+escapeHtml((r.last&&r.last.text)||"")+"</div></div></button>").join("");}
function renderMsgs(hash){const box=$("#msgs");const msgs=(state.chats[hash]&&state.chats[hash].msgs)||[];box.innerHTML=msgs.map(m=>"<div class=\"bubble "+m.from+"\"><div>"+escapeHtml(m.text)+"</div><time>"+new Date(m.t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+"</time></div>").join("");box.scrollTop=box.scrollHeight;}
function openSheet(st){state.selected=st;$("#station-sheet").hidden=false;$("#sheet-name").textContent=st.name;$("#sheet-hash").textContent=shortHash(st.hash);const f=flag(st.hash);$("#sheet-meta").textContent=[st.rssi+" dBm",f.pin?"pinned":"",f.mute?"muted":""].filter(Boolean).join(" \u00b7 ");}
function showRoom(on){$("#chat-home").hidden=on;$("#chat-room").hidden=!on;}
function openChat(st){state.selected=st;if(!state.chats[st.hash])state.chats[st.hash]={unread:0,msgs:[]};state.chats[st.hash].unread=0;saveChats();$("#chat-title").textContent=st.name;$("#chat-sub").textContent=shortHash(st.hash);showRoom(true);setTab("chat");renderMsgs(st.hash);renderThreads();if(st.ghost&&state.chats[st.hash].msgs.length===0){setTimeout(()=>{pushMsg(st.hash,{from:"them",text:st.name+" copies.",t:Date.now()});},400);}}
function resizeRadar(){const c=$("#radar");if(!c||!c.parentElement)return;const size=Math.min(c.parentElement.clientWidth,360);const dpr=Math.min(window.devicePixelRatio||1,2);c.width=size*dpr;c.height=size*dpr;c.style.width=size+"px";}
function drawRadar(){const c=$("#radar");if(!c)return;const g=c.getContext("2d");const w=c.width,h=c.height,cx=w/2,cy=h/2,r=Math.min(w,h)/2-4;g.clearRect(0,0,w,h);g.fillStyle="#07110c";g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.fill();g.strokeStyle="rgba(61,255,138,0.18)";g.lineWidth=1;for(let i=1;i<=4;i++){g.beginPath();g.arc(cx,cy,(r*i)/4,0,Math.PI*2);g.stroke();}g.beginPath();g.moveTo(cx-r,cy);g.lineTo(cx+r,cy);g.moveTo(cx,cy-r);g.lineTo(cx,cy+r);g.stroke();g.save();g.translate(cx,cy);g.rotate(state.sweep);const lg=g.createLinearGradient(0,0,r,0);lg.addColorStop(0,"rgba(61,255,138,0)");lg.addColorStop(1,"rgba(61,255,138,0.28)");g.fillStyle=lg;g.beginPath();g.moveTo(0,0);g.arc(0,0,r,-0.35,0.02);g.closePath();g.fill();g.restore();g.fillStyle="#3dff8a";g.beginPath();g.arc(cx,cy,Math.max(4,w*0.012),0,Math.PI*2);g.fill();for(const st of state.stations){const f=flag(st.hash);if(f.mute)continue;const x=st.x*w,y=st.y*h,sel=state.selected&&state.selected.hash===st.hash;g.fillStyle=st.ghost?"#7f9a86":"#3dff8a";if(f.pin)g.fillStyle="#ffb020";if(sel)g.fillStyle="#fff";g.beginPath();g.arc(x,y,sel?7:5,0,Math.PI*2);g.fill();g.fillStyle="rgba(215,234,217,0.85)";g.font=Math.max(10,w*0.028)+"px ui-sans-serif";g.textAlign="center";g.fillText(st.name,x,y-10);}}
function hitStation(ev){const c=$("#radar");const rect=c.getBoundingClientRect();const x=(ev.clientX-rect.left)/rect.width;const y=(ev.clientY-rect.top)/rect.height;let best=null,bestD=0.07;for(const st of state.stations){const d=Math.hypot(st.x-x,st.y-y);if(d<bestD){bestD=d;best=st;}}return best;}
function updateDirectLine(){const el=$("#direct-line");if(!state.directed){el.textContent="Broadcast \u00b7 all heard";return;}const st=stationByHash(state.directed);el.textContent="Directed \u00b7 "+((st&&st.name)||shortHash(state.directed));}
async function main(){
  state.id=await loadIdentity();loadChats();loadFlags();state.stations=seedGhosts(state.id.hash);
  $("#call").textContent=shortHash(state.id.hash);$("#fullhash").textContent=state.id.hash;$("#idname").textContent=state.id.name;
  log("station "+shortHash(state.id.hash)+" ready");
  const tick=()=>{$("#clock").textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});};tick();setInterval(tick,15000);
  renderBars();renderThreads();
  $("#ptt").addEventListener("pointerdown",onPttDown);
  $("#ptt").addEventListener("pointerup",onPttUp);
  $("#ptt").addEventListener("pointercancel",onPttUp);
  document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>{if(b.dataset.tab!=="chat")showRoom(false);setTab(b.dataset.tab);}));
  $("#station-sheet").addEventListener("click",e=>{
    const act=e.target.dataset.act;const st=state.selected;if(!act||!st)return;const f=flag(st.hash);
    if(act==="chat")openChat(st);
    else if(act==="ptt"){state.directed=state.directed===st.hash?null:st.hash;updateDirectLine();setTab("radio");}
    else if(act==="pin"){f.pin=!f.pin;state.flags[st.hash]=f;saveFlags();openSheet(st);}
    else if(act==="mute"){f.mute=!f.mute;state.flags[st.hash]=f;saveFlags();openSheet(st);}
  });
  $("#chat-back").addEventListener("click",()=>showRoom(false));
  $("#chat-form").addEventListener("submit",e=>{e.preventDefault();const text=$("#chat-input").value.trim();if(!text||!state.selected)return;$("#chat-input").value="";pushMsg(state.selected.hash,{from:"me",text,t:Date.now()});if(state.selected.ghost){setTimeout(()=>{const replies=["Copy.","Stand by.","On frequency.","Roger."];pushMsg(state.selected.hash,{from:"them",text:replies[Math.floor(Math.random()*replies.length)],t:Date.now()});},500);}});
  $("#thread-list").addEventListener("click",e=>{const btn=e.target.closest("[data-open]");if(!btn)return;openChat(stationByHash(btn.dataset.open)||{hash:btn.dataset.open,name:shortHash(btn.dataset.open),ghost:true});});
  $("#radar").addEventListener("click",e=>{const st=hitStation(e);if(st)openSheet(st);});
  $("#btn-rename").addEventListener("click",()=>{state.id.name="LXST-"+Math.random().toString(16).slice(2,6).toUpperCase();localStorage.setItem(KEY,JSON.stringify(state.id));$("#idname").textContent=state.id.name;});
  $("#btn-newid").addEventListener("click",async()=>{localStorage.removeItem(KEY);state.id=await loadIdentity();$("#call").textContent=shortHash(state.id.hash);$("#fullhash").textContent=state.id.hash;$("#idname").textContent=state.id.name;state.stations=seedGhosts(state.id.hash);});
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();state.installEvt=e;$("#banner").hidden=false;});
  $("#btn-install").addEventListener("click",async()=>{if(state.installEvt)await state.installEvt.prompt();$("#banner").hidden=true;});
  resizeRadar();window.addEventListener("resize",resizeRadar);
  const loop=()=>{state.sweep+=0.025;drawRadar();requestAnimationFrame(loop);};requestAnimationFrame(loop);
}
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
main();
