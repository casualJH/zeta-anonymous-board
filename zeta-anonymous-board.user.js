// ==UserScript==
// @name         제타 익명 게시판
// @namespace    zeta-anonymous-board
// @version      0.1.2
// @description  RP 세계관 속 커뮤니티 게시글·댓글 생성, 자동 턴 갱신, 수동 작성, 커뮤니티별 저장
// @author       casualJH
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @noframes
// @sandbox      raw
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @updateURL    https://raw.githubusercontent.com/casualJH/zeta-anonymous-board/main/zeta-anonymous-board.user.js
// @downloadURL  https://raw.githubusercontent.com/casualJH/zeta-anonymous-board/main/zeta-anonymous-board.user.js
// @homepageURL  https://github.com/casualJH/zeta-anonymous-board
// ==/UserScript==
(() => {
  'use strict';
  if (window.__zetaAnonymousBoardV1) return;
  window.__zetaAnonymousBoardV1 = true;
  const VERSION='0.1.2', DB='zeta-anonymous-board-v1', API='https://api.zeta-ai.io';
  const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  // Free-tier pricing candidates: this is not a quota or API-key entitlement claim.
  // The API models.list response cannot identify an account's tier or remaining RPM/RPD/TPM.
  const recommendedModels=[
    {id:'gemini-3.1-flash-lite',label:'Gemini 3.1 Flash-Lite · 무료 자동 갱신 추천'},
    {id:'gemini-2.5-flash-lite',label:'Gemini 2.5 Flash-Lite · 무료 경량 대체'},
    {id:'gemini-2.5-flash',label:'Gemini 2.5 Flash · 품질 우선 선택'}
  ];
  const models=recommendedModels.map(x=>x.id);
  const presets=[
    {id:'everytime',name:'에브리타임',desc:'학생 커뮤니티, 익명번호, 학식·수업·연애·학교 소문, 가벼운 반말',nick:'익명1, 익명2, 글쓴이',style:'학생 익명 게시판 특유의 간결한 말투'},
    {id:'blind',name:'블라인드',desc:'회사원 커뮤니티, 직장·이직·연애·업계 소문',nick:'회사명 · 닉네임',style:'직장인의 솔직한 현실적 말투'},
    {id:'office',name:'사내 익명 게시판',desc:'같은 회사 직원들이 일상과 소문을 나눔',nick:'익명직원, 개발팀 익명',style:'사내 익명 게시판 말투'},
    {id:'reddit',name:'Reddit',desc:'서브레딧식 토론, 농담과 반응',nick:'u/name',style:'Reddit 토론 문화에 맞는 말투를 한국어로 자연스럽게 표현'},
    {id:'x',name:'X',desc:'짧은 글, 실시간 화제와 반응',nick:'@handle',style:'짧고 속도감 있는 SNS 말투'},
    {id:'neighborhood',name:'동네 게시판',desc:'동네 생활, 목격담과 지역 정보',nick:'동네산책러, 이웃주민',style:'주민 카페 말투'}
  ];
  const defaults=()=>({auto:true,turns:1,posts:3,newComments:7,oldComments:10,oldPostWindow:20,quiet:'daily',model:'gemini-3.1-flash-lite',fallback:'',temperature:0.9,guide:'',userNickMode:'auto',userNick:'',selected:'everytime',custom:[],status:'',profiles:{user:'',characters:'',world:''}});
  const now=()=>Date.now(), uid=()=> (crypto.randomUUID?.()||'id-'+now().toString(36)+'-'+Math.random().toString(36).slice(2));
  const num=(x,min,max,d)=>{const n=Number(x);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.trunc(n))):d;};
  const copy=x=>JSON.parse(JSON.stringify(x));
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short=(s,n)=>String(s??'').trim().slice(0,n);
  const safeArray=v=>Array.isArray(v)?v:[];
  const timeText=t=>{const d=new Date(t);return Number.isNaN(+d)?'':d.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});};
  const persistedUIKey='zab-ui-v1';
  let uiPos={x:null,y:null,w:null,h:null};try{uiPos={...uiPos,...JSON.parse(localStorage.getItem(persistedUIKey)||'{}')};}catch{}
  let dbPromise;
  function openDB(){if(dbPromise)return dbPromise;dbPromise=new Promise((resolve,reject)=>{const q=indexedDB.open(DB,1);q.onupgradeneeded=()=>{const d=q.result;if(!d.objectStoreNames.contains('rooms'))d.createObjectStore('rooms',{keyPath:'room'});};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});return dbPromise;}
  async function readRoom(id){const d=await openDB();return new Promise((resolve,reject)=>{const tx=d.transaction('rooms','readonly');const q=tx.objectStore('rooms').get(id);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error);});}
  async function writeRoom(data){const d=await openDB();return new Promise((resolve,reject)=>{const tx=d.transaction('rooms','readwrite');tx.objectStore('rooms').put(copy(data));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
  function blankRoom(id){return {room:id,settings:defaults(),boards:{},updatedAt:now()};}
  function blankBoard(){return {posts:[],residents:{},sort:'recent',started:false,seen:{},lastBatch:null,unread:0};}
  let room='',data=null,postsView='list',detailId='',settingsOpen=false,settingTab='basic',panel=null,launcher=null,notice='',noticeUntil=0;
  let busy=null,pending=null,turnCount=0,activeTurnKey='',activeTurnHash='',lastTurnKeys=[],baselineReady=false,autoTimer=null,latestTimer=null,loadBusy=false,lastLiveSync=0,runEpoch=0;
  let profileCache={characters:[],user:null,plot:null}, captured=null, networkRoom='',roomMarker='';
  const page=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
  const bridgeId='zab-'+Math.random().toString(36).slice(2);
  // The page bridge keeps Zeta authorization in page context. It NEVER sends headers to the userscript UI or Gemini.
  function installBridge(){
    const fn=function(channel){
      if(window.__zabPageBridge)return;window.__zabPageBridge=true;
      const origin='https://api.zeta-ai.io', allowed=['authorization','x-client-native-version','x-client-type','x-client-version','x-device-type','x-user-language'];
      let headers={},currentRoom='',base=window.fetch;
      const xhrOpen=XMLHttpRequest.prototype.open,xhrSend=XMLHttpRequest.prototype.send,xhrHeader=XMLHttpRequest.prototype.setRequestHeader;const xhrMap=new WeakMap();
      const emit=(type,obj)=>window.postMessage({tag:'zab-bridge',channel,type,...obj},'*');
      const parse=u=>{try{const v=new URL(String(u),location.href);return v.origin===origin?v:null;}catch{return null;}};
      function addHeaders(h){try{const entries=h instanceof Headers?h.entries():Array.isArray(h)?h:Object.entries(h||{});for(const [name,value] of entries){if(allowed.includes(String(name).toLowerCase()))headers[String(name).toLowerCase()]=String(value);}}catch{}}
      function seeRoom(u){const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(String(u));if(m){currentRoom=m[1];emit('room',{room:currentRoom});}}
      function observe(url,response){const isMsg=/\/v1\/rooms\/[\da-f-]{36}\/messages(?:[?#]|$)/i.test(String(url));const isProfile=/\/v1\/rooms\/[\da-f-]{36}\/?(?:[?#]|$)|\/plots\/|profile|persona|character/i.test(String(url));if(!isMsg&&!isProfile)return;response.clone().json().then(v=>{if(isMsg&&Array.isArray(v?.messages))emit('messages',{room:currentRoom,messages:v.messages});else if(isProfile)emit('profile',{room:currentRoom,profile:v});}).catch(()=>{});}
      window.fetch=function(input,init){let url='';try{url=typeof input==='string'?input:input instanceof URL?input.href:input?.url||'';if(parse(url)){addHeaders(init?.headers||input?.headers);seeRoom(url);}}catch{}const r=base.apply(this,arguments);if(parse(url))Promise.resolve(r).then(v=>observe(url,v)).catch(()=>{});return r;};
      XMLHttpRequest.prototype.open=function(method,url){xhrMap.set(this,{url:String(url),headers:[]});return xhrOpen.apply(this,arguments);};
      XMLHttpRequest.prototype.setRequestHeader=function(k,v){const state=xhrMap.get(this);if(state&&parse(state.url))state.headers.push([k,v]);return xhrHeader.apply(this,arguments);};
      XMLHttpRequest.prototype.send=function(){const state=xhrMap.get(this);if(state&&parse(state.url)){seeRoom(state.url);addHeaders(state.headers);if(/\/messages(?:[?#]|$)/i.test(state.url))this.addEventListener('load',()=>{try{const o=this.responseType==='json'?this.response:JSON.parse(this.responseText);if(Array.isArray(o?.messages))emit('messages',{room:currentRoom,messages:o.messages});}catch{}},{once:true});}return xhrSend.apply(this,arguments);};
      const discover=()=>{const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m&&m[1]!==currentRoom){currentRoom=m[1];emit('room',{room:currentRoom});}};
      async function latest(){discover();if(!currentRoom||!headers.authorization){emit('error',{message:'제타 인증 정보가 아직 감지되지 않았어요. 채팅방을 새로고침해 주세요.'});return;}try{const response=await base.call(window,`${origin}/v1/rooms/${currentRoom}/messages?limit=100`,{headers:{...headers},credentials:'include',cache:'no-store'});if(!response.ok)throw new Error('제타 메시지 API HTTP '+response.status);const body=await response.json();if(Array.isArray(body.messages))emit('messages',{room:currentRoom,messages:body.messages,latest:true});}catch(e){emit('error',{message:String(e.message||e)});}}
      // Explicit profile refresh reads the same room/plot endpoints used by Zeta's
      // memory assistant.  Never expose authorization headers outside the bridge.
      let profileEpoch=0;
      async function refreshProfiles(){
        discover(); const forRoom=currentRoom,epoch=++profileEpoch;
        if(!forRoom||!headers.authorization){emit('profileError',{room:forRoom,message:'제타 인증 정보가 아직 확인되지 않았어요. 채팅방을 새로고침한 다음 다시 시도하세요.'});return;}
        const request=async path=>{const url=origin+path;const res=await base.call(window,url,{headers:{...headers},credentials:'include',cache:'no-store'});if(!res.ok)throw new Error('프로필 API HTTP '+res.status);return res.json();};
        let count=0,errors=[];
        try{
          const roomData=await request('/v1/rooms/'+forRoom);
          if(epoch!==profileEpoch||currentRoom!==forRoom)return;
          emit('profile',{room:forRoom,profile:roomData});count++;
          const plotId=roomData?.plot?.id||roomData?.plotId||roomData?.plot_id;
          if(plotId&&/^[0-9a-z_-]{4,120}$/i.test(String(plotId))){
            try{const plot=await request('/v1/plots/'+encodeURIComponent(plotId));if(epoch!==profileEpoch||currentRoom!==forRoom)return;emit('profile',{room:forRoom,profile:{plot,plotId}});count++;}
            catch(e){errors.push(String(e.message||e));}
          }
          // The user persona can be returned by one of these endpoints depending
          // on the Zeta client; a failure must not wipe other successfully read profiles.
          for(const path of plotId?[`/v1/plots/${encodeURIComponent(plotId)}/rooms/${forRoom}/user-personas/selected`]:[]){
            try{const persona=await request(path);if(epoch!==profileEpoch||currentRoom!==forRoom)return;emit('profile',{room:forRoom,profile:{userProfile:persona}});count++;break;}
            catch(e){errors.push(String(e.message||e));}
          }
          emit('profileComplete',{room:forRoom,count,partial:errors.length>0});
        }catch(e){emit('profileError',{room:forRoom,message:'프로필 가져오기 실패: '+String(e.message||e)});}
      }
      window.addEventListener('message',e=>{if(e.source!==window||e.data?.tag!=='zab-control'||e.data.channel!==channel)return;if(e.data.action==='latest')latest();else if(e.data.action==='profiles')refreshProfiles();else if(e.data.action==='state'){discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});}});
      setInterval(discover,800);discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});
    };
    try{fn.call(page,bridgeId);}catch(e){console.warn('[제타 익명 게시판] 페이지 연결 실패',e);}
  }
  installBridge();
  function bridge(action){window.postMessage({tag:'zab-control',channel:bridgeId,action},'*');}
  async function setRoom(id){if(!id||!UUID.test(id)||id===room)return;cancelBusy(false);clearTimeout(autoTimer);clearTimeout(latestTimer);runEpoch++;turnCount=0;activeTurnKey='';activeTurnHash='';lastTurnKeys=[];baselineReady=false;room=id;postsView='list';detailId='';profileCache={characters:[],user:null,plot:null};profileInfo='프로필을 불러오는 중…';profileRequestRoom='';try{data=await readRoom(id)||blankRoom(id);}catch(e){data=blankRoom(id);alert('저장소를 읽지 못해 임시 데이터로 시작합니다: '+e);}if(room!==id)return;data.settings={...defaults(),...data.settings};if(['apartment','dating'].includes(data.settings.selected))data.settings.selected='everytime';render();setTimeout(()=>{bridge('latest');bridge('profiles');profileRequestRoom=id;},650);}
  function currentBoard(){if(!data)return blankBoard();const id=data.settings.selected;if(!data.boards[id])data.boards[id]=blankBoard();return data.boards[id];}
  function currentCommunity(){return [...presets,...safeArray(data?.settings.custom)].find(x=>x.id===data?.settings.selected)||presets[0];}
  function saved(){if(!data)return;data.updatedAt=now();writeRoom(data).catch(e=>show('저장 실패: '+e.message));}
  function show(msg){notice=String(msg);noticeUntil=now()+5000;renderStatus();setTimeout(()=>{if(now()>noticeUntil)renderStatus();},5100);}
  function normalize(raw){const out=[];for(const m of safeArray(raw)){if(!m||!m.id)continue;let items=[];for(const [i,c] of safeArray(m.contents).entries()){if(!c)continue;let t='';if(c.type==='TEXT')t=String(c.text||'').trim();else if(c.type==='INFO_BOX'){const pieces=[];for(const e of [...safeArray(c.scenes),...safeArray(c.characters)]){const line=[e.name||e.title||'',...safeArray(e.items).map(x=>`${x.label||''}: ${x.value||''}`)].filter(Boolean).join('\n');if(line.trim())pieces.push(line);}t=pieces.join('\n\n');}if(t)items.push({id:String(m.id)+':'+i,messageId:String(m.id),time:m.messageTime||'',kind:c.type,role:m.sender?.type==='USER'?'user':'character',speaker:m.sender?.type==='USER'?'사용자':c.speakerName||'캐릭터',text:t});}out.push(...items);}return out.sort((a,b)=>(Date.parse(a.time)||0)-(Date.parse(b.time)||0)||a.id.localeCompare(b.id));}
  // Turn grouping follows zeta-chat-export-dev v1.2.0-beta.6: an intro is one turn,
  // each independent CHARACTER message forms a subsequent turn, and repeated contents share messageId.
  function buildTurns(parts){const result=[],pending=[];const first=parts.findIndex(p=>p.role==='user');const introEnd=first<0?parts.length:first;if(introEnd){result.push({id:'opening-'+parts[0].messageId,intro:true,incomplete:false,parts:parts.slice(0,introEnd),user:[],character:parts.slice(0,introEnd)});}let current=null,last='';for(const p of parts.slice(introEnd)){const id=p.messageId;if(p.role==='user'){pending.push(p);current=null;}else{if(id!==last||!current){current={id:'turn-'+id,intro:false,incomplete:false,user:pending.splice(0),character:[],parts:[]};current.parts.push(...current.user);result.push(current);}current.character.push(p);current.parts.push(p);}last=id;}if(pending.length)result.push({id:'incomplete-'+pending[0].messageId,incomplete:true,intro:false,user:[...pending],character:[],parts:[...pending]});return result;}
  let observedTurns=[],turnContent=new Map(),acceptedFingerprints=new Map(),roomRevision=0;
  function fingerprint(t){return t.parts.map(p=>p.messageId+'|'+p.role+'|'+p.text).join('\n');}
  function processMessages(msgs,latest=false){if(!room)return;const normalized=normalize(msgs);if(!normalized.length)return;const all=buildTurns(normalized),complete=all.filter(t=>!t.incomplete&&!t.intro&&t.character.length),keys=complete.map(t=>t.id);const fingerprints=new Map(complete.map(t=>[t.id,fingerprint(t)]));const oldKeys=lastTurnKeys;
    // Different responses after the same USER message may be alternative generations: the canonical
    // final turn is the last response for that user input, never increment for duplicate observations.
    const groups=[];let current=null,lastUserAnchor='';for(const t of complete){const parent=t.user.map(x=>x.messageId).join(',');if(parent)lastUserAnchor=parent;const key=lastUserAnchor?'user-'+lastUserAnchor:t.id;if(!current||current.key!==key){current={key,turn:t};groups.push(current);}else current.turn=t;}
    const logical=groups.map(x=>x.key), last=groups.at(-1), lastKey=last?.key||'', lastHash=last?fingerprint(last.turn):'';
    if(latest&&baselineReady){const oldCount=lastTurnKeys.length;const previousLast=oldKeys.at(-1),previousIndex=previousLast?logical.indexOf(previousLast):-1;const advanced=previousIndex>=0?logical.length-previousIndex-1:Math.max(0,logical.length-oldCount);const common=previousIndex>=0||!oldCount;const changed=oldCount&&!common;if(changed){invalidatePending('대화 기록이 변경되어 현재 대기·생성을 취소했어요.');}
      // detect change to the same logical last turn (reroll or text replacement)
      if(lastKey&&lastKey===activeTurnKey&&lastHash!==activeTurnHash){invalidatePending('답변이 변경되어 현재 턴의 생성 기록을 취소했어요.');}
      if(lastKey&&advanced>0){const prevBatch=currentBoard().lastBatch;if(prevBatch?.temporary){prevBatch.temporary=false;saved();}}
      if(lastKey&&advanced>0&&data?.settings.auto&&currentBoard().started){const increments=advanced;turnCount+=increments;show('새 턴 '+increments+'개 확인 · '+turnCount+'/'+data.settings.turns+'턴');if(turnCount>=num(data.settings.turns,1,999,1))scheduleAuto(lastKey,lastHash);}
      else if(lastKey===activeTurnKey&&lastHash!==activeTurnHash&&data?.settings.auto&&currentBoard().started){if(turnCount>=num(data.settings.turns,1,999,1))scheduleAuto(lastKey,lastHash);}
    }
    observedTurns=groups.map(g=>g.turn);lastTurnKeys=logical;activeTurnKey=lastKey;activeTurnHash=lastHash;baselineReady=true;
    // Remember only the latest batch of messages, plus selected prior context via local references.
    if(latest)lastRawMessageSnapshot=normalized;
  }
  let lastRawMessageSnapshot=[];
  function invalidatePending(reason){clearTimeout(autoTimer);autoTimer=null;cancelBusy(false);const b=currentBoard();if(b.lastBatch?.temporary){rollback(b.lastBatch);b.lastBatch=null;saved();}if(reason)show(reason);}
  function rollback(batch){if(!batch||!data)return;const board=currentBoard();board.posts=board.posts.filter(p=>!batch.created.includes(p.id));for(const p of board.posts){p.comments=p.comments.filter(c=>!batch.comments.includes(c.id));for(const c of p.comments)c.replies=c.replies.filter(r=>!batch.comments.includes(r.id));const old=batch.metrics?.[p.id];if(old){p.views=old.views;p.likes=old.likes;}}board.unread=Math.max(0,board.unread-(batch.created?.length||0));}
  function scheduleAuto(key,hash){clearTimeout(autoTimer);if(busy||!data?.settings.auto||!currentBoard().started)return;show('게시글 생성 대기 중');const epoch=runEpoch,roomAt=room,comm=data.settings.selected;autoTimer=setTimeout(async()=>{if(epoch!==runEpoch||roomAt!==room||comm!==data?.settings.selected)return;bridge('latest');setTimeout(()=>{if(epoch!==runEpoch||key!==activeTurnKey||hash!==activeTurnHash||busy||!data?.settings.auto)return;generate('auto');},900);},15000);}
  window.addEventListener('message',e=>{const m=e.data;if(e.source!==window||m?.tag!=='zab-bridge'||m.channel!==bridgeId)return;if(m.type==='room'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='state'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='messages'&&m.room===room){processMessages(m.messages,!!m.latest);lastLiveSync=now();}if(m.type==='profile'&&m.room===room){ingestProfile(m.profile);updateProfileStatus();}
    if(m.type==='profileComplete'&&m.room===room){profileInfo='프로필 API 확인'+(m.partial?' · 일부 항목 확인 실패':'');updateProfileStatus();}
    if(m.type==='profileError'&&(!m.room||m.room===room)){profileInfo=m.message||'프로필 수집 실패';updateProfileStatus();}
    if(m.type==='error')show(m.message);});
  function profileItem(raw,allowUserName=false){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const name=short(raw.name||raw.displayName||raw.display_name||raw.nickname||raw.title||'',160);
    const description=short(raw.description||raw.introduction||raw.character?.description||'',16000);
    const id=String(raw.id||raw.uuid||raw.profileId||raw.characterId||raw.character_id||raw.character?.id||'').slice(0,120);
    if((!name&&!description)||(!allowUserName&&(/\{\{\s*user\s*\}\}/i.test(name)||name==='사용자'||name.toLowerCase()==='user')))return null;
    return {id,name,description};
  }
  function ingestProfile(raw){
    if(!raw||typeof raw!=='object')return;
    const add=entry=>{
      const p=profileItem(entry);if(!p)return;
      const idx=profileCache.characters.findIndex(x=>(x.id&&p.id&&x.id===p.id)||x.name&&p.name&&x.name===p.name);
      if(idx<0)profileCache.characters.push(p);
      else{const old=profileCache.characters[idx];profileCache.characters[idx]={id:p.id||old.id,name:p.name||old.name,description:p.description.length>old.description.length?p.description:old.description};}
    };
    const plots=[raw.plot,raw.room?.plot,raw.room,raw].filter(x=>x&&typeof x==='object');
    for(const obj of plots){
      if(obj.plot?.id)profileCache.plot=String(obj.plot.id);
      if(obj.plotId)profileCache.plot=String(obj.plotId);
      for(const c of [...safeArray(obj.characters),...safeArray(obj.plot?.characters)])add(c);
      // Plot introductions carry the actual description for characters listed in room data.
      for(const c of safeArray(obj.about?.characters)){
        if(!c||typeof c!=='object')continue;
        const ref=profileCache.characters.find(x=>x.id&&x.id===String(c.characterId||''));
        if(ref&&typeof c.description==='string'&&c.description.length>(ref.description||'').length)ref.description=short(c.description,16000);
        else if(c.name)add(c);
      }
      const user=obj.userProfile||obj.userPersona||obj.user;
      if(user&&typeof user==='object'){
        const incoming=profileItem(user,true);
        if(incoming&&(!profileCache.user||incoming.description.length>String(profileCache.user.description||'').length))profileCache.user=incoming;
      }
    }
    // Fill character descriptions by ID without confusing nested user/persona data for characters.
    const byId=new Set(profileCache.characters.map(x=>x.id).filter(Boolean)),stack=[raw];let steps=0;
    while(stack.length&&steps++<1200){const v=stack.pop();if(!v||typeof v!=='object')continue;
      if(!Array.isArray(v)&&v.id&&byId.has(String(v.id))&&typeof v.description==='string'){
        const existing=profileCache.characters.find(p=>p.id===String(v.id));if(existing&&v.description.length>existing.description.length)existing.description=short(v.description,16000);
      }
      for(const [key,child] of Object.entries(v).slice(0,80))if(child&&typeof child==='object'&&!/auth|token|cookie|password|secret|email|phone/i.test(key))stack.push(child);
    }
  }
  function updateProfileStatus(){
    const el=panel?.querySelector('#zab-profile-status');
    if(el)el.textContent=`${profileInfo} · 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.user?'확인':'미확인'}`;
    const list=panel?.querySelector('#zab-profile-list');
    if(list)list.textContent=profileCache.characters.length?profileCache.characters.map(p=>p.name||'(이름 없음)').join(', '):'확인된 캐릭터가 없습니다.';
  }
  function requestLatest(){if(!room||loadBusy)return;loadBusy=true;bridge('latest');setTimeout(()=>{loadBusy=false;},1700);}
  const runner=setInterval(()=>{if(!document.body)return;const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m)setRoom(m[1]);if(!room||!data)return;try{const p=page.zetaCurrentProfiles?.get?.();if(p){ingestProfile({characters:[p.character,...safeArray(p.characters)].filter(Boolean),userProfile:p.user});updateProfileStatus();}}catch{}if(now()-lastLiveSync>6500)requestLatest();if(!panel)mount();},2000);
  function saveSettings(){if(!data)return;data.settings.turns=num(data.settings.turns,1,999,1);saved();render();}
  function communityChange(id){if(!data)return;if(data.settings.selected===id)return;invalidatePending('커뮤니티를 변경했어요.');runEpoch++;turnCount=0;data.settings.selected=id;postsView='list';detailId='';saved();render();}
  function toggleAuto(on){if(!data)return;invalidatePending('');runEpoch++;turnCount=0;data.settings.auto=on;saveSettings();show('자동 갱신 '+(on?'ON':'OFF')+' · 0턴부터 시작');}
  function cancelBusy(reset=true){if(!busy)return;const b=busy;busy=null;b.cancelled=true;try{b.request?.abort?.();}catch{}if(reset)turnCount=0;renderStatus();}
  function getKey(){try{return String(GM_getValue('zab-gemini-key','')||'').trim();}catch{return'';}}
  function setKey(v){GM_setValue('zab-gemini-key',String(v||'').trim());}
  let modelsFetched=[],modelLabels={},modelListLoaded=false,modelLoadNote='모델 목록을 조회하지 않았어요.';
  let modelCheckBusy=false;
  const modelChecks=new Map(); // Session-only. Never save an API key with results.
  const MODEL_CHECK_TTL=15*60*1000;
  const modelCandidates=()=>[...new Set([...models,...safeArray(modelsFetched),data?.settings?.model,data?.settings?.fallback].filter(Boolean))];
  function modelCheckState(id){
    const hit=modelChecks.get(id);
    if(!hit||now()-hit.at>MODEL_CHECK_TTL)return '';
    return hit.ok?'호출 성공':hit.code===429?'429 한도 초과':hit.code===404?'404 모델 없음':hit.code===403?'403 권한 없음':`${hit.code||'오류'} 확인 실패`;
  }
  function modelSelection(){
    const s=data.settings;
    function options(selected,allowNone){return (allowNone?'<option value="">대체 모델 사용 안 함</option>':'')+modelCandidates().map(id=>{
      const rec=recommendedModels.find(x=>x.id===id);
      const listed=modelListLoaded?(modelsFetched.includes(id)?' · API 목록 확인':' · API 목록에 없음'):'';
      const tested=modelCheckState(id);
      const label=(rec?'★ '+rec.label:(modelLabels[id]||id))+(rec?' · '+id:'')+listed+(tested?' · '+tested:'');
      return `<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(label)}</option>`;
    }).join('');}
    return `<select data-setting="model">${options(s.model,false)}</select>
      <p class="zab-note">★ 무료 요금표에 등재된 추천 후보예요. 무료 요청 한도는 프로젝트마다 다르며, API 목록에 보여도 무료 호출 가능 여부가 보장되지는 않아요.</p>
      <label>대체 모델 (선택 사항)</label><select data-setting="fallback">${options(s.fallback||'',true)}</select>
      <p class="zab-note">기본 모델에 404·429·503 오류가 발생할 때만 선택한 대체 모델로 1회 재시도합니다. 두 모델 모두 사용량이 계산될 수 있어요.</p>
      <div class="zab-row">${btn('models','모델 목록 조회')}${btn('check-model','선택 모델 호출 확인','',modelCheckBusy?'disabled':'')}</div>
      <p class="zab-note">${esc(modelLoadNote)} · 호출 확인은 소량의 API 요청과 할당량을 사용해요.</p>
      <label>모델 ID 직접 입력 (선택 사항)</label><div class="zab-row"><input id="zab-manual-model" placeholder="예: gemini-3.1-flash-lite" style="flex:1;min-width:90px">${btn('set-manual-model','모델 적용')}</div>`;
  }
  function geminiError(status,raw){
    let body={};try{body=JSON.parse(raw||'{}')}catch{}
    const err=new Error('Gemini HTTP '+status+' · '+short(body.error?.message||raw,240));err.status=Number(status)||0;return err;
  }
  function gmJSON(url,method,key,body,token){return new Promise((resolve,reject)=>{
    const q=GM_xmlhttpRequest({url,method,headers:{'Content-Type':'application/json','x-goog-api-key':key},data:body?JSON.stringify(body):undefined,timeout:60000,
      onload:r=>{if(r.status<200||r.status>=300)return reject(geminiError(r.status,r.responseText));try{resolve(JSON.parse(r.responseText||'{}'))}catch{reject(new Error('Gemini JSON 응답 파싱 실패'))}},
      onerror:()=>reject(new Error('Gemini 네트워크 오류')),ontimeout:()=>reject(new Error('Gemini 응답 시간 초과')),onabort:()=>reject(new Error('사용자가 생성 취소'))});
    if(token)token.request=q;
  });}
  async function fetchModels(){
    const key=getKey();if(!key)return show('API 키를 먼저 저장해 주세요.');
    try{
      const list=[];let next='';let loops=0;
      do{
        const url='https://generativelanguage.googleapis.com/v1beta/models?pageSize=100'+(next?'&pageToken='+encodeURIComponent(next):'');
        const o=await gmJSON(url,'GET',key);list.push(...safeArray(o.models));next=String(o.nextPageToken||'');
      }while(next&&++loops<8);
      modelsFetched=[...new Set(list.filter(m=>safeArray(m.supportedGenerationMethods).includes('generateContent')).map(m=>String(m.name||'').replace(/^models\//,'')))];
      modelLabels=Object.fromEntries(list.map(m=>[String(m.name||'').replace(/^models\//,''),String(m.displayName||'')]));
      modelListLoaded=true;modelLoadNote='API generateContent 모델 '+modelsFetched.length+'개 조회됨 (무료 사용 가능 여부 별도)';show(modelLoadNote);render();
    }catch(e){modelLoadNote='모델 목록 조회 실패: '+String(e.message||e);show(modelLoadNote);render();}
  }
  async function checkSelectedModel(){
    if(modelCheckBusy||!data)return;
    const key=getKey();if(!key)return show('API 키를 먼저 저장해 주세요.');
    const model=data.settings.model;if(!model)return show('모델을 선택해 주세요.');
    modelCheckBusy=true;show(model+' · 호출 확인 중…');render();
    try{
      const result=await gmJSON('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent','POST',key,
        {contents:[{role:'user',parts:[{text:'OK라고만 답하세요.'}]}],generationConfig:{maxOutputTokens:24,temperature:0}});
      if(!safeArray(result.candidates).length)throw new Error('모델 응답에 후보가 없어요.');
      modelChecks.set(model,{ok:true,at:now(),code:200});show(model+' · 호출 성공 (남은 무료 한도는 확인 불가)');
    }catch(e){modelChecks.set(model,{ok:false,at:now(),code:e.status||0});show(model+' · '+String(e.message||e));}
    finally{modelCheckBusy=false;render();}
  }
  async function generateWithFallback(key,model,body,request){
    const call=id=>gmJSON('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(id)+':generateContent','POST',key,body,request);
    try{const res=await call(model);modelChecks.set(model,{ok:true,at:now(),code:200});return res;}
    catch(e){
      const status=e.status||0;modelChecks.set(model,{ok:false,at:now(),code:status});
      const alt=data?.settings?.fallback;
      if(request.cancelled||busy!==request||![404,429,503].includes(status)||!alt||alt===model)throw e;
      show(model+' · '+status+' 오류, 대체 모델 '+alt+' 재시도');
      const res=await call(alt);modelChecks.set(alt,{ok:true,at:now(),code:200});return res;
    }
  }
  function promptPayload(kind,post){const b=currentBoard(),s=data.settings,community=currentCommunity(),recent=observedTurns.slice(-Math.max(10,num(s.turns,1,999,1)+5)).map((t,i)=>({turn:i+1,content:t.parts.map(p=>`${p.speaker} (${p.role}): ${short(p.text,1300)}`).join('\n').slice(0,4500)}));const older=b.posts.slice(-num(s.oldPostWindow,0,300,20)).map(p=>({id:p.id,title:p.title,body:short(p.body,850),comments:p.comments.slice(-8).map(c=>({id:c.id,author:c.nick,text:short(c.text,250)}))}));const residents=Object.values(b.residents).slice(-40);
    const instructions=`당신은 가상의 RP 세계에 실제 거주하는 익명 커뮤니티 운영 시뮬레이터다. 관찰자·독자가 아니라 세계관 주민의 입장에서 작성하라. 공개적으로 목격·전달될 수 있는 사건만 목격 사실로 쓰고, 비밀 대화·내면·보이지 않는 사적 행동을 누설하지 마라. 소문은 반드시 소문/추측으로 표현하라. RP 주인공에 관한 글과 주민들의 독립적인 일상을 자연스럽게 섞고, 주어진 세계관의 주요 사실을 바꾸지 않는 선에서 새로운 회사·가게·지역·주민 등 배경 요소 창작은 허용한다. 기존 주민 ID는 재사용 가능하며 새로운 주민을 만들어도 된다. 사용자 글은 삭제·수정하지 마라. 글과 댓글의 닉네임은 해당 커뮤니티에 맞게 만들고, 대댓글은 최대 한 단계. 출력은 반드시 JSON 객체 하나이며 Markdown 코드펜스는 제외.`;
    const schema=`JSON 형태: {"posts":[{"title":"제목","body":"본문","nick":"닉네임","residentId":"재사용할 주민 ID 또는 새 주민용 임의 별칭","views":10,"likes":2,"comments":[{"nick":"닉네임","residentId":"임의 별칭","text":"댓글","likes":1,"replies":[{"nick":"닉네임","residentId":"임의 별칭","text":"대댓글","likes":0}]}]}],"updates":[{"postId":"과거 게시글 ID","comments":[{"nick":"닉네임","residentId":"임의 별칭","text":"추가 댓글","likes":0,"replies":[]}]}]}. 원본에 없는 postId는 사용 금지.`;
    const task=kind==='react'?`아래 사용자 게시글/댓글을 대상으로 AI 주민의 반응만 생성. 새 게시글은 0개. 대상 글 ID=${post?.id||''}. 이전 글 중 해당 글에만 댓글을 추가.`:`새 게시글 ${num(s.posts,1,15,3)}개를 목표로 생성하라. 새 게시글당 댓글 최대 ${num(s.newComments,0,30,7)}개. 기존 최근 ${num(s.oldPostWindow,0,300,20)}개 글 중 내용 관련성이 높은 글에만 추가 댓글을 작성하되, 모든 기존 글에 추가되는 댓글·대댓글 총합은 ${num(s.oldComments,0,100,10)}개 이하. ${s.quiet==='skip'?'공개 사건이 전혀 없다면 게시글과 댓글 생성 생략':s.quiet==='rumors'?'새 사건이 없으면 기존 소문만 이어가기':'새 사건이 없으면 세계관 주민 일상 글 작성'}.`;
    return `${instructions}\n${schema}\n[작업] ${task}\n[커뮤니티] ${JSON.stringify(community)}\n[커뮤니티별 생성 지침] ${short(s.guide,5000)}\n[수집된 프로필] ${JSON.stringify({user:short(s.profiles.user,5000),characters:short(s.profiles.characters,9000),world:short(s.profiles.world,6500),autoCharacters:profileCache.characters.slice(0,30),autoUser:profileCache.user})}\n[최근 RP 대화 (개인정보 및 비공개 사실은 주민에게 직접 노출 금지)] ${JSON.stringify(recent).slice(0,20000)}\n[기존 주민] ${JSON.stringify(residents).slice(0,7500)}\n[최근 커뮤니티 게시글] ${JSON.stringify(older).slice(0,14000)}\n[사용자 반응 대상] ${JSON.stringify(post||{}).slice(0,5000)}\nJSON 객체만 답하라.`;
  }
  function parseGemini(result){let text=safeArray(result.candidates?.[0]?.content?.parts).map(p=>p.text||'').join('').trim();text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text);}catch{const m=/\{[\s\S]*\}/.exec(text);if(m)return JSON.parse(m[0]);throw new Error('Gemini JSON 형식 오류');}}
  function normalizeComment(raw){const c={id:uid(),nick:short(raw.nick||'익명',60),residentId:short(raw.residentId||'',75),text:short(raw.text,3500),likes:num(raw.likes,0,999999,0),time:now(),source:'ai',replies:[]};c.replies=safeArray(raw.replies).slice(0,12).map(r=>({id:uid(),nick:short(r.nick||'익명',60),residentId:short(r.residentId||'',75),text:short(r.text,3000),likes:num(r.likes,0,999999,0),time:now(),source:'ai',parentId:c.id})).filter(x=>x.text);return c;}
  function applyResult(out,kind,replaceBatch){if(!out||typeof out!=='object')throw new Error('Gemini 생성 결과가 올바르지 않아요.');const board=currentBoard();if(replaceBatch)rollback(replaceBatch);const batch={id:uid(),created:[],comments:[],metrics:{},temporary:kind==='auto',time:now()};const posts=kind==='react'?[]:safeArray(out.posts).slice(0,num(data.settings.posts,1,15,3));for(const raw of posts){if(!String(raw.title||'').trim()&&!String(raw.body||'').trim())continue;const p={id:uid(),title:short(raw.title||'무제',180),body:short(raw.body,8500),nick:short(raw.nick||'익명',60),residentId:short(raw.residentId||'',75),views:num(raw.views,0,10000000,10),likes:num(raw.likes,0,10000000,0),time:now(),source:'ai',comments:safeArray(raw.comments).slice(0,num(data.settings.newComments,0,30,7)).map(normalizeComment).filter(c=>c.text)};board.posts.push(p);batch.created.push(p.id);rememberResident(p.nick,p.residentId);for(const c of p.comments){rememberResident(c.nick,c.residentId);for(const r of c.replies)rememberResident(r.nick,r.residentId);}}
    let count=0;const eligible=new Set(board.posts.slice(-num(data.settings.oldPostWindow,0,300,20)-posts.length).filter(p=>!batch.created.includes(p.id)).map(p=>p.id));if(kind==='react'&&replaceBatch?.targetPost)eligible.add(replaceBatch.targetPost);
    for(const update of safeArray(out.updates)){const p=board.posts.find(p=>p.id===update.postId);if(!p||(!eligible.has(p.id)&&!(kind==='react'&&p.id===reactionTarget)))continue;for(const raw of safeArray(update.comments)){const c=normalizeComment(raw);const added=1+c.replies.length;if(count+added>num(data.settings.oldComments,0,100,10))break;if(!c.text)continue;p.comments.push(c);batch.comments.push(c.id,...c.replies.map(r=>r.id));rememberResident(c.nick,c.residentId);for(const r of c.replies)rememberResident(r.nick,r.residentId);count+=added;}}
    board.unread+=batch.created.length;for(const p of board.posts){if(batch.created.includes(p.id))continue;batch.metrics[p.id]={views:p.views,likes:p.likes};const age=Math.max(0,(now()-p.time)/86400000);const factor=Math.max(0.05,1/(1+age/2));p.views+=Math.floor((4+Math.random()*26)*factor);p.likes+=Math.floor(Math.random()*4*factor);for(const c of p.comments){if(c.source==='ai'&&Math.random()<0.45)c.likes+=1;}}
    if(batch.created.length||batch.comments.length)board.lastBatch=batch;board.started=true;saved();return batch;
  }
  function rememberResident(nick,id){if(!id||!nick)return;const b=currentBoard();if(!b.residents[id])b.residents[id]={id,nick};}
  let reactionTarget='';
  async function generate(kind='manual',post=null){if(!data)return;const board=currentBoard(),key=getKey();if(busy)return show('이미 생성 중이에요.');if(!key){settingsOpen=true;settingTab='ai';render();return show('Gemini API 키를 입력해 주세요.');}
    if(!board.started&&kind==='auto')return;clearTimeout(autoTimer);const batchToReplace=kind==='regenerate'?board.lastBatch:null;
    const request={id:uid(),cancelled:false,room,community:data.settings.selected,epoch:runEpoch,request:null};busy=request;reactionTarget=post?.id||'';renderStatus();try{const prompt=promptPayload(kind==='react'?'react':'generate',post);const model=data.settings.model||models[0];const body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.9,responseMimeType:'application/json',maxOutputTokens:8192}};const res=await generateWithFallback(key,model,body,request);if(request.cancelled||busy!==request||request.room!==room||request.community!==data?.settings.selected||request.epoch!==runEpoch)return;const result=parseGemini(res);if(kind==='regenerate'&&batchToReplace&&board.lastBatch!==batchToReplace)throw Error('재생성 대상이 변경되었습니다.');const next=applyResult(result,kind,batchToReplace);if(kind==='manual'||kind==='auto'){turnCount=0;}if(kind==='regenerate'){next.temporary=batchToReplace?.temporary||false;saved();}show('게시판 갱신 완료 · 새 게시글 '+next.created.length+'개');render();}
    catch(e){if(!request.cancelled)show('게시글 생성 실패: '+e.message);}finally{if(busy===request)busy=null;reactionTarget='';render();}
  }
  function chooseNick(){if(data.settings.userNickMode==='custom'&&data.settings.userNick.trim())return short(data.settings.userNick,60);const c=currentCommunity();if(c.id==='everytime')return'익명';if(c.id==='blind')return'익명';return '익명 주민';}
  function makeOwnPost(title,body){if(!title.trim()||!body.trim())return show('제목과 본문을 입력해 주세요.');const b=currentBoard();b.posts.push({id:uid(),title:short(title,180),body:short(body,8500),nick:chooseNick(),residentId:'user',views:0,likes:0,time:now(),source:'user',comments:[]});b.started=true;saved();postsView='list';render();}
  function addOwnComment(postId,parentId,text){if(!text.trim())return;const p=currentBoard().posts.find(x=>x.id===postId);if(!p)return;const c={id:uid(),nick:chooseNick(),residentId:'user',text:short(text,3500),likes:0,time:now(),source:'user',replies:[]};if(parentId){const parent=p.comments.find(c=>c.id===parentId)||p.comments.find(c=>c.replies.some(r=>r.id===parentId));if(parent){c.parentId=parent.id;parent.replies.push(c);}}else p.comments.push(c);saved();render();}
  function deletePost(id){if(!confirm('이 게시글과 모든 댓글을 삭제할까요?'))return;const b=currentBoard();b.posts=b.posts.filter(p=>p.id!==id);if(b.lastBatch?.created.includes(id))b.lastBatch.created=b.lastBatch.created.filter(x=>x!==id);saved();postsView='list';render();}
  function resetCommunity(){if(!confirm('현재 커뮤니티의 게시글·댓글·주민 기록을 모두 삭제할까요?'))return;invalidatePending('');runEpoch++;turnCount=0;data.boards[data.settings.selected]=blankBoard();saved();postsView='list';render();}
  function stats(c){return {views:c.views||0,likes:c.likes||0,comments:c.comments.reduce((n,x)=>n+1+x.replies.length,0)};}
  function sortedPosts(){const b=currentBoard();return [...b.posts].sort((a,z)=>b.sort==='recent'?z.time-a.time:((z.likes*5+stats(z).comments*3+z.views/20)/(1+Math.max(0,(now()-z.time)/86400000)*.1))-((a.likes*5+stats(a).comments*3+a.views/20)/(1+Math.max(0,(now()-a.time)/86400000)*.1)));}
  function renderStatus(){if(!panel)return;const el=panel.querySelector('#zab-status');if(el){el.textContent=busy?'게시글 생성 중…':now()<noticeUntil?notice:data?'자동 '+(data.settings.auto?'ON':'OFF')+' · '+turnCount+'/'+data.settings.turns+'턴':'채팅방 연결 대기 중';}const count=launcher?.querySelector('.zab-unread');if(count)count.textContent=data?.boards?.[data.settings.selected]?.unread?'●':'';const cancel=panel.querySelector('#zab-cancel');if(cancel)cancel.hidden=!busy;}
  const tabs=[['basic','기본 설정'],['ai','AI 생성 설정'],['community','커뮤니티 관리'],['people','주민·닉네임'],['data','데이터 관리']];
  function mount(){if(panel||!document.body)return;const style=document.createElement('style');style.textContent=`
  #zab-launch{position:fixed;right:13px;bottom:calc(95px + env(safe-area-inset-bottom,0px));border:1px solid #c4cad3;background:#fff;color:#222;border-radius:999px;padding:10px 14px;font:700 13px system-ui;box-shadow:0 4px 18px #0003;z-index:2147483600;touch-action:none}
  #zab-launch .zab-unread{color:#e34b57;margin-left:4px}
  #zab-panel{position:fixed;right:10px;bottom:calc(145px + env(safe-area-inset-bottom,0px));width:min(400px,calc(100vw - 20px));height:min(610px,75dvh);min-width:245px;min-height:240px;z-index:2147483601;border-radius:14px;background:#fff;color:#24272b;border:1px solid #d9dde2;box-shadow:0 12px 35px #0005;display:flex;flex-direction:column;font:13px/1.5 system-ui;overflow:hidden;box-sizing:border-box}
  #zab-panel[hidden]{display:none!important}#zab-panel *{box-sizing:border-box}#zab-panel button{font:600 12px system-ui;border:1px solid #d5d7df;background:#fff;color:#333;border-radius:7px;padding:7px 9px;cursor:pointer}#zab-panel button:disabled{opacity:.45;cursor:default}#zab-panel button.zab-primary{background:#d94d50;border-color:#d94d50;color:white}#zab-panel button.zab-danger{color:#c03943}#zab-panel button[hidden],#zab-panel [hidden]{display:none!important}
  #zab-panel .zab-head{padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;min-height:45px;cursor:grab;touch-action:none;user-select:none}#zab-panel .zab-head strong{font-size:15px;flex:1}#zab-panel .zab-head button{padding:4px 8px}
  #zab-panel .zab-content{overflow:auto;overscroll-behavior:contain;flex:1;padding:12px;min-height:0}#zab-panel .zab-status{font-size:11px;color:#6d737a;min-height:15px}#zab-panel .zab-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}#zab-panel .zab-flex{display:flex;justify-content:space-between;align-items:center;gap:8px}#zab-panel .zab-tabs{display:flex;gap:4px;overflow-x:auto;white-space:nowrap;padding:2px 0 8px}#zab-panel .zab-tabs button{flex-shrink:0}#zab-panel .zab-tabs .active{color:#d94d50;border-color:#d94d50;background:#fff4f4}#zab-panel .zab-card{border-bottom:1px solid #eee;padding:12px 2px;cursor:pointer}#zab-panel .zab-card:hover{background:#fcfcfc}#zab-panel .zab-card h3{margin:0 0 4px;font-size:14px;line-height:1.4}#zab-panel .zab-card .excerpt{color:#6b6f77;font-size:12px;margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}#zab-panel .zab-meta{font-size:11px;color:#81858c;overflow-wrap:anywhere}#zab-panel .zab-section{padding:10px 0;border-bottom:1px solid #eee}#zab-panel .zab-section h4{margin:0 0 8px;font-size:13px}#zab-panel label{display:block;font-size:12px;font-weight:600;margin:9px 0 4px}#zab-panel input:not([type=checkbox]),#zab-panel select,#zab-panel textarea{width:100%;font:13px/1.5 system-ui;border:1px solid #ced2d9;border-radius:7px;padding:8px;color:#24272b;background:#fff}#zab-panel textarea{resize:vertical;min-height:55px}#zab-panel input[type=number]{max-width:115px}#zab-panel .zab-comment{padding:8px 0;border-bottom:1px solid #f0f0f0}#zab-panel .zab-reply{margin:6px 0 0 17px;border-left:2px solid #e5e5e5;padding-left:10px}#zab-panel .zab-note{font-size:11px;color:#7b8087}#zab-panel .zab-chip{display:inline-block;background:#f1f3f5;color:#696f78;padding:2px 6px;border-radius:6px;font-size:11px}#zab-panel .zab-resize{position:absolute;right:0;bottom:0;width:32px;height:32px;cursor:nwse-resize;touch-action:none;user-select:none;font:20px system-ui;color:#9ba1a9;text-align:right;padding:8px 4px 0 0;background:transparent}#zab-panel .zab-divider{height:1px;background:#eee;margin:10px 0}#zab-panel .zab-toolbar{display:flex;gap:6px;margin:10px 0}#zab-panel .zab-toolbar button{flex:1;white-space:nowrap}#zab-panel .zab-footer{padding:6px 10px;border-top:1px solid #eee;display:flex;align-items:center;gap:8px;justify-content:space-between}#zab-panel p{white-space:pre-wrap;overflow-wrap:anywhere}
  `;document.documentElement.appendChild(style);launcher=document.createElement('button');launcher.type='button';launcher.id='zab-launch';launcher.innerHTML='익명 게시판 <span class="zab-unread"></span>';panel=document.createElement('section');panel.id='zab-panel';panel.hidden=true;panel.innerHTML='<div class="zab-head" id="zab-drag"><strong>제타 익명 게시판</strong><button data-act="settings">⚙</button><button data-act="close">×</button></div><div class="zab-content" id="zab-main"></div><div class="zab-footer"><span class="zab-status" id="zab-status">채팅방 연결 대기 중</span><button id="zab-cancel" data-act="cancel" hidden>생성 취소</button></div><div class="zab-resize" id="zab-resize">◢</div>';
    document.body.append(launcher,panel);launcher.addEventListener('click',()=>{if(launcher.dataset.dragging==='yes'){launcher.dataset.dragging='';return;}panel.hidden=!panel.hidden;if(!panel.hidden){const b=currentBoard();b.unread=0;saved();render();applySize();}});
    panel.addEventListener('click',onClick);panel.addEventListener('change',onChange);panel.addEventListener('input',onInput);installDrag(launcher,launcher,'launch');installDrag(panel.querySelector('#zab-drag'),panel,'panel');installResize(panel.querySelector('#zab-resize'));applySize();render();}
  function applySize(){if(!panel)return;const vw=innerWidth,vh=innerHeight;if(uiPos.w)panel.style.width=Math.min(vw-8,Math.max(Math.min(245,vw-8),uiPos.w))+'px';if(uiPos.h)panel.style.height=Math.min(vh-8,Math.max(Math.min(240,vh-8),uiPos.h))+'px';if(uiPos.x!=null){const w=panel.getBoundingClientRect().width;panel.style.left=Math.max(4,Math.min(uiPos.x,vw-w-4))+'px';panel.style.right='auto';}if(uiPos.y!=null){const h=panel.getBoundingClientRect().height;panel.style.top=Math.max(4,Math.min(uiPos.y,vh-h-4))+'px';panel.style.bottom='auto';}if(uiPos.launch){const r=launcher.getBoundingClientRect();launcher.style.left=Math.max(4,Math.min(uiPos.launch.x,vw-r.width-4))+'px';launcher.style.top=Math.max(4,Math.min(uiPos.launch.y,vh-r.height-4))+'px';launcher.style.right='auto';launcher.style.bottom='auto';}}
  function installDrag(handle,el,type){handle.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button,input,select,textarea'))return;const r=el.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;let moved=false;const move=v=>{if(v.pointerId!==e.pointerId)return;const dx=v.clientX-sx,dy=v.clientY-sy;if(!moved&&Math.hypot(dx,dy)<6)return;moved=true;v.preventDefault();el.style.left=Math.max(4,Math.min(r.left+dx,innerWidth-r.width-4))+'px';el.style.top=Math.max(4,Math.min(r.top+dy,innerHeight-r.height-4))+'px';el.style.bottom='auto';el.style.right='auto';};const end=v=>{if(v.pointerId!==e.pointerId)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);if(moved){const a=el.getBoundingClientRect();if(type==='launch'){uiPos.launch={x:a.left,y:a.top};launcher.dataset.dragging='yes';setTimeout(()=>launcher.dataset.dragging='',250);}else{uiPos.x=a.left;uiPos.y=a.top;}localStorage.setItem(persistedUIKey,JSON.stringify(uiPos));}};window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);});}
  function installResize(handle){handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();const r=panel.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;panel.style.left=r.left+'px';panel.style.top=r.top+'px';panel.style.right='auto';panel.style.bottom='auto';const move=v=>{if(v.pointerId!==e.pointerId)return;v.preventDefault();uiPos.w=Math.max(Math.min(245,innerWidth-8),Math.min(r.width+v.clientX-sx,innerWidth-r.left-4));uiPos.h=Math.max(Math.min(240,innerHeight-8),Math.min(r.height+v.clientY-sy,innerHeight-r.top-4));panel.style.width=uiPos.w+'px';panel.style.height=uiPos.h+'px';};const end=v=>{if(v.pointerId!==e.pointerId)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);uiPos.x=r.left;uiPos.y=r.top;localStorage.setItem(persistedUIKey,JSON.stringify(uiPos));};window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);});}
  function btn(action,text,klass='',extra=''){return `<button type="button" data-act="${esc(action)}" class="${klass}" ${extra}>${esc(text)}</button>`;}
  function inp(name,val,type='text',more=''){return `<input data-setting="${esc(name)}" type="${type}" value="${esc(val)}" ${more}>`;}
  function ta(name,val,rows=3){return `<textarea data-setting="${esc(name)}" rows="${rows}">${esc(val)}</textarea>`;}
  function selection(name,current,opts){return `<select data-setting="${esc(name)}">${opts.map(([id,label])=>`<option value="${esc(id)}" ${id===current?'selected':''}>${esc(label)}</option>`).join('')}</select>`;}
  function render(){if(!panel)return;renderStatus();const node=panel.querySelector('#zab-main');if(!node)return;if(!data){node.innerHTML='<p>제타 채팅방을 열고 메시지가 로드되면 연결됩니다.</p>';return;}node.innerHTML=settingsOpen?renderSettings():postsView==='detail'?renderDetail():postsView==='write'?renderWrite():renderList();}
  function renderList(){const b=currentBoard(),com=currentCommunity();return `<div class="zab-flex"><div><strong style="font-size:17px">${esc(com.name)}</strong><div class="zab-note">${esc(short(com.desc,95))}</div></div><button data-act="pick-community">▾</button></div>
    <div class="zab-toolbar">${btn('write','글쓰기')}${btn('generate','수동 생성','zab-primary')}${btn('regen','다시 생성','',!b.lastBatch?'disabled':'')}</div>
    <div class="zab-flex"><b>전체 게시글 ${b.posts.length}</b><div>${btn('sort-recent','최신순',b.sort==='recent'?'zab-primary':'')}${btn('sort-popular','인기순',b.sort==='popular'?'zab-primary':'')}</div></div>
    ${!b.posts.length?'<div class="zab-section" style="text-align:center;padding:40px 10px;color:#888">게시글이 없어요.<br>수동 생성 버튼으로 첫 게시글을 만들어 보세요.</div>':sortedPosts().map(p=>`<div class="zab-card" data-open="${esc(p.id)}"><h3>${esc(p.title)}</h3><div class="excerpt">${esc(short(p.body,150))}</div><div class="zab-meta">${esc(p.nick)} · ${esc(timeText(p.time))}</div><div class="zab-meta">조회 ${p.views.toLocaleString()} · 좋아요 ${p.likes.toLocaleString()} · 댓글 ${stats(p).comments}</div></div>`).join('')}`;}
  function renderDetail(){const p=currentBoard().posts.find(x=>x.id===detailId);if(!p){postsView='list';return renderList();}const comments=p.comments.map(c=>`<div class="zab-comment"><div><b>${esc(c.nick)}</b> <span class="zab-meta">${timeText(c.time)} · ♥ ${c.likes}</span></div><p style="margin:4px 0">${esc(c.text)}</p>${btn('reply:'+c.id,'답글','',`data-post="${esc(p.id)}"`)}${c.replies.map(r=>`<div class="zab-reply"><b>${esc(r.nick)}</b> <span class="zab-meta">♥ ${r.likes}</span><p style="margin:4px 0">${esc(r.text)}</p>${btn('reply:'+c.id,'답글','',`data-post="${esc(p.id)}"`)}</div>`).join('')}</div>`).join('');return `<div class="zab-flex">${btn('back','← 목록')} <div>${btn('react','AI 반응 생성','zab-primary')}${btn('delete','게시글 삭제','zab-danger','')}</div></div><div class="zab-section"><span class="zab-meta">${esc(p.nick)} · ${timeText(p.time)}</span><h2 style="margin:10px 0;font-size:17px">${esc(p.title)}</h2><p>${esc(p.body)}</p><div class="zab-meta">조회 ${p.views} · 좋아요 ${p.likes} · 댓글 ${stats(p).comments}</div></div><div class="zab-section"><b>댓글 ${stats(p).comments}</b>${comments||'<p class="zab-note">아직 댓글이 없어요.</p>'}</div><label>댓글 작성</label><textarea id="zab-comment-text" rows="2" placeholder="댓글 입력"></textarea>${btn('send-comment','댓글 등록','zab-primary')}<div id="zab-reply-area"></div>`;}
  function renderWrite(){return `${btn('back','← 목록')}<h3>게시글 작성</h3><label>제목</label><input id="zab-own-title" maxlength="180" placeholder="제목"><label>본문</label><textarea id="zab-own-body" rows="8" placeholder="게시글 내용"></textarea><div class="zab-toolbar">${btn('publish','게시글 등록','zab-primary')}${btn('back','취소')}</div><p class="zab-note">직접 작성한 글은 RP 리롤과 AI 다시 생성으로 삭제되지 않아요.</p>`;}
  function renderSettings(){const s=data.settings;return `${btn('settings-back','← 게시판으로')}<h3 style="margin:12px 0 8px">게시판 설정</h3><div class="zab-tabs">${tabs.map(([id,name])=>btn('tab:'+id,name,settingTab===id?'active':'')).join('')}</div><div class="zab-section">${settingTab==='basic'?`<h4>기본 설정</h4><label><input type="checkbox" data-setting="auto" ${s.auto?'checked':''}> 자동 갱신 ON</label><label>자동 갱신 주기 (턴)</label>${inp('turns',s.turns,'number','min="1" max="999" step="1"')}<p class="zab-note">테스트 초기값 1턴 · 정식 사용 권장 3턴 · 완료 후 15초 대기</p><p class="zab-note">상태는 간단하게 표시하고 새 글이 생기면 작은 알림을 표시합니다.</p>`:
  settingTab==='ai'?`<h4>AI 생성 설정</h4><label>Gemini API 키</label><div class="zab-row"><input id="zab-api-key" type="password" placeholder="키 입력 후 저장" style="flex:1;min-width:100px" autocomplete="off">${btn('save-key','키 저장')}</div><p class="zab-note">키는 Tampermonkey 저장소에만 보관하며 JSON 백업에 포함하지 않아요.</p><label>Gemini 모델</label>${modelSelection()}<div class="zab-row">${btn('models','모델 목록 불러오기')}</div><label>새 게시글 수</label>${inp('posts',s.posts,'number','min="1" max="15"')}<label>새 게시글당 최대 댓글 수</label>${inp('newComments',s.newComments,'number','min="0" max="30"')}<label>기존 글 추가 댓글 전체 최대 개수</label>${inp('oldComments',s.oldComments,'number','min="0" max="100"')}<label>기존 댓글 추가 대상 최근 게시글 수</label>${inp('oldPostWindow',s.oldPostWindow,'number','min="0" max="300"')}<label>공개적으로 목격된 새 사건이 없을 때</label>${selection('quiet',s.quiet,[['daily','일상 게시글 생성'],['skip','게시글 생성 안 함'],['rumors','기존 소문 이어가기']])}<label>추가 말투·생성 지침</label>${ta('guide',s.guide,4)}<div class="zab-divider"></div><h4>제타 프로필 자동 수집</h4><div class="zab-row">${btn('refresh-profiles','유저·캐릭터 프로필 불러오기','zab-primary')}</div><p class="zab-note" id="zab-profile-status">${esc(profileInfo)} · 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.user?'확인':'미확인'}</p><p class="zab-note" id="zab-profile-list">${esc(profileCache.characters.map(p=>p.name).join(', ')||'확인된 캐릭터가 없습니다.')}</p><p class="zab-note">불러온 프로필은 Gemini 생성 지침에 자동 포함됩니다. 아래 입력은 누락 정보 보완용입니다.</p><label>세계관 설정·배경</label>${ta('profiles.world',s.profiles.world,4)}<label>유저 프로필 (수동 보완)</label>${ta('profiles.user',s.profiles.user,3)}<label>등장 캐릭터 프로필 (여러 명 가능)</label>${ta('profiles.characters',s.profiles.characters,5)}`:
  settingTab==='community'?`<h4>커뮤니티 관리</h4><label>현재 커뮤니티</label>${selection('selected',s.selected,[...presets,...s.custom].map(x=>[x.id,x.name]))}<p class="zab-note">커뮤니티를 변경해도 게시글·주민 기록은 보존되고 자동 갱신은 0턴부터 다시 시작합니다.</p><h4>사용자 지정 커뮤니티 만들기</h4><label>이름</label><input id="zab-custom-name" placeholder="예: 우리 학교 대나무숲"><label>소개·분위기</label><textarea id="zab-custom-desc" rows="3"></textarea><label>닉네임 형식</label><input id="zab-custom-nick" placeholder="예: 익명, ㅇㅇ, 동네산책러"><label>말투 지침</label><textarea id="zab-custom-style" rows="3"></textarea>${btn('add-custom','커뮤니티 추가','zab-primary')}<h4 style="margin-top:18px">사용자 지정 커뮤니티</h4>${s.custom.length?s.custom.map(c=>`<div class="zab-flex zab-section"><span>${esc(c.name)}</span>${btn('edit-custom:'+c.id,'수정')}${btn('remove-custom:'+c.id,'삭제')}</div>`).join(''):'<p class="zab-note">아직 추가한 커뮤니티가 없어요.</p>'}`:
  settingTab==='people'?`<h4>내 닉네임</h4>${selection('userNickMode',s.userNickMode,[['auto','커뮤니티별 자동 부여'],['custom','직접 설정']])}<label>직접 사용할 닉네임</label>${inp('userNick',s.userNick)}<p class="zab-note">변경한 닉네임은 이후 작성하는 글부터 적용합니다.</p><h4>고정 주민 닉네임 수정</h4>${Object.values(currentBoard().residents).length?Object.values(currentBoard().residents).map(r=>`<div class="zab-flex"><span style="font-size:11px;max-width:100px;overflow-wrap:anywhere">${esc(r.id)}</span><input data-resident="${esc(r.id)}" value="${esc(r.nick)}" maxlength="60"></div>`).join(''):'<p class="zab-note">아직 등장한 고정 주민이 없어요.</p>'}<p class="zab-note">수정한 이름은 새 활동부터 적용되고 과거 게시글 표시는 유지돼요.</p>`:
  `<h4>데이터 관리</h4><div class="zab-row">${btn('export','JSON 내보내기','zab-primary')}${btn('import','JSON 가져오기')}</div><input type="file" id="zab-import-file" accept="application/json,.json" hidden><p class="zab-note">가져오기할 때 덮어쓰기와 합치기 중 선택합니다. Gemini API 키는 제외됩니다.</p><div class="zab-divider"></div>${btn('reset-community','현재 커뮤니티 초기화','zab-danger')}<p class="zab-note">다른 커뮤니티·채팅방의 기록은 영향을 받지 않아요.</p>`}</div>`;}
  async function onClick(e){const b=e.target.closest('button[data-act]');if(!b){const card=e.target.closest('[data-open]');if(card){detailId=card.dataset.open;postsView='detail';render();}return;}const a=b.dataset.act;if(a==='close'){panel.hidden=true;return;}if(a==='settings'){settingsOpen=!settingsOpen;render();return;}if(a==='settings-back'){settingsOpen=false;render();return;}if(a.startsWith('tab:')){settingTab=a.slice(4);render();if(settingTab==='ai')updateProfileStatus();return;}if(a==='pick-community'){settingsOpen=true;settingTab='community';render();return;}if(a==='write'){postsView='write';render();return;}if(a==='back'){postsView='list';render();return;}if(a==='publish'){makeOwnPost(panel.querySelector('#zab-own-title')?.value||'',panel.querySelector('#zab-own-body')?.value||'');return;}if(a==='generate')return generate('manual');if(a==='regen')return generate('regenerate');if(a==='cancel'){cancelBusy();show('생성을 취소했어요. 0턴부터 시작합니다.');return;}if(a==='sort-recent'||a==='sort-popular'){currentBoard().sort=a==='sort-recent'?'recent':'popular';saved();render();return;}if(a==='delete')return deletePost(detailId);if(a==='send-comment'){addOwnComment(detailId,'',panel.querySelector('#zab-comment-text')?.value||'');return;}if(a.startsWith('reply:')){const area=panel.querySelector('#zab-reply-area');if(area){const id=a.slice(6);area.innerHTML=`<label>대댓글 작성</label><textarea id="zab-reply-text" rows="2"></textarea><button data-act="send-reply:${esc(id)}" class="zab-primary">등록</button>`;}return;}if(a.startsWith('send-reply:')){addOwnComment(detailId,a.slice(11),panel.querySelector('#zab-reply-text')?.value||'');return;}if(a==='react'){return generate('react',currentBoard().posts.find(x=>x.id===detailId));}if(a==='save-key'){setKey(panel.querySelector('#zab-api-key')?.value||'');panel.querySelector('#zab-api-key').value='';show('API 키를 저장했어요.');return;}if(a==='models')return fetchModels();if(a==='check-model')return checkSelectedModel();if(a==='set-manual-model'){const id=String(panel.querySelector('#zab-manual-model')?.value||'').trim().replace(/^models\//,'');if(!/^[a-zA-Z0-9._-]{3,100}$/.test(id))return show('올바른 Gemini 모델 ID를 입력하세요.');data.settings.model=id;saveSettings();return show('모델을 '+id+'로 설정했어요.');}if(a==='refresh-profiles'){profileInfo='프로필을 불러오는 중…';updateProfileStatus();bridge('profiles');return;}if(a==='add-custom'){const name=panel.querySelector('#zab-custom-name')?.value.trim();if(!name)return show('커뮤니티 이름을 입력해 주세요.');const c={id:'custom-'+uid(),name:short(name,80),desc:short(panel.querySelector('#zab-custom-desc')?.value,2000),nick:short(panel.querySelector('#zab-custom-nick')?.value,400),style:short(panel.querySelector('#zab-custom-style')?.value,2000)};data.settings.custom.push(c);saveSettings();show('커뮤니티가 추가됐어요.');return;}if(a.startsWith('edit-custom:')){const id=a.slice(12),c=data.settings.custom.find(x=>x.id===id);if(!c)return;const name=prompt('커뮤니티 이름',c.name);if(name===null)return;const desc=prompt('커뮤니티 설명·분위기',c.desc);if(desc===null)return;const nick=prompt('닉네임 형식',c.nick);if(nick===null)return;const style=prompt('말투 지침',c.style);if(style===null)return;Object.assign(c,{name:short(name,80)||c.name,desc:short(desc,2000),nick:short(nick,400),style:short(style,2000)});saveSettings();return;}if(a.startsWith('remove-custom:')){const id=a.slice(14);if(!confirm('커뮤니티 설정을 삭제할까요? 기록도 삭제하려면 데이터 관리에서 먼저 초기화해 주세요.'))return;data.settings.custom=data.settings.custom.filter(x=>x.id!==id);if(data.settings.selected===id)communityChange('everytime');saveSettings();return;}if(a==='reset-community')return resetCommunity();if(a==='export')return exportJSON();if(a==='import')return panel.querySelector('#zab-import-file')?.click();}
  function onInput(e){const el=e.target;if(!el.dataset.resident)return;const r=currentBoard().residents[el.dataset.resident];if(r){r.nick=short(el.value,60);saved();}}
  function onChange(e){const el=e.target;if(el.id==='zab-import-file'){const file=el.files?.[0];if(file)importJSON(file);el.value='';return;}const name=el.dataset.setting;if(!name||!data)return;const s=data.settings,v=el.type==='checkbox'?el.checked:el.value;if(name==='auto')return toggleAuto(v);if(name==='selected')return communityChange(v);if(name.startsWith('profiles.')){s.profiles[name.slice(9)]=short(v,20000);}else if(['turns','posts','newComments','oldComments','oldPostWindow'].includes(name)){const limits={turns:[1,999],posts:[1,15],newComments:[0,30],oldComments:[0,100],oldPostWindow:[0,300]};s[name]=num(v,...limits[name],defaults()[name]);if(name==='turns'){runEpoch++;clearTimeout(autoTimer);turnCount=0;}}else s[name]=v;saveSettings();}
  function exportJSON(){if(!data)return;const payload={format:'zeta-anonymous-board',version:VERSION,exportedAt:new Date().toISOString(),room:data.room,settings:copy(data.settings),boards:copy(data.boards)};delete payload.settings.apiKey;const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='zeta-anonymous-board-'+data.room.slice(0,8)+'-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),45000);show('JSON 백업 다운로드를 요청했어요.');}
  async function importJSON(file){if(file.size>25*1024*1024)return show('25MB를 넘는 파일은 가져올 수 없어요.');let obj;try{obj=JSON.parse(await file.text());}catch{return show('JSON 파일을 해석할 수 없어요.');}if(obj?.format!=='zeta-anonymous-board'||!obj.room||!obj.boards||typeof obj.boards!=='object'||Array.isArray(obj.boards)||!obj.settings)return show('제타 익명 게시판 백업 형식이 아니에요.');if(obj.room!==room&&!confirm('백업의 채팅방 ID가 현재 방과 달라요. 현재 방에 복원할까요?'))return;const choice=prompt('복원 방식 선택: 1 = 덮어쓰기, 2 = 합치기','2');if(!['1','2'].includes(choice))return;const before=copy(data);try{if(choice==='1'){data.settings={...defaults(),...obj.settings,selected:obj.settings.selected||'everytime'};data.boards=copy(obj.boards);}else{for(const [id,src] of Object.entries(obj.boards)){if(!src||!Array.isArray(src.posts))continue;const target=data.boards[id]||(data.boards[id]=blankBoard());const ids=new Map(target.posts.map(p=>[p.id,p]));for(const p of src.posts){if(!p?.id||!Array.isArray(p.comments))continue;if(!ids.has(p.id)){target.posts.push(p);ids.set(p.id,p);}else{const existing=ids.get(p.id);if(existing.title!==p.title||existing.body!==p.body){if(confirm('중복 게시글 내용이 달라요. 백업 내용으로 덮어쓸까요?\n'+p.title))Object.assign(existing,p);}else{const comments=new Set(existing.comments.map(x=>x.id));for(const c of p.comments)if(c.id&&!comments.has(c.id)){existing.comments.push(c);comments.add(c.id);}}}}target.residents={...safeObj(src.residents),...safeObj(target.residents)};target.started=target.started||src.started||target.posts.length>0;}
      for(const c of safeArray(obj.settings.custom)){if(!data.settings.custom.some(x=>x.id===c.id))data.settings.custom.push(c);}}
      for(const b of Object.values(data.boards)){b.posts=safeArray(b.posts).filter(p=>p&&p.id&&Array.isArray(p.comments)).slice(0,10000);b.residents=safeObj(b.residents);b.lastBatch=null;b.unread=0;}
      runEpoch++;cancelBusy();turnCount=0;await writeRoom(data);show('백업 복원이 완료됐어요.');settingsOpen=false;render();}catch(e){data=before;show('복원 실패: '+e.message);}}
  const safeObj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
  window.addEventListener('resize',applySize);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
  // Only expose non-sensitive diagnostic information. Authentication never leaves the Zeta page bridge.
  window.zetaAnonymousBoardDiagnostics=()=>({version:VERSION,room,turnCount,turns:observedTurns.length,auto:!!data?.settings.auto,community:data?.settings.selected,busy:!!busy});
})();