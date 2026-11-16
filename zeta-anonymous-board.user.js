// ==UserScript==
// @name         제타 익명 게시판
// @namespace    zeta-anonymous-board
// @version      0.9.3
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
  const VERSION='0.9.3', DB='zeta-anonymous-board-v1', API='https://api.zeta-ai.io';
  const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  // Recommendations are candidates based on the user-provided comparison, not verified quotas.
  // Actual model availability and free-tier limits depend on the API key and project.
  const recommendedModels=[
    {id:'gemini-3.5-flash-lite',label:'Gemini 3.5 Flash-Lite · 무료 자동 갱신 기본 추천'},
    {id:'gemini-3.1-flash-lite',label:'Gemini 3.1 Flash-Lite · 기본 대체 모델'},
    {id:'gemini-3.8-flash',label:'Gemini 3.8 Flash · 고품질 수동 생성 후보'}
  ];
  const models=recommendedModels.map(x=>x.id);
  const presets=[
    {id:'everytime',name:'에브리타임',desc:'학생 커뮤니티, 익명번호, 학식·수업·연애·학교 소문, 가벼운 반말',nick:'익명1, 익명2, 글쓴이',style:'학생 익명 게시판 특유의 간결한 말투'},
    {id:'blind',name:'블라인드',desc:'회사원 커뮤니티, 직장·이직·연애·업계 소문',nick:'회사명 · 닉네임',style:'직장인의 솔직한 현실적 말투'},
    {id:'office',name:'사내 익명 게시판',desc:'같은 회사 직원들이 일상과 소문을 나눔',nick:'팀/부서명 · 별명',style:'사내 익명 게시판 말투'},
    {id:'reddit',name:'Reddit',desc:'서브레딧식 토론, 농담과 반응',nick:'u/name',style:'Reddit 토론 문화에 맞는 말투를 한국어로 자연스럽게 표현'},
    {id:'x',name:'X',desc:'짧은 글, 실시간 화제와 반응',nick:'@handle',style:'짧고 속도감 있는 SNS 말투'},
    {id:'neighborhood',name:'동네 게시판',desc:'동네 생활, 목격담과 지역 정보',nick:'동네산책러, 이웃주민',style:'주민 카페 말투'},
    {id:'gallery',name:'갤러리',desc:'세계관에 어울리는 관심사와 일상을 나누는 한국어 게시판',nick:'ㅇㅇ(가상 IP), 고정닉',style:'자연스러운 반말과 갤러리식 표현'}
  ];
  const defaults=()=>({timeMode:'real',auto:true,showParticipationDot:true,highlightPostAuthor:true,turns:1,autoDelaySeconds:10,posts:3,newComments:7,oldComments:10,oldPostWindow:20,quiet:'daily',model:'gemini-3.5-flash-lite',fallback:'gemini-3.1-flash-lite',temperature:0.9,guide:'',communityGuides:{},userNickMode:'auto',userNick:'',selected:'everytime',boardTitles:{},topTitles:{},translationEnabled:{reddit:true},galleryDescription:'',communityConfirmed:false,custom:[],status:'',profiles:{user:'',characters:'',world:''},profileSelection:{userId:'',characterIds:[]},savedProfiles:null});
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
  // A single readwrite transaction removes all board records. API credentials
  // reside in GM storage and are deliberately never accessed by reset actions.
  async function clearAllRoomRecords(){
    const db=await openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('rooms','readwrite');
      tx.objectStore('rooms').clear();
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error('초기화 실패'));
      tx.onabort=()=>reject(tx.error||new Error('초기화 취소'));
    });
  }
  // Basic/API preferences are global. Board data and turn progress stay room-scoped.
  const GLOBAL_PREF_KEY='zab-global-basic-api-v1';
  const GLOBAL_PREF_FIELDS=['auto','showParticipationDot','highlightPostAuthor','turns','autoDelaySeconds','posts','newComments','oldComments','oldPostWindow','quiet','model','fallback','temperature'];
  function readGlobalPreferences(){
    let stored={};
    try{const v=GM_getValue(GLOBAL_PREF_KEY,{});stored=typeof v==='string'?JSON.parse(v):v;}catch{}
    const def=defaults();if(!stored||typeof stored!=='object'||Array.isArray(stored))stored={};
    const next={};
    for(const key of GLOBAL_PREF_FIELDS)next[key]=Object.prototype.hasOwnProperty.call(stored,key)?stored[key]:def[key];
    next.auto=!!next.auto;
    next.showParticipationDot=next.showParticipationDot!==false;
    next.highlightPostAuthor=next.highlightPostAuthor!==false;
    next.turns=num(next.turns,1,999,def.turns);
    next.autoDelaySeconds=num(next.autoDelaySeconds,1,300,def.autoDelaySeconds);
    for(const [key,lo,hi] of [['posts',1,15],['newComments',0,30],['oldComments',0,100],['oldPostWindow',0,300]])
      next[key]=num(next[key],lo,hi,def[key]);
    if(!['daily','skip','rumors'].includes(next.quiet))next.quiet=def.quiet;
    next.model=short(next.model,100)||def.model;
    next.fallback=short(next.fallback,100);
    const temp=Number(next.temperature);
    next.temperature=Number.isFinite(temp)?Math.max(0,Math.min(2,temp)):def.temperature;
    return next;
  }
  let globalPreferences=readGlobalPreferences();
  function applyGlobalPreferences(){
    if(!data)return;
    for(const key of GLOBAL_PREF_FIELDS)data.settings[key]=globalPreferences[key];
  }
  function persistGlobalPreferences(){
    if(!data)return;
    const next={...globalPreferences};
    for(const key of GLOBAL_PREF_FIELDS)next[key]=data.settings[key];
    try{GM_setValue(GLOBAL_PREF_KEY,next);}catch(e){show('공통 설정 저장 실패: '+String(e.message||e));return;}
    globalPreferences=next;
    applyGlobalPreferences();
  }
  function refreshGlobalPreferences(){
    const next=readGlobalPreferences();
    if(GLOBAL_PREF_FIELDS.some(key=>next[key]!==globalPreferences[key])){
      const oldAuto=globalPreferences.auto,oldTurns=globalPreferences.turns,oldDelay=globalPreferences.autoDelaySeconds;
      globalPreferences=next;
      applyGlobalPreferences();
      if(data&&(oldAuto!==next.auto||oldTurns!==next.turns||oldDelay!==next.autoDelaySeconds)){
        invalidatePending('');runEpoch++;turnCount=0;
        clearTimeout(autoTimer);autoTimer=null;clearTimeout(autoRetryTimer);autoRetryTimer=null;
        pendingAutoCheck=null;autoWaitUntil=0;autoStage='';
      }
      render();
    }
  }
  function blankRoom(id){return {room:id,settings:defaults(),boards:{},updatedAt:now()};}
  function blankBoard(){return {posts:[],residents:{},sort:'recent',started:false,seen:{},lastBatch:null,unread:0};}
  let room='',data=null,postsView='list',detailId='',settingsOpen=false,profilePanelOpen=false,settingTab='basic',profileSectionOpen=true,communityDraft=null,panel=null,launcher=null,notice='',noticeUntil=0;
  let busy=null,pending=null,turnCount=0,activeTurnKey='',activeTurnHash='',lastTurnKeys=[],baselineReady=false,autoTimer=null,latestTimer=null,loadBusy=false,lastLiveSync=0,runEpoch=0,pendingAutoCheck=null;
  let seenTurnIds=new Set(),lastTurnTime=0,autoRetryTimer=null,autoWaitUntil=0,autoStage='',turnEvents=0;
  let profileCollectionActive=false, profileDraftSelection={userId:'',characterIds:[]};
  let profileCache={characters:[],users:[],plot:null}, profileDetection={seen:0,paths:new Set(),lastPath:'',apiError:''}, profileInfo='프로필 연결 대기 중', profileRequestRoom='', profileWaitTimer=null,profileAttempt=0, captured=null, networkRoom='',roomMarker='';
  const page=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
  const bridgeId='zab-'+Math.random().toString(36).slice(2);
  let bridgeInstallError='';
  // The page bridge keeps Zeta authorization in page context. It NEVER sends headers to the userscript UI or Gemini.
  function installBridge(){
    const fn=function(channel){
      // Explicitly use the real page window. A function called with .call(page)
      // otherwise still resolves its captured userscript sandbox global.
      const window=this;
      const XMLHttpRequest=window.XMLHttpRequest;
      const Headers=window.Headers;
      const URL=window.URL;
      const location=window.location;
      const document=window.document;
      const MutationObserver=window.MutationObserver;
      const AbortController=window.AbortController;
      if(window.__zabPageBridge)return;window.__zabPageBridge=true;
      const origin='https://api.zeta-ai.io', allowed=['authorization','x-client-native-version','x-client-type','x-client-version','x-device-type','x-user-language'];
      let headers={},currentRoom='',base=window.fetch;
      const xhrOpen=XMLHttpRequest.prototype.open,xhrSend=XMLHttpRequest.prototype.send,xhrHeader=XMLHttpRequest.prototype.setRequestHeader;const xhrMap=new WeakMap();
      const emit=(type,obj)=>window.postMessage({tag:'zab-bridge',channel,type,...obj},'*');
      const parse=u=>{try{const v=new URL(String(u),location.href);return v.origin===origin?v:null;}catch{return null;}};
      function addHeaders(h){try{const entries=h instanceof Headers?h.entries():Array.isArray(h)?h:Object.entries(h||{});for(const [name,value] of entries){if(allowed.includes(String(name).toLowerCase()))headers[String(name).toLowerCase()]=String(value);}}catch{}}
      function seeRoom(u){const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m&&m[1]!==currentRoom){currentRoom=m[1];emit('room',{room:currentRoom});}}
      function observe(url,response){
        const endpoint=parse(url);if(!endpoint||!response?.ok)return;
        const path=endpoint.pathname;
        const isMsg=/\/v1\/rooms\/[\da-f-]{36}\/messages\/?$/i.test(path);
        const isProfile=/\/v1\/rooms\/[\da-f-]{36}\/?$/i.test(path)||/\/plots\/|profile|persona|character/i.test(path);
        if(!isMsg&&!isProfile)return;
        response.clone().json().then(v=>{
          if(isMsg&&Array.isArray(v?.messages)){const match=/\/v1\/rooms\/([0-9a-f-]{36})\/messages\/?$/i.exec(path);if(match&&match[1]===currentRoom)emit('messages',{room:currentRoom,messages:v.messages});}
          else if(isProfile){
            const isPersona=/\/user-personas\/(?:select|selected)\/?$/i.test(path);
            emit('profile',{room:currentRoom,profile:isPersona?{userProfile:v}:v,path});collectObservedProfiles(path,v);
          }
        }).catch(()=>{});
      }
      window.fetch=function(input,init){let url='';try{url=typeof input==='string'?input:input instanceof URL?input.href:input?.url||'';if(parse(url)){addHeaders(init?.headers||input?.headers);seeRoom(url);}}catch{}const r=base.apply(this,arguments);if(parse(url))Promise.resolve(r).then(v=>observe(url,v)).catch(()=>{});return r;};
      XMLHttpRequest.prototype.open=function(method,url){xhrMap.set(this,{url:String(url),headers:[]});return xhrOpen.apply(this,arguments);};
      XMLHttpRequest.prototype.setRequestHeader=function(k,v){const state=xhrMap.get(this);if(state&&parse(state.url))state.headers.push([k,v]);return xhrHeader.apply(this,arguments);};
      XMLHttpRequest.prototype.send=function(){const state=xhrMap.get(this);if(state&&parse(state.url)){seeRoom(state.url);addHeaders(state.headers);this.addEventListener('load',()=>{
          try{
            if(this.status<200||this.status>=300)return;
            const o=this.responseType==='json'?this.response:
              (!this.responseType||this.responseType==='text')?JSON.parse(this.responseText):null;
            if(!o||typeof o!=='object')return;
            const path=parse(state.url)?.pathname||'';
            if(/\/v1\/rooms\/[\da-f-]{36}\/messages\/?$/i.test(path)&&Array.isArray(o.messages)){
              const match=/\/v1\/rooms\/([0-9a-f-]{36})\/messages\/?$/i.exec(path);if(match&&match[1]===currentRoom)emit('messages',{room:currentRoom,messages:o.messages});}
            else if(/\/v1\/rooms\/[\da-f-]{36}\/?$/i.test(path)||/\/plots\/|profile|persona|character/i.test(path)){
              const persona=/\/user-personas\/(?:select|selected)\/?$/i.test(path);
              emit('profile',{room:currentRoom,profile:persona?{userProfile:o}:o,path});collectObservedProfiles(path,o);
            }
          }catch{}
        },{once:true});}return xhrSend.apply(this,arguments);};
      // Independent copy of zeta-profiles-mob's *detection strategy*: watch Zeta's
      // own profile requests AND visible CharacterDescription dialogs. No references
      // to zetaCurrentProfiles, its events, or any other installed userscript.
      const visibleDescriptions=new Map();
      let knownCharacters=new Map(), knownPlot='';
      function inspectProfileScreen(){
        if(!currentRoom||!document.body)return;
        try{
          const overlays=document.querySelectorAll('[data-sentry-component="CharacterDescription"]');
          for(const section of overlays){
            if(section.closest('[hidden],[aria-hidden="true"]')||!section.getClientRects().length)continue;
            const body=section.querySelector('.whitespace-pre-wrap')||section;
            const text=(body.innerText||'').trim();if(!text||text.length>20000)continue;
            const root=section.parentElement, headings=root?.querySelectorAll('h3,[role="heading"]')||[];
            let title='';
            for(const h of headings){const name=(h.textContent||'').trim();if(name&&name.length<160){title=name;break;}}
            if(!title)continue;
            const roomCandidate=[...knownCharacters.values()].find(x=>x.name===title);
            // Do not reinterpret an unrelated UI dialog as a character profile.
            if(knownCharacters.size&&!roomCandidate)continue;
            const id=roomCandidate?.id||'';
            const key=(id||title)+'|'+text;
            if(visibleDescriptions.get(title)===key)continue;
            visibleDescriptions.set(title,key);
            emit('profile',{room:currentRoom,path:'/ui/character-description',profile:{characters:[{id,name:title,description:text}]}});
          }
        }catch{}
      }
      // Mirrors the mob source's room-plot character list and plot introduction logic.
      function collectObservedProfiles(path,payload){
        if(!payload||typeof payload!=='object'||Array.isArray(payload))return;
        const roomMatch=/^\/v1\/rooms\/([0-9a-f-]{36})\/?$/i.exec(path);
        if(roomMatch&&roomMatch[1]!==currentRoom)return;
        if(roomMatch&&payload.plot&&typeof payload.plot==='object'){
          const chars=Array.isArray(payload.plot.characters)?payload.plot.characters:[];
          knownCharacters=new Map(chars.map(c=>[String(c?.id||''),{id:String(c?.id||''),name:String(c?.name||''),description:String(c?.description||'')}]).filter(([id,v])=>id||v.name));
          knownPlot=String(payload.plot.id||'');
        }
        if(knownPlot&&path==='/v1/plots/'+knownPlot&&Array.isArray(payload.about?.characters)){
          const chars=payload.about.characters.map(c=>({id:c.characterId,name:knownCharacters.get(String(c.characterId||''))?.name||'',description:c.description||''})).filter(c=>c.name&&c.description);
          if(chars.length)emit('profile',{room:currentRoom,path,profile:{characters:chars}});
        }
        inspectProfileScreen();
      }
      let scanPending=false;
      function scheduleScreenScan(){if(scanPending)return;scanPending=true;setTimeout(()=>{scanPending=false;inspectProfileScreen();},150);}
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{
        new MutationObserver(scheduleScreenScan).observe(document.body,{subtree:true,childList:true});inspectProfileScreen();
      },{once:true});
      else if(document.body){new MutationObserver(scheduleScreenScan).observe(document.body,{subtree:true,childList:true});inspectProfileScreen();}
      const discover=()=>{const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m&&m[1]!==currentRoom){currentRoom=m[1];emit('room',{room:currentRoom});}};
      // Use the same cursor-based source messages as chat-export DEV.
      // First read loads all history; later reads replace the newest segment
      // until its boundary overlaps the previous snapshot.
      let latestBusy=false,latestQueued=null,historyRoom='',historyMessages=[];
      async function latest(requestId=''){
        discover();
        const target=currentRoom;
        if(!target||!headers.authorization){
          emit('messagesStatus',{room:target,ok:false,error:'제타 인증 정보 없음'});
          if(requestId)emit('latestEnd',{room:target,requestId,ok:false});
          return;
        }
        if(latestBusy){if(requestId)latestQueued=requestId;return;}
        latestBusy=true;
        if(historyRoom!==target){historyRoom=target;historyMessages=[];}
        const previous=historyMessages;
        const oldIds=new Set(previous.map(m=>m.id));
        const fetched=[],seen=new Set(),cursors=new Set();
        let cursor='',limit=100,ok=false,error='',pages=0,throttles=0,overlapAt=-1,completed=false;
        try{
          for(let page=0;page<300;page++){
            if(target!==currentRoom)break;
            const url=origin+'/v1/rooms/'+target+'/messages?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'');
            const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),10000);
            let response;
            try{response=await base.call(window,url,{headers:{...headers},credentials:'include',cache:'no-store',signal:controller.signal});}
            catch(e){throw new Error(controller.signal.aborted?'제타 메시지 API 응답 시간 초과 (10초)':String(e.message||e));}
            finally{clearTimeout(deadline);}
            if((response.status===400||response.status===422)&&limit!==20){limit=20;page--;continue;}
            if(response.status===429){if(++throttles>4){error='제타 API 요청 제한 (429)';break;}await new Promise(r=>setTimeout(r,2500));page--;continue;}
            throttles=0;
            if(!response.ok){error='제타 메시지 API HTTP '+response.status;break;}
            const body=await response.json();
            if(!Array.isArray(body.messages)){error='메시지 응답 형식 오류';break;}
            pages++;
            if(target===currentRoom)emit('messagesStatus',{room:target,loading:true,ok:false,pages,count:fetched.length+body.messages.length});
            for(const m of body.messages){
              if(!m||typeof m.id!=='string'||seen.has(m.id))continue;
              seen.add(m.id);fetched.push(m);
            }
            // A page boundary with an existing ID lets us reuse the older
            // suffix without refetching the entire history every 8 seconds.
            if(previous.length&&fetched.length){
              const boundary=fetched[fetched.length-1].id;
              overlapAt=previous.findIndex(m=>m.id===boundary);
              if(overlapAt>=0){completed=true;break;}
            }
            if(!body.nextCursor||!body.messages.length){completed=true;break;}
            if(typeof body.nextCursor!=='string'||cursors.has(body.nextCursor)){error='페이지 커서 중복';break;}
            cursors.add(body.nextCursor);cursor=body.nextCursor;
            await new Promise(r=>setTimeout(r,220));
          }
          if(target===currentRoom&&completed){
            historyMessages=overlapAt>=0?[...fetched,...previous.slice(overlapAt+1).filter(m=>!seen.has(m.id))]:fetched;
            emit('messages',{room:target,messages:historyMessages,latest:true});
            ok=true;
          }else if(!error)error='메시지 수집 미완료';
        }catch(e){error=String(e.message||e);}
        finally{
          if(target===currentRoom){
            emit('messagesStatus',{room:target,ok,count:historyMessages.length,pages,error});
            if(requestId)emit('latestEnd',{room:target,requestId,ok});
          }
          latestBusy=false;
          if(latestQueued){const next=latestQueued;latestQueued=null;latest(next);}
        }
      }
      // Explicit profile refresh reads the same room/plot endpoints used by Zeta's
      // memory assistant.  Never expose authorization headers outside the bridge.
      let profileEpoch=0;
      async function refreshProfiles(){
        discover();const forRoom=currentRoom, epoch=++profileEpoch;
        if(!forRoom||!headers.authorization){emit('profileError',{room:forRoom,message:'인증 정보를 찾지 못했어요. 제타 채팅방을 새로고침한 뒤 다시 시도하세요.'});return;}
        const errors=[];let count=0,characters=0,userFound=false;
        // Every individual call has a deadline. A slow optional endpoint may not block completion.
        const request=async(path,deadline=7000)=>{
          const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),deadline);
          try{
            const res=await base.call(window,origin+path,{headers:{...headers},credentials:'include',cache:'no-store',signal:ctrl.signal});
            if(!res.ok)throw new Error('HTTP '+res.status);
            return await res.json();
          }finally{clearTimeout(timeout);}
        };
        const stillCurrent=()=>epoch===profileEpoch&&forRoom===currentRoom;
        let plotId='';
        try{
          let roomData=null;
          try{
            roomData=await request('/v1/rooms/'+forRoom);
            if(!stillCurrent())return;
            count++;characters=Array.isArray(roomData?.plot?.characters)?roomData.plot.characters.length:0;
            emit('profile',{room:forRoom,profile:roomData,path:'/v1/rooms/'+forRoom});collectObservedProfiles('/v1/rooms/'+forRoom,roomData);
            plotId=String(roomData?.plot?.id||roomData?.plotId||roomData?.plot_id||'');
          }catch(e){errors.push('채팅방 상세: '+String(e.message||e));}
          if(!stillCurrent())return;
          if(plotId&&/^[0-9a-z_-]{4,120}$/i.test(plotId)){
            try{
              const plot=await request('/v1/plots/'+encodeURIComponent(plotId));
              if(!stillCurrent())return;
              emit('profile',{room:forRoom,profile:{plot,plotId},path:'/v1/plots/'+plotId});collectObservedProfiles('/v1/plots/'+plotId,plot);count++;
              characters=Math.max(characters,Array.isArray(plot?.characters)?plot.characters.length:0);
            }catch(e){errors.push('캐릭터 상세: '+String(e.message||e));}
            if(!stillCurrent())return;
            // Independently query both persona endpoints without relying on another userscript.
            const prefix='/v1/plots/'+encodeURIComponent(plotId)+'/rooms/'+forRoom+'/user-personas/';
            for(const endpoint of ['selected','select']){
              try{
                const persona=await request(prefix+endpoint,5500);
                if(!stillCurrent())return;
                if(persona&&typeof persona==='object'&&!Array.isArray(persona)){
                  emit('profile',{room:forRoom,profile:{userProfile:persona},path:prefix+endpoint});
                  count++;userFound=true;break;
                }
              }catch(e){errors.push('유저 프로필 '+endpoint+': '+String(e.message||e));}
            }
          }else errors.push('플롯 ID 확인 실패');
        }catch(e){errors.push('예상하지 못한 오류: '+String(e.message||e));}
        finally{
          if(stillCurrent())emit('profileComplete',{room:forRoom,count,characters,userFound,partial:errors.length>0,errors:errors.slice(0,3)});
        }
      }
      window.addEventListener('message',e=>{if(e.origin!==window.location.origin||e.data?.tag!=='zab-control'||e.data.channel!==channel)return;if(e.data.action==='latest')latest(e.data.requestId||'');else if(e.data.action==='profiles')refreshProfiles();else if(e.data.action==='state'){discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});}});
      setInterval(discover,800);discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});
    };
    try{fn.call(page,bridgeId);}catch(e){bridgeInstallError=String(e?.message||e);console.warn('[제타 익명 게시판] 페이지 연결 실패',e);}
  }
  installBridge();
  function bridge(action,requestId=''){window.postMessage({tag:'zab-control',channel:bridgeId,action,requestId},'*');}
  async function setRoom(id){if(!id||!UUID.test(id)||id===room)return;cancelBusy(false);clearTimeout(autoTimer);clearTimeout(latestTimer);clearTimeout(autoRetryTimer);autoRetryTimer=null;autoWaitUntil=0;autoStage='';pendingAutoCheck=null;runEpoch++;turnCount=0;activeTurnKey='';activeTurnHash='';lastTurnKeys=[];seenTurnIds=new Set();lastTurnTime=0;turnEvents=0;completedTurnTotal=null;lastTurnAnchor='';turnMessagesSeen=0;turnStatusError='';turnPages=0;turnLoading=false;turnLoadCount=0;baselineReady=false;independentProfileCollector.roomChanged();room=id;postsView='list';detailId='';profilePanelOpen=false;settingsOpen=false;settingTab='basic';profileSectionOpen=true;communityDraft=null;profileCache={characters:[],users:[],plot:null};profileDetection={seen:0,paths:new Set(),lastPath:'',apiError:''};clearTimeout(profileWaitTimer);profileWaitTimer=null;profileAttempt++;profileInfo='저장된 프로필 확인 중';profileRequestRoom='';profileCollectionActive=false;profileDraftSelection={userId:'',characterIds:[]};try{data=await readRoom(id)||blankRoom(id);}catch(e){data=blankRoom(id);alert('저장소를 읽지 못해 임시 데이터로 시작합니다: '+e);}if(room!==id)return;data.settings={...defaults(),...data.settings};globalPreferences=readGlobalPreferences();applyGlobalPreferences();migrateCommunityGuides(data.settings);data.settings.profiles={...defaults().profiles,...data.settings.profiles};data.settings.profileSelection={userId:String(data.settings.profileSelection?.userId||''),characterIds:safeArray(data.settings.profileSelection?.characterIds).map(String)};
    if(!data.settings.communityConfirmV043)data.settings.communityConfirmed=false;
    // Only a confirmed snapshot may be used after a reload. Old versions stored IDs
    // but not source content, so those users must import and save once.
    const snapshot=data.settings.savedProfiles;
    if(snapshot?.user&&safeArray(snapshot.characters).length){
      const storedUser=copy(snapshot.user),storedChars=copy(snapshot.characters);
      profileCache={users:[storedUser],characters:storedChars,plot:null};
      profileDraftSelection={userId:profileKey(storedUser),characterIds:storedChars.map(profileKey)};
      profileInfo='저장된 프로필 불러옴 · 자동 재감지 안 함';
    }else{profileInfo='저장된 프로필 없음';}
    if(!data.settings.fallbackPreferenceV014){if(!data.settings.fallback)data.settings.fallback='gemini-3.1-flash-lite';data.settings.fallbackPreferenceV014=true;saved();}if(['apartment','dating'].includes(data.settings.selected))data.settings.selected='everytime';render();setTimeout(()=>{if(room!==id)return;bridge('state');bridge('latest');profileRequestRoom=id;},650);}
  function endProfileLoading(message){
    clearTimeout(profileWaitTimer);profileWaitTimer=null;
    profileInfo=message;
    updateProfileStatus();
    if(settingsOpen&&settingTab==='community'&&profileSectionOpen)render();
  }
  function requestProfiles(){
    if(!room)return show('제타 채팅방을 먼저 열어 주세요.');
    if(profileCollectionActive&&profileWaitTimer)return show('프로필 불러오기가 이미 진행 중이에요.');
    if(data?.settings.savedProfiles&&!confirm('제타에서 프로필을 다시 불러올까요?\n저장된 프로필은 저장 버튼을 누르기 전까지 변경되지 않습니다.'))return;
    profileCollectionActive=true;
    profileCache={characters:[],users:[],plot:null};
    profileDraftSelection={userId:'',characterIds:[]};
    const attempt=++profileAttempt,forRoom=room;
    clearTimeout(profileWaitTimer);profileWaitTimer=null;
    const already=profileCache.characters.length+profileCache.users.length;
    profileInfo=already?'프로필 '+already+'개 확인 · 추가 캐릭터 확인 중':'프로필 확인 중…';
    updateProfileStatus();
    if(settingsOpen&&settingTab==='community'&&profileSectionOpen)render();
    // Independent deadline, even when Safari loses bridge completion events.
    profileWaitTimer=setTimeout(()=>{
      if(attempt!==profileAttempt||room!==forRoom)return;
      const count=profileCache.characters.length+profileCache.users.length;
      endProfileLoading(count?'확인 완료 · 수집된 프로필 '+count+'개 (추가 응답 없음)':'채팅방 목록으로 돌아갔다가, 해당 채팅방에 다시 들어와 주세요.');
    },10000);
    independentProfileCollector.refresh();
  }
  function currentBoard(){if(!data)return blankBoard();const id=data.settings.selected;if(!data.boards[id])data.boards[id]=blankBoard();return data.boards[id];}
  function currentCommunity(){return [...presets,...safeArray(data?.settings.custom)].find(x=>x.id===data?.settings.selected)||presets[0];}
  // Display-only board title: no per-channel routing or additional storage.
  // Prefer world/profile information already explicitly saved for this room.
  function worldTitleTexts(){
    const settings=data?.settings||{},snapshot=settings.savedProfiles||{};
    return [settings.profiles?.world,settings.profiles?.user,settings.profiles?.characters,
      snapshot.user?.description,...safeArray(snapshot.characters).map(p=>p.description)]
      .filter(v=>typeof v==='string'&&v.trim()).map(String);
  }
  function worldName(patterns){
    for(const text of worldTitleTexts())for(const pattern of patterns){
      const match=pattern.exec(text);if(match?.[1])return short(match[1],45);
    }
    return '';
  }
  function rpSchoolName(){
    // Only THIS room's saved world/user/character profile text is trusted.
    const names=new Set();
    for(const source of worldTitleTexts()){
      for(const m of String(source).matchAll(/(?:^|[^가-힣A-Za-z0-9])([가-힣A-Za-z0-9]{2,18})\s*(대학교|대학)(?=\s|[가-힣\p{P}]|$)/gu)){
        if(['한국','우리','다른','전국','일반','모든','유명','명문','국내'].includes(m[1]))continue;
        names.add(m[1]+m[2]);
      }
    }
    // Conflicting schools mean no reliable center; use the default title.
    return names.size===1?[...names][0]:'';
  }
  function communityBoardTitle(){
    const id=currentCommunity().id;
    const manual=short(data?.settings?.boardTitles?.[id],100);
    if(manual)return manual;
    if(id==='everytime'){
      const school=rpSchoolName();
      return school?school+' 자유게시판':'게시판';
    }
    if(id==='blind')return '토픽·블라블라';
    if(id==='gallery')return '갤러리';
    if(id==='office'){
      const company=worldName([
        /(?:회사|직장|소속|근무지|재직|기업|회사명)\s*[:：-]?\s*([가-힣A-Za-z0-9]{2,22}(?:그룹|기업|전자|건설|금융|테크|산업|통신|상사|제약|은행|보험|모터스|솔루션|유통|물산|바이오|시스템즈|홀딩스))/,
        /([가-힣A-Za-z0-9]{2,22}(?:그룹|기업|전자|건설|금융|테크|산업|통신|상사|제약|은행|보험|모터스|솔루션|유통|물산|바이오|시스템즈|홀딩스))/
      ]);
      return company||'우리 회사';
    }
    if(id==='reddit'){
      // A single representative world-fitting display name; NOT a subreddit list.
      const names=safeArray(data?.settings?.savedProfiles?.characters).map(x=>short(x.name,28))
        .filter(x=>x&&!/^(?:캐릭터|사용자|user)$/i.test(x));
      let topic=names[0]||'세계관이야기';
      topic=topic.replace(/\s+/g,'_').replace(/[^가-힣a-zA-Z0-9_]/g,'').slice(0,28);
      return 'r/'+(topic||'세계관이야기');
    }
    if(id==='x')return '타임라인';
    if(id==='neighborhood'){
      const place=worldName([
        /(?:거주지|주소|동네|지역|사는\s*곳|동네 이름)\s*[:：-]?\s*([가-힣]{2,15}(?:동|읍|면))/,
        /([가-힣]{2,15}(?:동|읍|면))(?:에|에서|으로|의| 근처| 주민| 거주| 생활)/
      ]);
      return place?place+' · 동네 이야기':'우리 동네 이야기';
    }
    return currentCommunity().name;
  }
  function communityTopTitle(){return short(data?.settings?.topTitles?.[currentCommunity().id],100)||'익명 게시판';}
  function translationOn(){const opts=data?.settings?.translationEnabled;const id=currentCommunity().id;return opts&&Object.prototype.hasOwnProperty.call(opts,id)?!!opts[id]:id==='reddit';}
  function displayTranslation(){return translationOn()&&currentBoard().translationView==='ko';}
  function translatedText(item,key){const original=String(item?.[key]??'');const translated=item?.[key+'Ko'];return displayTranslation()&&typeof translated==='string'&&translated.trim()?translated:original;}
  function translationToggle(){const b=currentBoard();return translationOn()?'<div class="zab-translate-switch" role="group" aria-label="언어 보기">'+btn('translation-original','원문',b.translationView==='ko'?'':'is-active')+btn('translation-ko','번역',b.translationView==='ko'?'is-active':'')+'</div>':'';}
  function saved(){if(!data)return;data.updatedAt=now();writeRoom(data).catch(e=>show('저장 실패: '+e.message));}
  function show(msg){notice=String(msg);noticeUntil=now()+5000;renderStatus();setTimeout(()=>{if(now()>noticeUntil)renderStatus();},5100);}
  // Same INFO_BOX / TEXT normalization and per-message grouping as
  // zeta-chat-export-dev 1.2.0-beta.6. ID suffix is original content index.
  function infoValue(value){return typeof value==='string'?value.trim():typeof value==='number'||typeof value==='boolean'?String(value):'';}
  function readInfoBox(content){
    const parts=[];
    const readItems=section=>{
      const lines=[];for(const item of safeArray(section?.items)){
        const label=infoValue(item?.label),value=infoValue(item?.value);
        if(value)lines.push(label?label+': '+value:value);else if(label)lines.push(label);
      }
      if(!lines.length){const value=infoValue(section?.value)||infoValue(section?.description);if(value)lines.push(value);}
      return lines;
    };
    for(const section of [...safeArray(content.scenes),...safeArray(content.characters)]){
      const items=readItems(section);if(!items.length)continue;
      const heading=infoValue(section?.name)||infoValue(section?.title)||infoValue(section?.label);
      parts.push((heading?heading+'\n':'')+items.join('\n'));
    }
    if(!parts.length){const items=readItems(content);if(items.length)parts.push(items.join('\n'));else if(typeof content.text==='string'&&content.text.trim())parts.push(content.text.trim());}
    return parts.join('\n\n').trim();
  }
  function normalize(raw){
    const out=[];let i=0;
    for(const msg of safeArray(raw)){
      if(!msg||typeof msg!=='object')continue;
      const isUser=msg.sender?.type==='USER';
      for(const content of safeArray(msg.contents)){
        if(!content||typeof content!=='object')continue;
        let text='',kind='',speaker='';
        if(content.type==='TEXT'){
          if(typeof content.text!=='string'||!content.text.trim())continue;
          text=content.text;kind='TEXT';speaker=isUser?'사용자':content.speakerName||'캐릭터';
        }else if(content.type==='INFO_BOX'){
          text=readInfoBox(content);if(!text)continue;
          kind='INFO_BOX';speaker='상태창';
        }else continue;
        out.push({id:String(msg.id||'')+':'+(i++),messageId:msg.id||null,time:msg.messageTime||null,kind,role:isUser?'user':'character',speaker,text});
      }
    }
    out.sort((a,b)=>(Date.parse(a.time)||0)-(Date.parse(b.time)||0));
    return out;
  }
  // Exact export-dev turn structure: intro once, then a turn for EACH independent
  // CHARACTER message; user messages are attached to the next character turn.
  function buildTurns(parts){
    const result=[],pendingUsers=[];
    const firstUserIndex=parts.findIndex(p=>p.role==='user');
    const introEnd=firstUserIndex<0?parts.length:firstUserIndex;
    if(introEnd>0){
      const opening=parts.slice(0,introEnd),first=opening[0];
      result.push({id:'opening-'+String(first.messageId||first.id),unpaired:true,incomplete:false,intro:true,parts:opening,user:[],character:opening.slice()});
    }
    let current=null,lastId=null;
    for(const part of parts.slice(introEnd)){
      const id=String(part.messageId||part.id);
      if(part.role==='user'){pendingUsers.push(part);current=null;}
      else{
        if(id!==lastId||!current){
          current={id:'turn-'+id,unpaired:!pendingUsers.length,incomplete:false,intro:false,parts:pendingUsers.splice(0),user:[],character:[]};
          current.user=current.parts.slice();result.push(current);
        }
        current.character.push(part);current.parts.push(part);
      }
      lastId=id;
    }
    if(pendingUsers.length){
      const first=pendingUsers[0];
      result.push({id:'incomplete-'+String(first.messageId||first.id),unpaired:false,incomplete:true,intro:false,parts:pendingUsers.slice(),user:pendingUsers.slice(),character:[]});
    }
    return result;
  }
  let observedTurns=[],turnContent=new Map(),acceptedFingerprints=new Map(),roomRevision=0;
  function fingerprint(t){return t.parts.map(p=>p.messageId+'|'+p.role+'|'+p.text).join('\n');}
  // A turn is identified by the CHARACTER message ID, exactly as in export DEV.
  // The nearest preceding USER message is additional reroll context, not its turn ID.
  function turnGroups(msgs){
    const normalized=normalize(msgs),all=buildTurns(normalized);
    const complete=all.filter(t=>!t.incomplete&&!t.intro&&t.character.length);
    const groups=[];let userAnchor='';
    for(const t of complete){
      if(t.user.length)userAnchor=t.user.map(p=>p.messageId).join(',');
      groups.push({key:t.id,anchor:userAnchor,turn:t,time:Math.max(0,...t.parts.map(p=>Date.parse(p.time)||0))});
    }
    return {groups,normalized};
  }
  function acceptBaseline(groups){
    for(const g of groups)seenTurnIds.add(g.key);
    if(groups.length){const last=groups[groups.length-1];activeTurnKey=last.key;activeTurnHash=fingerprint(last.turn);lastTurnTime=Math.max(lastTurnTime,last.time);}
    lastTurnKeys=groups.map(g=>g.key);baselineReady=true;
  }
  let lastTurnAnchor='',turnMessagesSeen=0,turnStatusError='',turnPages=0,completedTurnTotal=null,turnLoading=false,turnLoadCount=0;
  // Count delta from the COMPLETE turn total shown by chat-export DEV.
  // Incomplete trailing USER messages are not counted. Intro counts once.
  function processMessages(msgs,latest=false){
    if(!room||!data||!latest)return; // never count incomplete intercepted API pages
    const {groups,normalized}=turnGroups(msgs);
    const all=buildTurns(normalized);
    const completed=all.filter(t=>!t.incomplete);
    const total=completed.length;
    turnMessagesSeen=new Set(normalized.map(p=>p.messageId)).size;
    lastRawMessageSnapshot=normalized;
    observedTurns=all.filter(t=>!t.incomplete);
    if(completedTurnTotal===null){
      completedTurnTotal=total;
      acceptBaseline(groups);
      const tail=groups.at(-1);
      lastTurnAnchor=tail?.anchor||'';
      if(!tail&&completed.length){activeTurnKey=completed.at(-1).id;activeTurnHash=fingerprint(completed.at(-1));}
      renderStatus();return;
    }
    const delta=total-completedTurnTotal;
    const tail=completed.at(-1)||null;
    const tailKey=tail?.id||'';
    const tailHash=tail?fingerprint(tail):'';
    const oldKey=activeTurnKey,oldHash=activeTurnHash;
    const changed=!!tail&&tailKey===oldKey&&tailHash!==oldHash;
    const replacement=!!tail&&tailKey!==oldKey&&delta===0;
    // The full total is the only count authority. Older API snapshots never
    // create turns merely because their message IDs differ.
    if(delta>0){
      turnEvents+=delta;
      if(data.settings.auto&&currentBoard().started){
        turnCount+=delta;
        const previousBatch=currentBoard().lastBatch;
        if(previousBatch?.temporary){previousBatch.temporary=false;saved();}
        if(turnCount>=num(data.settings.turns,1,999,1))scheduleAuto(tailKey,tailHash);
        else show('완료 턴 +'+delta+' · '+turnCount+'/'+data.settings.turns+'턴');
      }
    }else if(delta<0){
      if(data.settings.auto&&currentBoard().started){
        invalidatePending('완료 턴 감소 · 생성 대기 취소');
        turnCount=Math.max(0,turnCount+delta);
      }
    }else if((changed||replacement)&&data.settings.auto&&currentBoard().started){
      const eligible=turnCount>=data.settings.turns||!!currentBoard().lastBatch?.temporary||busy?.kind==='auto';
      invalidatePending('최근 답변 변경 감지 · 생성 대기 다시 시작');
      if(eligible){turnCount=Math.max(turnCount,data.settings.turns);scheduleAuto(tailKey,tailHash);}
    }
    completedTurnTotal=total;
    if(tail){activeTurnKey=tailKey;activeTurnHash=tailHash;}
    if(groups.length)lastTurnAnchor=groups.at(-1).anchor||'';
    renderStatus();
  }
  let lastRawMessageSnapshot=[];
  function invalidatePending(reason){
    clearTimeout(autoTimer);autoTimer=null;clearTimeout(autoRetryTimer);autoRetryTimer=null;
    autoWaitUntil=0;autoStage='';pendingAutoCheck=null;cancelBusy(false);
    const b=currentBoard();if(b.lastBatch?.temporary){rollback(b.lastBatch);b.lastBatch=null;saved();}
    if(reason)show(reason);
  }
  function rollback(batch){if(!batch||!data)return;const board=currentBoard();board.posts=board.posts.filter(p=>!batch.created.includes(p.id));for(const p of board.posts){p.comments=p.comments.filter(c=>!batch.comments.includes(c.id));for(const c of p.comments)c.replies=c.replies.filter(r=>!batch.comments.includes(r.id));const old=batch.metrics?.[p.id];if(old){p.views=old.views;p.likes=old.likes;}}board.unread=Math.max(0,board.unread-(batch.created?.length||0));}
  function scheduleAuto(key,hash){
    clearTimeout(autoTimer);clearTimeout(autoRetryTimer);autoRetryTimer=null;pendingAutoCheck=null;
    if(busy||!data?.settings.auto||!currentBoard().started)return;
    if(!getKey()){show('자동 생성 대기 · API 키를 설정하세요.');return;}
    if(!profileReady()){show('자동 생성 대기 · '+profileSelectionStatus());return;}
    const waitSeconds=num(data.settings.autoDelaySeconds,1,300,10);
    autoStage='waiting';autoWaitUntil=now()+waitSeconds*1000;
    show('게시글 생성 대기 중 · '+waitSeconds+'초');
    const epoch=runEpoch,roomAt=room,comm=data.settings.selected;
    autoTimer=setTimeout(()=>{
      autoTimer=null;autoWaitUntil=0;
      if(epoch!==runEpoch||roomAt!==room||comm!==data?.settings.selected)return;
      verifyAutoTurn({epoch,roomAt,comm,key,hash},0);
    },waitSeconds*1000);
  }
  function verifyAutoTurn(ref,attempt){
    if(ref.epoch!==runEpoch||ref.roomAt!==room||ref.comm!==data?.settings.selected||!data.settings.auto)return;
    autoStage='verifying';
    const requestId=uid();pendingAutoCheck={...ref,requestId,attempt};renderStatus();
    bridge('latest',requestId);
    setTimeout(()=>{
      if(pendingAutoCheck?.requestId!==requestId)return;
      pendingAutoCheck=null;retryAutoTurn(ref,attempt,'최신 대화 확인 시간 초과');
    },9000);
  }
  function retryAutoTurn(ref,attempt,message){
    if(ref.epoch!==runEpoch||ref.roomAt!==room||ref.comm!==data?.settings.selected)return;
    if(ref.key!==activeTurnKey||ref.hash!==activeTurnHash)return;
    if(attempt>=2){autoStage='failed';show('자동 생성 보류 · '+message);renderStatus();return;}
    autoStage='retry';show('최신 대화 재확인 '+(attempt+1)+'/2회');
    clearTimeout(autoRetryTimer);
    autoRetryTimer=setTimeout(()=>{autoRetryTimer=null;verifyAutoTurn(ref,attempt+1);},3000*(attempt+1));
  }
  function completeAutoCheck(message){
    const check=pendingAutoCheck;
    if(!check||message.requestId!==check.requestId)return;
    pendingAutoCheck=null;
    if(!message.ok){retryAutoTurn(check,check.attempt,'최신 대화 조회 실패');return;}
    if(check.epoch!==runEpoch||check.roomAt!==room||check.comm!==data?.settings.selected||!data.settings.auto||busy)return;
    if(check.key!==activeTurnKey||check.hash!==activeTurnHash)return;
    if(!profileReady()){show('자동 생성 대기 · '+profileSelectionStatus());return;}
    autoStage='generating';generate('auto');
  }
  window.addEventListener('message',e=>{const m=e.data;if(e.origin!==location.origin||m?.tag!=='zab-bridge'||m.channel!==bridgeId)return;lastBridgeResponse=now();if(m.type==='room'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='state'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='messages'&&m.room===room&&m.latest){processMessages(m.messages,true);lastLiveSync=now();}if(m.type==='latestEnd'&&m.room===room)completeAutoCheck(m);if(m.type==='messagesStatus'&&m.room===room){turnLoading=!!m.loading;turnPages=m.pages||0;turnLoadCount=m.count||0;if(!m.loading){turnStatusError=m.error||'';if(m.ok)lastLiveSync=now();else if(m.error)show('메시지 조회 실패 · '+m.error);}renderStatus();}if(m.type==='profile'&&m.room===room&&profileCollectionActive){profileDetection.seen++;profileDetection.lastPath=m.path||'';if(m.path)profileDetection.paths.add(m.path);ingestProfile(m.profile,m.path||'');if(profileWaitTimer&&(profileCache.characters.length||profileCache.users.length))endProfileLoading('프로필 수집됨 · 추가 캐릭터 확인 가능');else updateProfileStatus();}
    if(m.type==='profileComplete'&&m.room===room&&profileCollectionActive){const extra=m.errors?.length?' ('+m.errors.join(' / ').slice(0,160)+')':'';endProfileLoading('수집 완료'+(m.partial?' · 일부 요청 실패':'')+extra);}
    if(m.type==='profileError'&&profileCollectionActive&&(!m.room||m.room===room)){profileDetection.apiError=m.message||'프로필 수집 실패';endProfileLoading(m.message||'프로필 수집 실패');}
    if(m.type==='error')show(m.message);});
  // The injected bridge can announce its initial room before our message listener exists.
  // Ask for the current bridge state after registering the listener, and periodically
  // retry state discovery for SPA navigation / missed Safari events.
  queueMicrotask(()=>bridge('state'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)bridge('state');});
  // Identifiers for explicit user choices remain stable across reloads.
  // A display-name fallback is used only if Zeta omits a profile ID.
  function profileKey(p){return p._key||(p.id?'id:'+p.id:'name:'+p.name);}
  function profileItem(raw,allowUserName=false){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const obj=raw.profile||raw.persona||raw.userPersona||raw.data||raw;
    if(!obj||typeof obj!=='object'||Array.isArray(obj))return null;
    const name=short(obj.name||obj.displayName||obj.display_name||obj.nickname||obj.title||'',160);
    const description=short(obj.description||obj.introduction||obj.character?.description||'',16000);
    const id=String(obj.id||obj.uuid||obj.profileId||obj.profile_id||obj.characterId||obj.character_id||obj.character?.id||'').slice(0,120);
    if((!name&&!description)||(!allowUserName&&(/\{\{\s*user\s*\}\}/i.test(name)||name==='사용자'||name.toLowerCase()==='user')))return null;
    return {id,name:name||'(이름 없음)',description};
  }
  function mergeCandidate(list,incoming){
    const key=profileKey(incoming);
    const idx=list.findIndex(p=>profileKey(p)===key||(p.id&&incoming.id&&p.id===incoming.id));
    if(idx<0){list.push(incoming);return true;}
    const prev=list[idx]; const improved={id:incoming.id||prev.id,name:incoming.name||prev.name,description:incoming.description.length>prev.description.length?incoming.description:prev.description};
    if(JSON.stringify(prev)===JSON.stringify(improved))return false;
    list[idx]=improved;return true;
  }
  function ingestProfile(raw,path=''){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
    let changed=false;
    const addChar=obj=>{const p=profileItem(obj);if(p)changed=mergeCandidate(profileCache.characters,p)||changed;};
    const addUser=obj=>{const p=profileItem(obj,true);if(p)changed=mergeCandidate(profileCache.users,p)||changed;};
    const plots=[raw.plot,raw.room?.plot,raw.room,raw].filter(x=>x&&typeof x==='object');
    for(const obj of plots){
      if(obj.plot?.id)profileCache.plot=String(obj.plot.id);
      if(obj.plotId)profileCache.plot=String(obj.plotId);
      if(obj.id&&Array.isArray(obj.about?.characters))profileCache.plot=String(obj.id);
      for(const c of [...safeArray(obj.characters),...safeArray(obj.plot?.characters)])addChar(c);
      for(const c of safeArray(obj.about?.characters)){
        const ref=profileCache.characters.find(x=>x.id&&x.id===String(c?.characterId||''));
        if(ref&&typeof c.description==='string'&&c.description.length>(ref.description||'').length){ref.description=short(c.description,16000);changed=true;}
        else if(c?.name)addChar(c);
      }
      // User personas must come from a user-specific response; never infer a user
      // profile from arbitrary plot characters, profiles or chatProfiles.
      for(const candidate of [obj.userProfile,obj.userPersona,obj.selectedUserPersona,obj.user])if(candidate&&typeof candidate==='object')addUser(candidate);
    }
    if(/\/(?:user-personas|user-profiles)\/[^/?#]+\/?$/i.test(path)) addUser(raw);
    // Enrich existing character IDs with detailed descriptions collected independently.
    const byId=new Set(profileCache.characters.map(x=>x.id).filter(Boolean)),stack=[raw];let steps=0;
    while(stack.length&&steps++<1200){const v=stack.pop();if(!v||typeof v!=='object')continue;
      if(!Array.isArray(v)&&v.id&&byId.has(String(v.id))&&typeof v.description==='string'){
        const existing=profileCache.characters.find(p=>p.id===String(v.id));
        if(existing&&v.description.length>existing.description.length){existing.description=short(v.description,16000);changed=true;}
      }
      for(const [key,child] of Object.entries(v).slice(0,80))if(child&&typeof child==='object'&&!/auth|token|cookie|password|secret|email|phone/i.test(key))stack.push(child);
    }
    if(changed){
      updateProfileStatus();
      if(settingsOpen&&settingTab==='community'&&profileSectionOpen)render();
    }
  }
  // Independent profile collector, adapted directly from zeta-current-profiles / zeta-profiles-mob.
  // No use of other installed userscripts, their events, or their public APIs.
  // Unlike the message bridge, this observer hooks the page's real fetch/XHR in the
  // userscript's own execution path and consumes the responses without postMessage.
  const independentProfileCollector=(()=>{
    const api='https://api.zeta-ai.io', maxPayload=900000;
    const direct=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
    const nativeFetch=direct.fetch, XHR=direct.XMLHttpRequest;
    const nativeOpen=XHR?.prototype?.open, nativeSend=XHR?.prototype?.send;
    const nativeHeader=XHR?.prototype?.setRequestHeader;
    let auth={}, lastPlot='', lastRoom='', generation=0, requestSeq=0, screenPending=false;
    let installed=false, pendingRefresh=false;
    const xhrInfo=new WeakMap(), seenScreens=new Map();
    const pathOf=url=>{try{const u=new URL(String(url),location.href);return u.origin===api?u.pathname:null;}catch{return null;}};
    const roomOf=path=>{const m=/\/rooms\/([0-9a-f-]{36})(?:\/|$)/i.exec(path||'');return m&&UUID.test(m[1])?m[1]:'';};
    const isRelated=path=>!!path&&(/\/rooms\//.test(path)||/profile|persona|character|bot|agent|\/plots\//i.test(path));
    function collectAuth(raw){
      try{
        const entries=raw?.entries?raw.entries():Array.isArray(raw)?raw:Object.entries(raw||{});
        for(const [k,v] of entries){const key=String(k).toLowerCase();if(['authorization','x-client-native-version','x-client-type','x-client-version','x-device-type','x-user-language'].includes(key))auth[key]=String(v);}
      }catch{}
    }
    function note(path,payload){
      if(!profileCollectionActive||!path)return;
      profileDetection.seen++;
      profileDetection.lastPath=path;
      profileDetection.paths.add(path);
      if(/\/user-personas\/(?:select|selected)\/?$/i.test(path)){
        if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
          ingestProfile({userProfile:payload},path);
        }
        else if(payload===null)profileInfo='제타에서 선택된 유저 프로필이 없어요.';
      }else if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
        ingestProfile(payload,path);
      }
      // The actual room detail carries ALL character profiles, not just the first.
      if(/^\/v1\/rooms\/[0-9a-f-]{36}\/?$/i.test(path)&&payload?.plot){
        lastPlot=String(payload.plot.id||'');
        const chars=safeArray(payload.plot.characters);
        if(chars.length)ingestProfile({characters:chars},path);
      }
      if(profileWaitTimer&&(profileCache.characters.length||profileCache.users.length)){
        endProfileLoading('프로필 감지 완료 · 유저와 캐릭터를 선택하세요.');
      }else updateProfileStatus();
      if(settingsOpen&&settingTab==='community'&&profileSectionOpen)render();
    }
    function process(path,payload,status,forRoom,epoch){
      if(!profileCollectionActive||epoch!==generation||!path||status<200||status>=300)return;
      const scoped=roomOf(path);
      if(!room||scoped&&scoped!==room||forRoom&&forRoom!==room)return;
      // Zeta's room detail, plot, and persona response can each arrive independently.
      if(!isRelated(path)||/\/messages(?:\/|$)/i.test(path))return;
      note(path,payload);
    }
    function inspectFetch(response,path,forRoom,epoch){
      if(!response?.ok||!isRelated(path)||/\/messages(?:\/|$)/i.test(path))return;
      if(Number(response.headers?.get?.('content-length')||0)>maxPayload)return;
      const type=String(response.headers?.get?.('content-type')||'');
      if(type&&!/json/i.test(type)&&!/user-personas\/select/i.test(path))return;
      response.clone().text().then(text=>{
        if(text.length>maxPayload)return;
        const payload=text.trim()?JSON.parse(text):null;
        process(path,payload,response.status,forRoom,epoch);
      }).catch(()=>{});
    }
    function collectVisibleDescription(){
      if(!profileCollectionActive||!room||!document.body)return;
      const known=profileCache.characters;
      // This is the exact modal traversal pattern used by the working profile script.
      for(const title of document.querySelectorAll('h3,[role="heading"]')){
        const name=(title.textContent||'').trim();if(!name||name.length>160)continue;
        const header=title.parentElement;
        const close=header?.querySelector('button[aria-label="Close"],button[aria-label="닫기"]');
        if(!close||!close.getClientRects().length)continue;
        const overlay=header.parentElement;
        if(!overlay||overlay.closest('[aria-hidden="true"],[hidden]'))continue;
        const sections=[...overlay.children].filter(node=>node!==header&&node.getClientRects().length);
        const explicit=sections.filter(node=>node.matches('[data-sentry-component="CharacterDescription"]'));
        const match=known.filter(p=>p.name.trim()===name);
        if(match.length>1)continue;
        const eligible=explicit.length?explicit:match.length===1?sections:[];
        for(const section of eligible){
          const body=section.matches('.whitespace-pre-wrap')?section:section.querySelector('.whitespace-pre-wrap');
          if(!body||!body.getClientRects().length||body.closest('[hidden],[aria-hidden="true"]'))continue;
          const description=String(body.innerText||'').trim();
          if(!description||description.length>20000||seenScreens.get(name)===description)continue;
          seenScreens.set(name,description);
          note('/ui/character-description',{characters:[{id:match[0]?.id||'',name,description}]});
          return;
        }
      }
    }
    function scanSoon(){if(screenPending)return;screenPending=true;setTimeout(()=>{screenPending=false;collectVisibleDescription();},120);}
    function install(){
      if(installed)return;installed=true;
      if(typeof nativeFetch==='function'){
        direct.fetch=function(input,init){
          const url=typeof input==='string'?input:input?.url||String(input||'');
          const path=pathOf(url);
          if(path){collectAuth(init?.headers||input?.headers);const id=roomOf(path);if(id&&!room)setRoom(id);}
          const forRoom=room,epoch=generation;
          const response=nativeFetch.apply(this,arguments);
          if(isRelated(path))Promise.resolve(response).then(r=>inspectFetch(r,path,forRoom,epoch)).catch(()=>{});
          return response;
        };
      }
      if(nativeOpen&&nativeSend){
        XHR.prototype.open=function(method,url){xhrInfo.set(this,{path:pathOf(url),headers:[]});return nativeOpen.apply(this,arguments);};
        if(nativeHeader)XHR.prototype.setRequestHeader=function(k,v){const st=xhrInfo.get(this);if(st&&st.path)st.headers.push([k,v]);return nativeHeader.apply(this,arguments);};
        XHR.prototype.send=function(){
          const st=xhrInfo.get(this);if(st?.path){collectAuth(st.headers);const id=roomOf(st.path);if(id&&!room)setRoom(id);}
          const forRoom=room,epoch=generation;
          if(st&&isRelated(st.path))this.addEventListener('load',function(){
            if(this.status<200||this.status>=300)return;
            try{
              const text=this.responseType==='json'?null:this.responseText;
              if(text?.length>maxPayload)return;
              const payload=this.responseType==='json'?this.response:JSON.parse(text||'null');
              process(st.path,payload,this.status,forRoom,epoch);
            }catch{}
          },{once:true});
          return nativeSend.apply(this,arguments);
        };
      }
      const begin=()=>{
        if(!document.body){setTimeout(begin,120);return;}
        const observer=new MutationObserver(scanSoon);
        observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-hidden','hidden','class']});
        scanSoon();
      };
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',begin,{once:true});else begin();
      // Passive hooks remain installed, but do not collect or change profiles until requested.
    }
    async function refresh(){
      if(!profileCollectionActive)return;
      if(!room)return endProfileLoading('채팅방을 먼저 연결하세요.');
      if(pendingRefresh)return;
      pendingRefresh=true;
      const startRoom=room,epoch=generation,token=++requestSeq;
      if(!Object.keys(auth).some(k=>k==='authorization')){
        // Existing Zeta calls can still be observed without explicit credentials.
        endProfileLoading('채팅방 목록으로 돌아갔다가, 해당 채팅방에 다시 들어와 주세요.');
        pendingRefresh=false;return;
      }
      const aborts=[];
      const request=async(path,deadline=6500)=>{
        const controller=new AbortController();aborts.push(controller);
        const timer=setTimeout(()=>controller.abort(),deadline);
        try{
          const resp=await nativeFetch.call(direct,api+path,{headers:{...auth},credentials:'include',cache:'no-store',signal:controller.signal});
          if(!resp.ok)throw Error('HTTP '+resp.status);
          const payload=await resp.json();
          if(room===startRoom&&epoch===generation&&token===requestSeq)process(path,payload,resp.status,startRoom,epoch);
          return payload;
        }finally{clearTimeout(timer);}
      };
      const errors=[];
      try{
        let details;
        try{details=await request('/v1/rooms/'+startRoom);}catch(e){errors.push('채팅방 상세 '+String(e.message||e));}
        if(room!==startRoom||epoch!==generation)return;
        const plotId=String(details?.plot?.id||details?.plotId||lastPlot||'');
        if(plotId&&/^[0-9a-z_-]{4,120}$/i.test(plotId)){
          try{await request('/v1/plots/'+encodeURIComponent(plotId));}catch(e){errors.push('플롯 상세 '+String(e.message||e));}
          const base='/v1/plots/'+encodeURIComponent(plotId)+'/rooms/'+startRoom+'/user-personas/';
          for(const suffix of ['selected','select']){
            try{const p=await request(base+suffix,5000);if(p&&typeof p==='object')break;}
            catch(e){errors.push('유저 프로필 '+suffix+' '+String(e.message||e));}
          }
        }
      }finally{
        aborts.forEach(c=>{try{c.abort();}catch{}});
        pendingRefresh=false;
        if(room===startRoom&&epoch===generation){
          const count=profileCache.characters.length+profileCache.users.length;
          endProfileLoading(count?'수집 완료 · 프로필 '+count+'개 · 선택 필요':errors.length?'프로필 요청 실패 · '+errors.join(' / ').slice(0,180):'프로필 후보 미발견 · 제타에서 프로필 화면을 열어 주세요.');
        }
      }
    }
    function roomChanged(){generation++;seenScreens.clear();lastPlot='';requestSeq++;}
    return {install,refresh,roomChanged,diagnostics:()=>({installed,authorized:!!auth.authorization})};
  })();
  independentProfileCollector.install();

  function profileSelection(){
    const snapshot=data?.settings?.savedProfiles;
    const user=snapshot?.user&&typeof snapshot.user==='object'?snapshot.user:null;
    const chars=safeArray(snapshot?.characters).filter(p=>p&&typeof p.name==='string'&&p.name.trim());
    return {user,characters:chars,valid:!!user&&!!String(user.name||'').trim()&&chars.length>0};
  }
  function profileSelectionStatus(){
    if(!data)return '채팅방 연결 대기 중';
    const chosen=profileSelection();
    return chosen.valid?'저장 완료 · 유저 1명 · 캐릭터 '+chosen.characters.length+'명':
      '프로필 미저장 · 👤에서 불러오기 → 수정 → 저장 필요';
  }
  function profileReady(){return profileSelection().valid;}
  // Draft changes never influence Gemini until the user explicitly saves them.
  function saveProfileDraft(){
    if(!data)return;
    const user=profileCache.users.find(p=>profileKey(p)===profileDraftSelection.userId);
    const ids=new Set(safeArray(profileDraftSelection.characterIds));
    const chars=profileCache.characters.filter(p=>ids.has(profileKey(p)));
    if(!user)return show('저장할 유저 프로필 1개를 선택해 주세요.');
    if(!chars.length)return show('저장할 캐릭터 프로필을 1명 이상 선택해 주세요.');
    if(!String(user.name||'').trim()||chars.some(p=>!String(p.name||'').trim()))return show('프로필 이름을 입력해 주세요.');
    const clean=p=>({id:short(p.id,120),name:short(p.name,160),description:short(p.description,16000),_key:profileKey(p)});
    data.settings.savedProfiles={user:clean(user),characters:chars.map(clean),savedAt:now()};
    data.settings.profileSelection={userId:profileKey(user),characterIds:chars.map(profileKey)};
    profileCollectionActive=false;
    clearTimeout(profileWaitTimer);profileWaitTimer=null;profileAttempt++;
    runEpoch++;invalidatePending('');turnCount=0;
    profileInfo='프로필 저장 완료 · 자동 재감지 안 함';
    profileSectionOpen=false;saved();render();show('프로필 저장 완료 · 이어서 커뮤니티를 확인해 주세요.');
  }
  function discardProfileDraft(){
    profileCollectionActive=false;clearTimeout(profileWaitTimer);profileWaitTimer=null;profileAttempt++;
    const saved=data?.settings.savedProfiles;
    profileCache=saved?.user?{users:[copy(saved.user)],characters:copy(safeArray(saved.characters)),plot:null}:{users:[],characters:[],plot:null};
    profileDraftSelection=saved?.user?{userId:profileKey(saved.user),characterIds:safeArray(saved.characters).map(profileKey)}:{userId:'',characterIds:[]};
    profileInfo=saved?.user?'저장된 프로필 복원':'저장된 프로필 없음';render();
  }
  function renderProfileChoices(){
    const selected=profileDraftSelection;
    const userRows=profileCache.users.map(p=>{const id=profileKey(p),checked=id===selected.userId;return `<label class="zab-profile-choice"><input type="checkbox" data-profile-user="yes" value="${esc(id)}" ${checked?'checked':''}><span><strong>${esc(p.name)}</strong><small>${esc(short(p.description,100)||'설명 미확인')}</small></span></label>`;}).join('');
    const user=profileCache.users.find(p=>profileKey(p)===selected.userId);
    const userEditor=user?`<div class="zab-section"><label>유저 이름 수정</label><input data-profile-edit="user" data-profile-field="name" value="${esc(user.name)}" maxlength="160"><label>유저 설명 수정</label><textarea data-profile-edit="user" data-profile-field="description" rows="5">${esc(user.description)}</textarea></div>`:'';
    const charRows=profileCache.characters.map(p=>{
      const id=profileKey(p),checked=safeArray(selected.characterIds).includes(id);
      return `<div class="zab-section"><label class="zab-profile-choice"><input type="checkbox" data-profile-character="${esc(id)}" ${checked?'checked':''}><strong>${esc(p.name)}</strong></label>
        ${checked?`<label>캐릭터 이름 수정</label><input data-profile-edit="character" data-profile-id="${esc(id)}" data-profile-field="name" value="${esc(p.name)}" maxlength="160">
        <label>캐릭터 설명 수정</label><textarea data-profile-edit="character" data-profile-id="${esc(id)}" data-profile-field="description" rows="5" placeholder="제타에서 캐릭터 프로필 사진을 눌러 상세 설명을 확인한 뒤, 프로필을 다시 불러오세요.&#10;&#10;※ 상세 프로필에 설명이 없는 경우에는 해당 정보를 불러올 수 없습니다.">${esc(p.description)}</textarea>`:`<p class="zab-note">${esc(short(p.description,180)||'설명 미확인 · 제타에서 캐릭터 프로필 사진을 클릭해 상세 설명을 열고 다시 불러오세요.')}</p>`}</div>`;
    }).join('');
    return `<label>Gemini에 전달할 유저 프로필 (필수)</label>${userRows||'<p class="zab-note">불러온 유저 프로필이 없어요.</p>'}${userEditor}
      <div class="zab-profile-choose-header"><label>Gemini에 전달할 캐릭터 프로필 (필수)</label><div class="zab-profile-actions">${btn('select-all-characters','전체 선택')}${btn('clear-all-characters','전체 해제')}</div></div>
      ${charRows||'<p class="zab-note">저장된 프로필이 없어요. 불러오기 버튼으로 가져오세요.</p>'}
      <p class="zab-note">편집 내용은 아래 저장 버튼을 눌러야 적용됩니다. 기존 저장본은 그전까지 유지돼요.</p>
      <div class="zab-row">${btn('save-profiles','프로필 저장','zab-primary')}${btn('discard-profiles','수정 취소')}</div>`;
  }
  function updateProfileStatus(){
    const el=panel?.querySelector('#zab-profile-status');
    if(el)el.textContent=profileInfo;
    const count=panel?.querySelector('#zab-profile-count');
    if(count)count.textContent=`불러온 후보: 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.users.length}개`;
    const list=panel?.querySelector('#zab-profile-selection-status');
    if(list)list.textContent=profileSelectionStatus();
    renderStatus();
  }
  let lastLatestRequest=0,lastBridgeResponse=0;
  function requestLatest(){if(!room||loadBusy)return;loadBusy=true;lastLatestRequest=now();bridge('latest');setTimeout(()=>{loadBusy=false;},2200);}
  let lastBridgeStateAsk=0;const runner=setInterval(()=>{if(!document.body)return;const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m)setRoom(m[1]);if(now()-lastBridgeStateAsk>6000){lastBridgeStateAsk=now();bridge('state');}if(!room||!data)return;if(now()-lastLatestRequest>8000)requestLatest();
    if(completedTurnTotal===null&&now()-lastLatestRequest>3500&&lastBridgeResponse===0)turnStatusError=bridgeInstallError?'페이지 연결 설치 실패: '+short(bridgeInstallError,100):'제타 페이지 연결 응답 없음 · Safari 수신 확인 필요';
    if(!panel)mount();else renderStatus();},2000);
  // Copy the previous room-wide guide into each existing community once.
  // After migration, every community owns an independent instruction.
  function migrateCommunityGuides(settings){
    if(!settings||settings.communityGuidesMigrated===true)return;
    const guides=settings.communityGuides&&typeof settings.communityGuides==='object'&&!Array.isArray(settings.communityGuides)?settings.communityGuides:{};
    const old=typeof settings.guide==='string'?settings.guide:'';
    if(old.trim())for(const c of [...presets,...safeArray(settings.custom)]){
      if(!Object.prototype.hasOwnProperty.call(guides,c.id))guides[c.id]=old;
    }
    settings.communityGuides=guides;
    settings.communityGuidesMigrated=true;
  }
  function saveSettings(globalChange=false){if(!data)return;data.settings.turns=num(data.settings.turns,1,999,1);data.settings.autoDelaySeconds=num(data.settings.autoDelaySeconds,1,300,10);if(globalChange)persistGlobalPreferences();saved();render();}
  function communityChange(id){if(!data)return;if(data.settings.selected===id)return;invalidatePending('커뮤니티를 변경했어요.');runEpoch++;turnCount=0;data.settings.selected=id;postsView='list';detailId='';saved();render();}
  // Only clicking "커뮤니티 설정 확인" commits preview values.
  function translationFor(id){const opts=data?.settings?.translationEnabled;return opts&&Object.prototype.hasOwnProperty.call(opts,id)?!!opts[id]:id==='reddit';}
  function startCommunityDraft(){
    const s=data.settings,id=s.selected;
    communityDraft={id,title:short(s.boardTitles?.[id]||'',100),translate:translationFor(id),galleryDescription:short(s.galleryDescription||'',2000),guide:String(s.communityGuides?.[id]||''),custom:{name:'',title:'',desc:'',style:'',example:'',color:'#505969'}};
  }
  function communityGrid(){
    const chosen=communityDraft?.id||data.settings.selected;
    const ordered=['everytime','blind','gallery','neighborhood','reddit','x','office'];
    const options=ordered.map(id=>{const p=presets.find(c=>c.id===id);return [id,p?.name||id];});
    options.push(['__new_custom__','+사용자 지정']);
    for(const c of safeArray(data.settings.custom))options.push([c.id,c.name]);
    return '<div class="zab-community-grid-wrap"><div class="zab-community-grid" role="group" aria-label="현재 커뮤니티">'+
      options.map(([id,label])=>'<button type="button" data-act="choose-community:'+esc(id)+'" class="zab-community-grid-button'+(id===chosen?' is-active':'')+'" aria-pressed="'+(id===chosen?'true':'false')+'" title="'+esc(label)+'">'+esc(label)+'</button>').join('')+
      '</div></div>';
  }
  function selectCommunityDraft(id){
    if(!communityDraft)startCommunityDraft();
    communityDraft.id=id;
    communityDraft.title=id==='__new_custom__'?communityDraft.custom.title:short(data.settings.boardTitles?.[id]||'',100);
    communityDraft.translate=id==='__new_custom__'?false:translationFor(id);
    communityDraft.guide=id==='__new_custom__'?'':String(data.settings.communityGuides?.[id]||'');
    render();
  }
  function communitySettingsConfirmed(){
    if(!data?.settings?.communityConfirmed)return false;
    if(!communityDraft)return true;
    const d=communityDraft,s=data.settings;
    return d.id===s.selected&&d.title===(s.boardTitles?.[s.selected]||'')&&d.translate===translationFor(s.selected)&&d.guide===String(s.communityGuides?.[s.selected]||'')&&(d.id!=='gallery'||d.galleryDescription===(s.galleryDescription||''));
  }
  function refreshCommunityConfirmButton(){
    const el=panel?.querySelector('button[data-act="confirm-community"]');
    if(!el)return;
    const confirmed=communitySettingsConfirmed();
    el.textContent=confirmed?'커뮤니티 설정 확인됨':'커뮤니티 설정 확인';
    el.classList.toggle('zab-primary',!confirmed);
  }
  function confirmCommunityDraft(){
    if(!communityDraft)startCommunityDraft();
    const s=data.settings,d=communityDraft;
    let id=d.id;
    if(id==='__new_custom__'){
      const c=d.custom;
      if(!short(c.name,80))return show('커뮤니티 이름을 입력해 주세요.');
      if(!short(c.title,100))return show('게시판 이름을 입력해 주세요.');
      if(!/^#[0-9a-f]{6}$/i.test(c.color))return show('강조색은 #FFFFFF처럼 #RRGGBB 형식으로 입력해 주세요.');
      id='custom-'+uid();
      s.custom.push({id,name:short(c.name,80),desc:short(c.desc,2000),nick:'익명 주민',style:short(c.style,2000),styleExample:short(c.example,2000),color:/^#[0-9a-f]{6}$/i.test(c.color)?c.color:'#505969'});
      d.title=short(c.title,100);
    }
    if(![...presets,...safeArray(s.custom)].some(c=>c.id===id))return show('커뮤니티를 선택해 주세요.');
    s.boardTitles=s.boardTitles&&typeof s.boardTitles==='object'?s.boardTitles:{};
    if(d.title)s.boardTitles[id]=short(d.title,100);else delete s.boardTitles[id];
    s.translationEnabled=s.translationEnabled&&typeof s.translationEnabled==='object'?s.translationEnabled:{};
    s.translationEnabled[id]=!!d.translate;
    s.communityGuides=s.communityGuides&&typeof s.communityGuides==='object'&&!Array.isArray(s.communityGuides)?s.communityGuides:{};
    if(d.guide.trim())s.communityGuides[id]=d.guide;else delete s.communityGuides[id];
    if(id==='gallery')s.galleryDescription=short(d.galleryDescription,2000);
    if(id!==s.selected)communityChange(id);
    s.communityConfirmed=true;s.communityConfirmV043=true;
    communityDraft=null;saved();render();show('커뮤니티 설정을 저장했어요.');
  }
  function toggleAuto(on){if(!data)return;invalidatePending('');runEpoch++;turnCount=0;data.settings.auto=on;saveSettings(true);show('자동 갱신 '+(on?'ON':'OFF')+' · 0턴부터 시작');}
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
      <p class="zab-note">★ 무료 사용자 기준 참고 추천 후보예요. 실제 무료 지원·요청 한도는 계정마다 다르므로 호출 확인과 AI Studio 한도 화면으로 확인하세요.</p>
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
  function promptPayload(kind,post){const b=currentBoard(),s=data.settings,community=currentCommunity(),recent=observedTurns.slice(-Math.max(10,num(s.turns,1,999,1)+5)).map((t,i)=>({turn:i+1,content:t.parts.map(p=>`${p.speaker} (${p.role}): ${short(p.text,1300)}`).join('\n').slice(0,4500)}));const older=b.posts.slice(-num(s.oldPostWindow,0,300,20)).map(p=>({id:p.id,title:p.title,body:short(p.body,850),comments:p.comments.slice(-12).map(c=>({id:c.id,author:community.id==='gallery'?galleryDisplayNick(c):c.nick,source:c.source||'ai',text:short(c.text,450),replies:safeArray(c.replies).slice(-5).map(r=>({id:r.id,author:community.id==='gallery'?galleryDisplayNick(r):r.nick,source:r.source||'ai',text:short(r.text,220)}))}))}));const residents=Object.values(b.residents).slice(-40);
    const communityRules=community.id==='gallery'?'갤러리에서는 세계관에 맞는 주제와 관심사를 다루고, 짧은 반말과 한국 인터넷 갤러리식 표현을 상황에 맞게 자연스럽게 사용하라. 일회성 AI 주민은 유동닉 ㅇㅇ(가상 IP), 서로 다른 게시글에 반복 등장하여 확정된 고정 주민과 RP 캐릭터는 고정닉을 사용한다. 반고닉은 사용하지 않는다. 유저는 기본 유동닉이며 직접 닉네임을 지정하면 고정닉이다. 실제 IP를 수집하거나 추측하지 마라.':community.id==='blind'?
      '블라인드는 여러 회사의 직원이 참여하는 외부 직장인 커뮤니티다. 현재 RP 회사의 사내 게시판이 아니다. 서로 다른 업종·회사에 다니는 글쓴이들을 혼합하고 새 글의 과반수는 현재 RP 중심 회사와 무관한 다른 회사의 직장 생활·업계 이야기를 다뤄라. 필요한 경우 가상의 회사명을 자연스럽게 창작해도 되나, 개인에 대한 사실로 단정하지 마라. 게시글/댓글 작성자 닉네임은 반드시 세계관에 맞는 회사명 · 개성 있는 익명 별명 형태로 작성하라(예: 대한그룹 · 퇴사각재는중, 한빛전자 · 칼퇴하고싶다). 회사명 자리에 부서명·직급·팀명을 절대 넣지 말고, 실명·프로필 이름·익명직장인 같은 고정 이름을 사용하지 마라. 같은 주민 residentId는 회사와 닉네임을 유지하고, 다른 주민은 회사·별명을 다양하게 만들어라. 게시글과 댓글 JSON에 company 필드를 회사명으로 함께 제공하라. 특정 회사 내부에서만 알 수 있는 정보는 외부인이 본 것처럼 단정하지 마라.':community.id==='office'?
      '사내 익명 게시판은 현재 RP에서 다니는 회사 소속 구성원만 참여한다. 외부 회사 직원이 사내 직원으로 글을 쓰지 않도록 하고, 부서·팀 관점의 회사 내부 일상과 공개 가능한 직장 소문을 중심으로 작성하라. 게시글·댓글·대댓글의 모든 작성자 nick은 반드시 팀/부서명 · 개성 있는 익명 별명 형태로 작성하라(예: 구매팀 · 퇴근요정, 인사팀 · 커피수혈중). 팀/부서명은 제공된 세계관·프로필에서 확인되는 실제 소속을 우선하고, 확인되지 않는 주민에게 임의의 특정 부서 소속을 사실처럼 부여하지 말고 부서미상으로 표시하라. 캐릭터 실명과 다른 회사 이름을 닉네임에 사용하지 말고 같은 residentId의 닉네임을 유지하라. 외부 기업 직원의 일반 블라인드 게시글처럼 작성하지 마라.':
      '';
    const nicknameRules={
      gallery:'갤러리: 일회성 AI 주민만 ㅇㅇ(가상 IP) 유동닉을 사용한다. 고정 주민과 RP 캐릭터는 익명 고정닉, 유저는 자동 유동닉/직접 설정 고정닉. 반고닉 없음.',
      everytime:'에브리타임: 각 작성자를 익명1, 익명2, 익명3처럼 숫자형 익명 표기로 구분하라. 실명, 회사명, 직급, 다른 플랫폼 아이디를 사용하지 마라. 같은 residentId는 같은 익명 번호를 재사용한다.',
      office:'사내 익명 게시판: 게시글·댓글·대댓글의 nick을 모두 팀/부서명 · 별명 형식으로 작성하라(구매팀 · 퇴근요정). 세계관에 확인된 부서를 우선 사용하고 모르면 부서미상으로 표시하라. 다른 회사명이나 실명은 쓰지 마라.',
      reddit:'Reddit: 영어를 사용하는 Reddit 특유의 자연스러운 게시글·댓글·대댓글을 작성하라. 모든 게시글·댓글 작성자는 u/로 시작하는 서로 다른 창의적인 영문 또는 영숫자 핸들을 사용한다. 익명직장인, 부서명 · 닉네임, 실명을 쓰지 마라.',
      x:'X: 모든 작성자는 @로 시작하는 짧고 개성 있는 영문·숫자·밑줄 핸들을 사용한다(예: @midnightcoffee, @afterwork_24). 실명, 회사명 · 별명, 익명직장인, @anonymous 같은 획일적 이름을 사용하지 마라.',
      neighborhood:'동네 게시판: 동네산책러, 골목길냥집사, 우리동네빵순이처럼 동네생활에 어울리는 서로 다른 자연스러운 별명을 사용하고 실명이나 회사명 형식을 쓰지 마라.'
    };
    const nicknameOverride=nicknameGuideSpec();
    const nicknameRule=nicknameOverride?'[사용자 지정 닉네임 형식 우선] 유저·RP 캐릭터·고정 주민·일반 주민의 게시글·댓글·대댓글 닉네임은 추가 지침의 형식을 따른다. 커뮤니티 기본 닉네임 규칙을 강제하지 마라. 동일한 주민 및 캐릭터는 일관된 닉네임을 사용하고 실명을 노출하지 마라. '+nicknameOverride:(nicknameRules[community.id]||'작성자의 닉네임은 해당 커뮤니티가 지정한 닉네임 형식에 맞고 서로 구분되어야 한다. 주민 ID가 같으면 기존 닉네임을 유지한다.');
    const customStyle=community.id.startsWith('custom-')?['[커뮤니티 소개] '+short(community.desc,1500),'[말투 지침] '+short(community.style,2000),'[말투 예시 (그대로 복사하지 말 것)] '+short(community.styleExample,2000)].join('\n'):'';
    const galleryTopic=community.id==='gallery'?'[갤러리 이름] '+communityBoardTitle()+'\n[갤러리 소개·주제] '+short(s.galleryDescription,2000):'';
    const instructions=`선택된 RP 캐릭터의 커뮤니티 참여는 실제 RP에서 공개적으로 확인된 참여나 발언에 근거할 때만 반영하라. 단순히 그럴 법하다는 이유로 캐릭터가 새 게시글·댓글을 작성했다고 꾸며내지 마라. 캐릭터가 직접 작성한 경우 characterProfileId에 [수집된 프로필].selectedCharacters에 포함된 캐릭터의 정확한 프로필 id 또는 _key를 넣어라. 일반 주민은 이 필드를 빈 문자열로 두어라. 실제로 작성하지 않은 캐릭터를 사칭하지 말고 캐릭터 실명을 닉네임으로 노출하지 마라. 당신은 가상의 RP 세계에 실제 거주하는 익명 커뮤니티 운영 시뮬레이터다. 관찰자·독자가 아니라 세계관 주민의 입장에서 작성하라. 공개적으로 목격·전달될 수 있는 사건만 목격 사실로 쓰고, 비밀 대화·내면·보이지 않는 사적 행동을 누설하지 마라. 소문은 실제 RP에 이미 존재하며 주민에게 알려질 수 있는 경우에만 소문/추측으로 표현하라. RP 주인공에 관한 글은 확인된 공개 사건에 근거하고, 주민들의 독립적인 일상을 자연스럽게 섞어라. 주어진 세계관의 주요 사실을 바꾸지 않는 선에서 새로운 회사·가게·지역·주민 등 배경 요소 창작은 허용하되, 이를 유저나 RP 캐릭터가 실제로 방문하거나 이용한 장소·활동으로 연결하지 마라. 기존 주민 ID는 재사용 가능하며 새로운 주민을 만들어도 된다. 사용자 글과 댓글은 삭제·수정하지 마라. 기존 사용자 댓글에 관련성 있는 AI 답글을 적절히 달고, 이미 AI가 답한 댓글에는 같은 내용의 답글을 반복하지 마라. 글과 댓글의 닉네임은 해당 커뮤니티에 맞게 만들고, 대댓글은 최대 한 단계. 출력은 반드시 JSON 객체 하나이며 Markdown 코드펜스는 제외.`;
    // Factual boundary shared by every community and every generation type.
    const rpFactRules=`[RP 사실 및 정보 접근 제한 · 전체 커뮤니티 최우선]
1. 유저·RP 캐릭터의 행동, 발언, 만남, 방문, SNS 팔로우·게시·연락 등은 제공된 실제 RP 대화에서 확인된 경우에만 일어난 사실로 서술하라. 실제 기록에 없는 사건·행동을 창작하거나, 목격담·소문·추정 형식으로 포장하지 마라. 기록에 없는 것은 일어나지 않은 것으로 단정할 필요도 없지만, 게시글의 근거로 삼을 수 없다.
2. 실제 RP에 등장한 사건이어도 커뮤니티 주민이 공개적으로 목격하거나 실제로 전달받을 수 있었던 정보인지 별도로 판단하라. 독자/서술자/AI만 아는 사실은 주민에게 전파하지 마라. 목격자나 전달 경로가 불분명하면 목격담을 지어내지 마라.
3. 유저·RP 캐릭터의 생각, 감정, 의도, 호감, 질투, 연애 감정, 독백·속마음은 비공개 정보다. RP 지문에 명시되어도 주민의 지식이 아니다. 실제로 공개된 표정·행동·발언에 대한 주민의 주관적 감상은 허용하지만, 사실처럼 확정하거나 관찰되지 않은 표정·장면을 새로 만들지 마라.
4. 비공개 대화·개인 메시지·공개되지 않은 SNS 활동·비밀·사적인 행동을 누설하지 마라. 실제 RP에서 제삼자에게 공개·전달된 근거가 있는 내용만 해당 공개 범위 안에서 사용하라.
5. [최근 커뮤니티 게시글]에 포함된 기존 AI 게시글·댓글·대댓글은 RP 사건의 증거가 아니다. 과거 AI 생성 글이 주장하는 미확인 사건을 실제로 확정하거나 이를 이어 유저·캐릭터의 새로운 사건을 만들어내지 마라. 댓글 토론의 소재로는 쓸 수 있지만 그 주장 자체가 사실임을 입증하지 않는다. 사용자 작성 커뮤니티 글도 실제 RP 대화의 독립적 증거와 구별하라.
6. 일반 주민의 독립적인 일상·잡담·주관적 의견, 세계관에 모순되지 않는 가상 가게·회사·지역 등 배경 창작은 허용한다. 단, 그것을 특정 유저·RP 캐릭터에게 일어난 새로운 사건·속마음·관계의 근거로 연결하지 마라.
7. 이 규칙은 새 게시글의 제목·본문, 댓글·대댓글, 기존 글에 추가하는 반응, 모든 커뮤니티와 소문 이어가기 설정에 동일하게 적용한다. 다른 커뮤니티 지침이나 추가 지침이 충돌하더라도 이 사실 제한을 우선하라.
8. 작성 전 실제 RP 근거 존재 여부 → 주민의 정보 접근 가능 여부 → 새 사건 창작 여부를 점검하라. 하나라도 불명확하면 유저·캐릭터에 관한 그 주장을 생략하고 관련 없는 주민 일상·일반적인 게시판 주제로 대체하라. 점검 과정은 출력하지 말고 JSON만 출력하라.`;
    const schema=`JSON 형태: {"posts":[{"title":"제목 원문","titleKo":"제목 한국어 번역","body":"본문 원문","bodyKo":"본문 한국어 번역","company":"소속 회사명(블라인드)","nick":"추가 지침이 있으면 그 닉네임 형식, 없으면 커뮤니티 기본 형식","characterProfileId":"RP 캐릭터 본인인 경우에만 선택된 캐릭터의 프로필 id 또는 _key, 일반 주민이면 빈 문자열","residentId":"재사용할 주민 ID 또는 새 주민용 임의 별칭","views":10,"likes":2,"comments":[{"company":"소속 회사명(블라인드)","nick":"추가 지침이 있으면 그 닉네임 형식, 없으면 커뮤니티 기본 형식","characterProfileId":"RP 캐릭터 본인의 글이면 프로필 id 또는 _key, 아니면 빈 문자열","residentId":"임의 별칭","text":"댓글 원문","textKo":"댓글 한국어 번역","likes":1,"replies":[{"company":"소속 회사명(블라인드)","nick":"추가 지침이 있으면 그 닉네임 형식, 없으면 커뮤니티 기본 형식","characterProfileId":"RP 캐릭터 본인의 글이면 프로필 id 또는 _key, 아니면 빈 문자열","residentId":"임의 별칭","text":"대댓글 원문","textKo":"대댓글 한국어 번역","likes":0}]}]}],"updates":[{"postId":"과거 게시글 ID","comments":[{"company":"소속 회사명(블라인드)","nick":"추가 지침이 있으면 그 닉네임 형식, 없으면 커뮤니티 기본 형식","characterProfileId":"RP 캐릭터 본인의 글이면 프로필 id 또는 _key, 아니면 빈 문자열","residentId":"임의 별칭","text":"추가 댓글 원문","textKo":"추가 댓글 한국어 번역","likes":0,"replies":[]}],"replies":[{"parentCommentId":"기존 사용자 댓글 ID","company":"소속 회사명(블라인드)","nick":"추가 지침이 있으면 그 닉네임 형식, 없으면 커뮤니티 기본 형식","characterProfileId":"RP 캐릭터 본인의 글이면 프로필 id 또는 _key, 아니면 빈 문자열","residentId":"임의 별칭","text":"사용자 댓글에 대한 대댓글 원문","textKo":"대댓글 한국어 번역","likes":0}]}]}. 원본에 없는 postId는 사용 금지.`;
    const translationRule=translationOn()?'[번역 ON] 영어 원문 등 해당 커뮤니티에 자연스러운 원문 언어로 먼저 작성하라. 원문 제목·본문·댓글·대댓글은 각각 title/body/text에 넣고, 같은 내용의 자연스럽고 충실한 한국어 번역을 titleKo/bodyKo/textKo에 함께 넣어라. Reddit에서는 영어 원문을 우선 생성하고 영어 인터넷 특유의 표현과 말투를 유지한다. 한국어 번역은 원문 의미를 누락하거나 창작하지 말고 대응시켜라. 모든 AI 신규/추가 댓글/대댓글에 번역 필드를 제공하라. 사용자 원문을 수정하거나 번역하여 다시 내보내지 마라.':'[번역 OFF] 원래 커뮤니티에 어울리는 언어와 말투로 작성하고 한국어 번역 필드는 생략하거나 빈 문자열로 둬라.';
    const userLanguageRule='[사용자 작성글 언어 해석 · 모든 커뮤니티 공통] 사용자가 직접 작성한 게시글·댓글·대댓글은 입력 언어와 관계없이 해당 커뮤니티의 기본 언어로 작성된 발언으로 간주하라. 주민과 RP 캐릭터는 해당 커뮤니티의 기본 언어로 된 발언을 읽은 것처럼 의미와 어조를 이해하고 자연스럽게 반응하라. 답변은 해당 커뮤니티의 언어와 말투를 따르라. 사용자 원문은 수정하지 않고 그대로 보존하라. 입력 언어가 다르다는 이유로 언어 차이를 지적하지 마라.';
    const task=kind==='react'?`아래 사용자 게시글/댓글을 대상으로 AI 주민의 반응만 생성. 새 게시글은 0개. 대상 글 ID=${post?.id||''}. 이전 글 중 해당 글에만 댓글 또는 기존 사용자 댓글에 대한 대댓글을 추가.`:`새 게시글 ${num(s.posts,1,15,3)}개를 목표로 생성하라. 새 게시글당 댓글 최대 ${num(s.newComments,0,30,7)}개. 기존 최근 ${num(s.oldPostWindow,0,300,20)}개 글 중 내용 관련성이 높은 글에만 추가 댓글을 작성하되, 모든 기존 글에 추가되는 댓글·대댓글 총합은 ${num(s.oldComments,0,100,10)}개 이하. 특히 관련성 있는 기존 사용자 댓글(source=user)을 확인해 해당 댓글 ID로 replies를 작성하라. ${s.quiet==='skip'?'공개 사건이 전혀 없다면 게시글과 댓글 생성 생략':s.quiet==='rumors'?'새 사건이 없으면 기존 소문만 이어가기':'새 사건이 없으면 세계관 주민 일상 글 작성'}.`;
    return `${rpFactRules}\n${instructions}\n${userLanguageRule}\n[번역 출력 규칙] ${translationRule}\n${galleryTopic}\n[사용자 지정 커뮤니티 지침] ${customStyle}\n[커뮤니티별 작성 규칙] ${nicknameOverride&&community.id==='blind'?'블라인드는 여러 회사의 직장인이 참여하는 외부 커뮤니티다. 특정 회사 내부의 비공개 정보는 노출하지 마라. 닉네임은 사용자 추가 지침을 우선하라.':nicknameOverride&&community.id==='office'?'사내 익명 게시판은 RP 세계관의 같은 회사 직원들만 참여한다. 닉네임은 사용자 추가 지침을 우선하라.':communityRules}\n[닉네임 필수 규칙] ${nicknameRule}\n${schema}\n[작업] ${task}\n[커뮤니티] ${JSON.stringify(community)}\n[커뮤니티별 생성 지침] ${short(s.communityGuides?.[community.id]||'',5000)}\n[수집된 프로필] ${JSON.stringify({user:short(s.profiles.user,5000),characters:short(s.profiles.characters,9000),world:short(s.profiles.world,6500),selectedCharacters:profileSelection().characters.slice(0,30),selectedUser:profileSelection().user})}\n[최근 RP 대화 (개인정보 및 비공개 사실은 주민에게 직접 노출 금지)] ${JSON.stringify(recent).slice(0,20000)}\n[기존 주민] ${JSON.stringify(residents).slice(0,7500)}\n[최근 커뮤니티 게시글 · 이전 AI 창작물은 실제 RP 사건의 증거가 아님] ${JSON.stringify(older).slice(0,14000)}\n[사용자 반응 대상] ${JSON.stringify(post||{}).slice(0,5000)}\n[최종 사실 검증] 위 RP 사실 및 정보 접근 제한을 제목·본문·댓글·대댓글 전부에 다시 적용하고, 확인되지 않은 유저·캐릭터의 행동·속마음·소문은 제거하라. JSON 객체만 답하라.`;
  }
  function parseGemini(result){let text=safeArray(result.candidates?.[0]?.content?.parts).map(p=>p.text||'').join('').trim();text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text);}catch{const m=/\{[\s\S]*\}/.exec(text);if(m)return JSON.parse(m[0]);throw new Error('Gemini JSON 형식 오류');}}
  // Blind's displayed identity uses a company, not a department or a real person.
  // User company is derived from saved fictional RP context when available.
  const blindFictionalCompanies=['대한그룹','한빛전자','미래건설','대성금융','우림테크','다온물산','새빛통신'];
  const blindAliasWords=['퇴사각재는중','칼퇴하고싶다','월급루팡3년차','연차언제쓰냐','커피수혈중','회의좀그만','퇴근벨울려라','오늘도야근','점심시간만기다림','직장인생존기','출근하기싫다'];
  const companyPattern=/([가-힣A-Za-z0-9]{2,22}(?:그룹|기업|전자|건설|금융|테크|산업|통신|상사|제약|은행|보험|모터스|솔루션|유통|물산|바이오|시스템즈|홀딩스))/g;
  const companyGeneric=new Set(['대기업','중소기업','공기업','중견기업','일반기업','벤처기업','사기업']);
  const hashLabel=text=>{let h=2166136261;for(const ch of String(text||'')){h=Math.imul(h^ch.charCodeAt(0),16777619);}return h>>>0;};
  function companiesInText(text){return [...String(text||'').matchAll(companyPattern)].map(m=>m[1]).filter(n=>!companyGeneric.has(n));}
  function userBlindCompany(){
    const settings=data?.settings||{};
    const profile=settings.savedProfiles?.user||{};
    const texts=[profile.description,settings.profiles?.user,settings.profiles?.world,
      ...safeArray(settings.savedProfiles?.characters).map(c=>c.description)];
    for(const t of texts){const names=companiesInText(t);if(names.length)return names[0];}
    return blindFictionalCompanies[hashLabel(room)%blindFictionalCompanies.length];
  }
  function validBlindCompany(value){
    const text=short(value,40);
    if(!text||/팀$|실$|부서$|본부$|직급$|파트$|대리$|과장$|부장$|주임$|직원$|익명/.test(text))return '';
    // Company names can be user-created in the fictional setting; avoid generic job labels.
    if(companyGeneric.has(text)||text==='회사원'||text==='직장인')return '';
    return text;
  }
  function blindNick(rawNick,residentId,company){
    const existing=residentId&&currentBoard().residents?.[residentId]?.nick;
    if(existing&&existing.includes(' · ')&&validBlindCompany(existing.split(' · ')[0]))return short(existing,60);
    const raw=short(rawNick,60),pair=raw.split(/\s*·\s*/);
    const prefix=pair.length>1?validBlindCompany(pair[0]):'';
    const forced=validBlindCompany(company);
    const seed=String(residentId||raw||uid());
    // A new fictional company is selected only when Gemini supplies no real
    // fictional-company affiliation. The same residentId always gets the same fallback.
    const companyName=forced||prefix||blindFictionalCompanies[hashLabel('company:'+seed)%blindFictionalCompanies.length];
    let alias=pair.length>1?pair.slice(1).join(' '):raw;
    const rpNames=[data?.settings?.savedProfiles?.user?.name,
      ...safeArray(data?.settings?.savedProfiles?.characters).map(p=>p.name)].filter(Boolean);
    if(!alias||/^(익명|익명직장인|익명직원|익명 주민|직장인|회사원|사용자|닉네임)$/i.test(alias)||
      rpNames.includes(alias)||alias===companyName)
      alias=blindAliasWords[hashLabel('alias:'+seed)%blindAliasWords.length];
    return short(companyName+' · '+alias,60);
  }
  // Platform-specific identity normalization for EVERY AI post/comment/reply.
  // Keep a single identity per residentId inside each board and do not reveal RP names.
  const platformAliases={
    office:['퇴근요정','기획팀막내','야근탈출러','월요일싫어','익명사원42','커피는생명','사내식당러','회의탈주각','칼퇴기원','재택희망러','서류더미','출근5분전'],
    neighborhood:['골목길냥집사','동네빵순이','산책중독','공원한바퀴','우리동네맛집러','아침조깅러','옆집화분','햇살좋은날','동네책방러','시장구경러','길냥이집사','동네사진가'],
    reddit:['afterworkowl','coffee_overflow','quietobserver','moonlit_shift','dailywanderer','office_survivor','nightreader','cityscroll','weekend_mode','rainydaytalk','snacktheory','cloudwriter'],
    x:['midnightcoffee','afterwork_24','dailyblink','softsignal','citynote','sleepybyte','dayoffsoon','paperplane_7','littleupdate','lowbattery99','skylinetalk','moonphase_8']
  };
  const genericPlatformNames=/^(?:익명|익명\s*직장인|익명직원|익명 주민|익명사원|anonymous|anon|user|username|nickname|닉네임|사용자|직장인|회사원|나|unknown)$/i;
  function isRpRealName(label){
    const name=short(label,100).replace(/^(?:u\/|@)/,'').trim();
    const characters=safeArray(data?.settings?.savedProfiles?.characters);
    const names=[data?.settings?.savedProfiles?.user?.name,...characters.map(c=>c.name)].filter(Boolean);
    return names.some(n=>String(n).trim()===name);
  }
  function platformAlias(type,seed){
    const list=platformAliases[type]||platformAliases.neighborhood;
    const first=list[hashLabel(type+':'+seed)%list.length];
    return first;
  }
  // Fictional two-octet labels, not real or queried IP addresses.
  function galleryFluidNick(seed){
    const h=hashLabel('gallery-ip:'+String(room||'')+':'+String(seed));
    return 'ㅇㅇ('+[39,59,61,106,110,112,118,121,175,211,223][h%11]+'.'+(1+Math.floor(h/11)%254)+')';
  }
  function galleryFixedAlias(seed){
    const first=['새벽','동네','구석','하루','달빛','소금','느긋한','야식','초록','밤샘','작은','푸른'];
    const last=['갤러','산책러','구경꾼','메모장','모험가','잠꾸러기','관찰자','수다쟁이','덕후','고양이','주민','책벌레'];
    const h=hashLabel('gallery-fixed:'+String(room||'')+':'+String(seed));
    return first[h%first.length]+last[Math.floor(h/first.length)%last.length];
  }
  function galleryDisplayNick(item){
    if(item?.source==='user')return item.nick||galleryFluidNick('user');
    if(item?.characterProfileId)return galleryFixedAlias('character:'+item.characterProfileId);
    const id=short(item?.residentId||'',75);
    const fixed=id&&currentBoard()?.residents?.[id];
    return fixed?fixed.nick:galleryFluidNick(id||item?.id||'guest');
  }
  // Office nicknames show a department and an anonymous alias, never a real name.
  // Existing stored posts remain unchanged; only newly generated identities are normalized.
  function officeDepartment(text){
    const value=short(text,20000);
    const departmentPattern='([가-힣A-Za-z0-9]{2,22}(?:팀|부서|본부|파트|실|센터))';
    const labeled=new RegExp('(?:소속\\s*(?:부서|팀)?|부서명|소속팀|근무\\s*부서|부서|팀명)\\s*[:：-]\\s*'+departmentPattern);
    const m=labeled.exec(value);
    if(m)return m[1];
    const free=new RegExp('(?:^|[\\s(（,·])'+departmentPattern+'(?=[\\s)）,.\\/]|$)');
    const guess=free.exec(value);
    if(guess&&!/^(?:우리팀|다른팀|회사팀|전체팀)$/.test(guess[1]))return guess[1];
    return '';
  }
  function userOfficeDepartment(){
    const settings=data?.settings||{},user=settings.savedProfiles?.user||{};
    for(const text of [user.description,settings.profiles?.user]){
      const dept=officeDepartment(text);
      if(dept)return dept;
    }
    return '부서미상';
  }
  function officeNick(rawNick,residentId,characterKey=''){
    const board=currentBoard(),id=short(residentId||'',75);
    const existing=id&&board.residents?.[id]?.nick;
    const seed=String(id||characterKey||rawNick||uid());
    const source=short(existing||rawNick,60);
    const parts=source.split(/\s*·\s*/);
    const dept=parts.length>1&&/^[가-힣A-Za-z0-9]{2,24}(?:팀|부서|본부|파트|실|센터)$/.test(parts[0])?parts[0]:'';
    let alias=parts.length>1?parts.slice(1).join(' ').trim():source;
    if(!alias||genericPlatformNames.test(alias)||isRpRealName(alias)||/^(?:익명사원\d*|익명직원\d*|부서미상)$/.test(alias))
      alias=platformAlias('office',seed);
    return short((dept||'부서미상')+' · '+alias,60);
  }

  // A saved room/community instruction can replace default nickname formats.
  function nicknameGuideSpec(){
    const lines=String(data?.settings?.communityGuides?.[currentCommunity().id]||'').split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      const line=lines[i].trim();
      if(!/(?:닉네임|별명|닉\s*형식|작성자\s*이름)/.test(line)||!/(?:형식|규칙|사용|표시|지정|포함|붙이|없이|금지|제외|설정|따라)/.test(line))continue;
      return short(line+(/[:：]\s*$/.test(line)?' '+String(lines[i+1]||'').trim():''),600);
    }
    return '';
  }
  function nicknameGuideKey(){
    const rule=nicknameGuideSpec();
    return rule?'guide-'+hashLabel(rule).toString(36):'';
  }
  function guidedNickname(rawNick,residentId='',characterKey='',user=false){
    const rule=nicknameGuideSpec(),key=nicknameGuideKey();
    if(!rule)return '';
    const seed=characterKey?'character:'+characterKey:user?'user:'+String(room||'room'):String(residentId||rawNick||uid());
    let existing='';
    if(!user){
      const posts=safeArray(currentBoard().posts);
      for(let p=posts.length-1;p>=0&&!existing;p--){
        const items=[posts[p],...safeArray(posts[p].comments).flatMap(c=>[c,...safeArray(c.replies)])];
        for(let i=items.length-1;i>=0;i--){
          const item=items[i];
          if(item.nicknameGuideKey!==key)continue;
          if(characterKey?item.characterProfileId===characterKey:residentId&&item.residentId===residentId){existing=short(item.nick,60);break;}
        }
      }
    }
    let nick=short(existing||rawNick,60);
    const noDot=/(?:[·ㆍ].{0,25}(?:포함하지|포함되지|포함하지\s*않|없이|금지|제외|넣지|쓰지|사용하지)|(?:별명|닉네임)만\s*(?:사용|표시)|(?:회사명|부서명|팀명).{0,22}(?:빼|없이|제외|붙이지))/.test(rule);
    const numeric=/익명\s*(?:\+|뒤에|과|및)?\s*숫자\s*(\d{1,2})\s*자리/.exec(rule);
    if(numeric){
      const digits=Math.min(10,Math.max(1,Number(numeric[1])));
      return '익명'+String(hashLabel('guide:'+room+':'+currentCommunity().id+':'+seed)%10**digits).padStart(digits,'0');
    }
    if(noDot)nick=nick.split(/\s*[·ㆍ]\s*/).pop().trim();
    if(/(?:u\/username|u\/핸들|u\/영문|u\/아이디)/i.test(rule)){
      const stem=nick.replace(/^u\//,'').replace(/[^A-Za-z0-9_-]/g,'');
      nick='u/'+(stem.length>=3?stem.slice(0,28):platformAlias('reddit',seed));
    }else if(/(?:@username|@핸들|@아이디|@영문)/i.test(rule)){
      const stem=nick.replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'');
      nick='@'+(stem.length>=2?stem.slice(0,15):platformAlias('x',seed).slice(0,15));
    }
    if(!nick||genericPlatformNames.test(nick)||isRpRealName(nick))nick=platformAlias('office',seed);
    if(/(?:팀\/부서명|부서명|팀명).{0,12}[·ㆍ].{0,12}(?:별명|닉네임)/.test(rule)&&!nick.includes(' · '))
      nick=(user?userOfficeDepartment():'부서미상')+' · '+nick;
    if(/(?:회사명|기업명).{0,12}[·ㆍ].{0,12}(?:별명|닉네임)/.test(rule)&&!nick.includes(' · '))
      nick=(user?userBlindCompany():blindFictionalCompanies[hashLabel('company:'+seed)%blindFictionalCompanies.length])+' · '+nick;
    return short(nick,60);
  }
  function communityNick(rawNick,residentId,company,characterKey=''){
    const type=currentCommunity().id;
    if(nicknameGuideSpec())return guidedNickname(rawNick,residentId,characterKey);
    if(type==='blind')return blindNick(rawNick,residentId,company);
    if(type==='office')return officeNick(rawNick,residentId,characterKey);
    if(type==='gallery')return characterKey?galleryFixedAlias('character:'+characterKey):galleryFluidNick(residentId||uid());
    const board=currentBoard(),id=short(residentId||'',75);
    // Previously saved AI identities are reused only if they already follow
    // this community format (not a name carried over from another community).
    const existing=id&&board.residents?.[id]?.nick;
    const raw=short(rawNick,60);
    const validX=n=>/^@[a-zA-Z0-9_]{2,15}$/.test(n)&&!/^@(?:anonymous|anon|user|username|nickname|unknown)$/i.test(n);
    const validReddit=n=>/^u\/[a-zA-Z0-9_-]{3,28}$/.test(n)&&!/^u\/(?:anonymous|anon|user|username|unknown)$/i.test(n);
    const isInvalid=n=>!n||genericPlatformNames.test(n)||isRpRealName(n)||
      (n.includes(' · ')&&type!=='blind')||/^익명직장인/i.test(n);
    const seed=id||raw||uid();
    function normalized(n){
      if(type==='everytime')return '익명';
      if(type==='reddit'){
        if(validReddit(n)&&!isRpRealName(n))return n;
        const handle=n.replace(/^u\//,'').replace(/[^a-zA-Z0-9_-]/g,'');
        if(handle.length>=3&&validReddit('u/'+handle))return 'u/'+handle.slice(0,28);
        return 'u/'+platformAlias('reddit',seed);
      }
      if(type==='x'){
        if(validX(n)&&!isRpRealName(n))return n;
        const handle=n.replace(/^@/,'').replace(/[^a-zA-Z0-9_]/g,'');
        if(handle.length>=2&&validX('@'+handle.slice(0,15)))return '@'+handle.slice(0,15);
        return '@'+platformAlias('x',seed).slice(0,15);
      }
      if(type==='neighborhood'){
        if(!isInvalid(n))return n;
        return platformAlias(type,seed);
      }
      // Custom communities retain their own user-defined nickname rules.
      return n||'익명 주민';
    }
    return short(normalized(existing?normalized(existing):raw),60);
  }
  // Mark RP characters only with a confirmed selected profile ID.
  function characterAuthorKey(raw){
    const id=String(raw?.characterProfileId||'').trim();
    if(!id)return '';
    const found=profileSelection().characters.find(p=>id===profileKey(p)||id===String(p.id||''));
    return found?profileKey(found):'';
  }
  function authorBadge(item){
    if(item?.source==='user'){const name=short(profileSelection().user?.name||'내 글',160);return '<span class="zab-author-badge zab-author-me">'+esc(name)+'</span>';}
    const char=item?.characterProfileId&&profileSelection().characters.find(p=>profileKey(p)===item.characterProfileId);
    return char?'<span class="zab-author-badge zab-author-character">'+esc(char.name)+'</span>':'';
  }
  function authorName(item){
    const label=authorBadge(item);
    const kind=item?.source==='user'?'zab-author-me-name':label?'zab-author-character-name':'';
    return '<span class="'+kind+'">'+esc(item?.nick||'익명')+'</span>'+label;
  }
  function normalizeComment(raw){const rpTime=currentRpStamp();const c={id:uid(),nicknameGuideKey:nicknameGuideKey(),characterProfileId:characterAuthorKey(raw),textKo:translationOn()?short(raw.textKo||'',3500):'',nick:communityNick(raw.nick,raw.residentId,raw.company,characterAuthorKey(raw)),residentId:short(raw.residentId||'',75),text:short(raw.text,3500),likes:num(raw.likes,0,999999,0),time:now(),rpTime,source:'ai',replies:[]};c.replies=safeArray(raw.replies).slice(0,12).map(r=>({id:uid(),nicknameGuideKey:nicknameGuideKey(),characterProfileId:characterAuthorKey(r),textKo:translationOn()?short(r.textKo||'',3000):'',nick:communityNick(r.nick,r.residentId,r.company),residentId:short(r.residentId||'',75),text:short(r.text,3000),likes:num(r.likes,0,999999,0),time:now(),rpTime,source:'ai',parentId:c.id})).filter(x=>x.text);return c;}
  function applyResult(out,kind,replaceBatch){if(!out||typeof out!=='object')throw new Error('Gemini 생성 결과가 올바르지 않아요.');const board=currentBoard();if(replaceBatch)rollback(replaceBatch);const batch={id:uid(),created:[],comments:[],metrics:{},temporary:kind==='auto',time:now()};const posts=kind==='react'?[]:safeArray(out.posts).slice(0,num(data.settings.posts,1,15,3));for(const raw of posts){if(!String(raw.title||'').trim()&&!String(raw.body||'').trim())continue;const p={id:uid(),nicknameGuideKey:nicknameGuideKey(),characterProfileId:characterAuthorKey(raw),titleKo:translationOn()?short(raw.titleKo||'',180):'',bodyKo:translationOn()?short(raw.bodyKo||'',8500):'',title:short(raw.title||'무제',180),body:short(raw.body,8500),nick:communityNick(raw.nick,raw.residentId,raw.company,characterAuthorKey(raw)),residentId:short(raw.residentId||'',75),views:num(raw.views,0,10000000,10),likes:num(raw.likes,0,10000000,0),time:now(),rpTime:currentRpStamp(),source:'ai',comments:safeArray(raw.comments).slice(0,num(data.settings.newComments,0,30,7)).map(normalizeComment).filter(c=>c.text)};board.posts.push(p);batch.created.push(p.id);}
    let count=0;const eligible=new Set(board.posts.slice(-num(data.settings.oldPostWindow,0,300,20)-posts.length).filter(p=>!batch.created.includes(p.id)).map(p=>p.id));if(kind==='react'&&replaceBatch?.targetPost)eligible.add(replaceBatch.targetPost);
    for(const update of safeArray(out.updates)){const p=board.posts.find(p=>p.id===update.postId);if(!p||(!eligible.has(p.id)&&!(kind==='react'&&p.id===reactionTarget)))continue;for(const raw of safeArray(update.comments)){const c=normalizeComment(raw);const added=1+c.replies.length;if(count+added>num(data.settings.oldComments,0,100,10))break;if(!c.text)continue;p.comments.push(c);batch.comments.push(c.id,...c.replies.map(r=>r.id));count+=added;}}
    // Attach AI responses to existing user comments, never to the post root.
    for(const update of safeArray(out.updates)){
      const post=board.posts.find(p=>p.id===update.postId);
      if(!post||(!eligible.has(post.id)&&!(kind==='react'&&post.id===reactionTarget)))continue;
      for(const raw of safeArray(update.replies)){
        if(count>=num(data.settings.oldComments,0,100,10))break;
        const parent=post.comments.find(c=>c.id===raw.parentCommentId&&c.source==='user');
        if(!parent||safeArray(parent.replies).some(x=>x.source==='ai'))continue;
        const replyText=short(raw.text,3000);if(!replyText)continue;
        const reply={id:uid(),nicknameGuideKey:nicknameGuideKey(),characterProfileId:characterAuthorKey(raw),textKo:translationOn()?short(raw.textKo||'',3000):'',nick:communityNick(raw.nick,raw.residentId,raw.company,characterAuthorKey(raw)),residentId:short(raw.residentId||'',75),text:replyText,likes:num(raw.likes,0,999999,0),time:now(),rpTime:currentRpStamp(),source:'ai',parentId:parent.id};
        parent.replies.push(reply);batch.comments.push(reply.id);count++;
      }
    }
    syncRecurringResidents(board);
    board.unread+=batch.created.length;for(const p of board.posts){if(batch.created.includes(p.id))continue;batch.metrics[p.id]={views:p.views,likes:p.likes};const age=Math.max(0,(now()-p.time)/86400000);const factor=Math.max(0.05,1/(1+age/2));p.views+=Math.floor((4+Math.random()*26)*factor);p.likes+=Math.floor(Math.random()*4*factor);for(const c of p.comments){if(c.source==='ai'&&Math.random()<0.45)c.likes+=1;}}
    if(batch.created.length||batch.comments.length)board.lastBatch=batch;board.started=true;saved();return batch;
  }
  // A resident becomes fixed only after appearing in different posts.
  // User and RP characters use their own existing profiles, never residents.
  function syncRecurringResidents(board){
    const appearances=new Map();
    const collect=(item,postId)=>{
      if(!item||item.source==='user'||item.characterProfileId)return;
      const id=short(item.residentId||'',75);
      if(!id||id==='user'||!item.nick)return;
      let row=appearances.get(id);
      if(!row){row={posts:new Set(),nick:item.nick};appearances.set(id,row);}
      row.posts.add(postId);
    };
    for(const p of safeArray(board.posts)){
      collect(p,p.id);
      for(const c of safeArray(p.comments)){
        collect(c,p.id);
        for(const reply of safeArray(c.replies))collect(reply,p.id);
      }
    }
    const previous=board.residents&&typeof board.residents==='object'?board.residents:{};
    const fixed={};
    for(const [id,row] of appearances){
      if(row.posts.size>=2)fixed[id]={id,nick:previous[id]?.nick||(currentCommunity().id==='gallery'?galleryFixedAlias('resident:'+id):row.nick)};
    }
    for(const [id,row] of Object.entries(previous)){
      if(row?.pinned&&id!=='user')fixed[id]={id,nick:row.nick,pinned:true};
    }
    board.residents=fixed;
  }
  let reactionTarget='';
  async function generate(kind='manual',post=null){if(!data)return;const board=currentBoard(),key=getKey();if(busy)return show('이미 생성 중이에요.');if(!key){settingsOpen=true;settingTab='api';render();return show('Gemini API 키를 입력해 주세요.');}
    if(!profileReady()){
      if(kind==='auto')return show('자동 생성 대기 · '+profileSelectionStatus());
      profilePanelOpen=true;settingsOpen=false;render();return show('필수 프로필 선택이 필요해요. '+profileSelectionStatus());
    }
    if(!board.started&&kind==='auto')return;clearTimeout(autoTimer);const batchToReplace=kind==='regenerate'?board.lastBatch:null;
    const request={id:uid(),kind,cancelled:false,room,community:data.settings.selected,epoch:runEpoch,request:null};const countedAtStart=turnCount;let succeeded=false;busy=request;reactionTarget=post?.id||'';renderStatus();try{const prompt=promptPayload(kind==='react'?'react':'generate',post);const model=data.settings.model||models[0];const body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.9,responseMimeType:'application/json',maxOutputTokens:8192}};const res=await generateWithFallback(key,model,body,request);if(request.cancelled||busy!==request||request.room!==room||request.community!==data?.settings.selected||request.epoch!==runEpoch)return;const result=parseGemini(res);if(kind==='regenerate'&&batchToReplace&&board.lastBatch!==batchToReplace)throw Error('재생성 대상이 변경되었습니다.');const next=applyResult(result,kind,batchToReplace);if(kind==='manual'||kind==='auto'){turnCount=kind==='auto'?Math.max(0,turnCount-countedAtStart):0;autoStage='';if(kind==='manual'&&baselineReady){const complete=buildTurns(lastRawMessageSnapshot).filter(t=>!t.incomplete);completedTurnTotal=complete.length;const last=complete.at(-1);if(last){activeTurnKey=last.id;activeTurnHash=fingerprint(last);}}}if(kind==='regenerate'){next.temporary=batchToReplace?.temporary||false;saved();}succeeded=true;show('게시판 갱신 완료 · 새 게시글 '+next.created.length+'개');render();}
    catch(e){if(!request.cancelled)show('게시글 생성 실패: '+e.message);}finally{if(busy===request)busy=null;reactionTarget='';if(succeeded&&kind==='auto'&&turnCount>=data?.settings.turns&&data?.settings.auto&&!autoTimer&&activeTurnKey&&!request.cancelled)scheduleAuto(activeTurnKey,activeTurnHash);render();}
  }
  function chooseNick(){
    const custom=String(data.settings.userNick||'').trim();
    const type=currentCommunity().id;
    if(nicknameGuideSpec()){
      const raw=data.settings.userNickMode==='custom'&&custom?custom:platformAlias('office','user:'+room+':'+type);
      return guidedNickname(raw,'','',true);
    }
    if(data.settings.userNickMode==='custom'&&custom){
      if(type==='blind'){
        const pair=custom.split(/\s*·\s*/);
        return pair.length>1&&validBlindCompany(pair[0])?short(custom,60):short(userBlindCompany()+' · '+custom,60);
      }
      if(type==='office'){
        const pair=custom.split(/\s*·\s*/);
        const dept=pair.length>1&&/^[가-힣A-Za-z0-9]{2,24}(?:팀|부서|본부|파트|실|센터)$/.test(pair[0])?pair[0]:userOfficeDepartment();
        return short(dept+' · '+(pair.length>1?pair.slice(1).join(' ').trim():custom),60);
      }
      return short(custom,60);
    }
    const board=currentBoard();
    if(type==='gallery'){
      if(!board.userGallerySeed){board.userGallerySeed=uid();saved();}
      return galleryFluidNick('user:'+board.userGallerySeed);
    }
    if(type==='office'){
      const seed='user:'+String(room||'room')+':office';
      const nickname=officeNick(platformAlias('office',seed),seed);
      return userOfficeDepartment()+' · '+nickname.split(' · ').slice(1).join(' · ');
    }
    if(type==='blind'){
      if(!board.userBlindNickname){
        const seed=String(room||board.posts.length);
        board.userBlindNickname=userBlindCompany()+' · '+blindAliasWords[hashLabel('user:'+seed)%blindAliasWords.length];
        saved();
      }
      return board.userBlindNickname;
    }
    // Preserve each community's private user pseudonym across posts and reloads.
    if(!board.userCommunityNick||board.userCommunityNickType!==type){
      const seed='user:'+String(room||'room')+':'+type;
      board.userCommunityNick=communityNick('',seed,'');
      board.userCommunityNickType=type;
      saved();
    }
    return board.userCommunityNick;
  }
  function makeOwnPost(title,body){if(!title.trim()||!body.trim())return show('제목과 본문을 입력해 주세요.');const b=currentBoard();b.posts.push({id:uid(),nicknameGuideKey:nicknameGuideKey(),title:short(title,180),body:short(body,8500),nick:chooseNick(),residentId:'user',views:0,likes:0,time:now(),rpTime:currentRpStamp(),source:'user',comments:[]});saved();postsView='list';render();}
  function addOwnComment(postId,parentId,text){if(!text.trim())return;const p=currentBoard().posts.find(x=>x.id===postId);if(!p)return;const c={id:uid(),nicknameGuideKey:nicknameGuideKey(),nick:chooseNick(),residentId:'user',text:short(text,3500),likes:0,time:now(),rpTime:currentRpStamp(),source:'user',replies:[]};if(parentId){const parent=p.comments.find(c=>c.id===parentId)||p.comments.find(c=>c.replies.some(r=>r.id===parentId));if(parent){c.parentId=parent.id;parent.replies.push(c);}}else p.comments.push(c);markRead(p.id);saved();render();}
  function deletePost(id){if(!confirm('이 게시글과 모든 댓글을 삭제할까요?'))return;const b=currentBoard();b.posts=b.posts.filter(p=>p.id!==id);if(b.lastBatch?.created.includes(id))b.lastBatch.created=b.lastBatch.created.filter(x=>x!==id);saved();postsView='list';render();}
  function prepareReset(){
    invalidatePending('');
    runEpoch++;
    clearTimeout(autoTimer);autoTimer=null;
    clearTimeout(autoRetryTimer);autoRetryTimer=null;
    pendingAutoCheck=null;autoWaitUntil=0;autoStage='';
    turnCount=0;activeTurnKey='';activeTurnHash='';
    postsView='list';detailId='';
  }
  function resetCommunity(){
    if(!data||!confirm('현재 채팅방의 ['+currentCommunity().name+'] 게시글·댓글·주민 기록을 삭제할까요? 다른 커뮤니티와 프로필·설정·API 키는 유지됩니다.'))return;
    prepareReset();
    data.boards[data.settings.selected]=blankBoard();
    saved();render();show('현재 커뮤니티를 초기화했어요.');
  }
  function resetRoomCommunities(){
    if(!data||!confirm('현재 채팅방의 모든 커뮤니티 게시글·댓글·주민 기록을 삭제할까요? 다른 채팅방과 현재 프로필·설정·API 키는 유지됩니다.'))return;
    prepareReset();
    data.boards={};
    saved();render();show('현재 채팅방을 초기화했어요.');
  }
  async function resetAllChatRooms(){
    if(!data||!room||!confirm('모든 채팅방의 게시판 기록, 커뮤니티 설정, 저장된 프로필 및 닉네임을 전부 삭제할까요? Gemini API 키는 유지됩니다. 복구하려면 기존 JSON 백업이 필요합니다.'))return;
    if(!confirm('최종 확인: 모든 채팅방의 게시판 데이터를 삭제합니다. 계속할까요?'))return;
    const initialRoom=room;
    prepareReset();
    try{
      await clearAllRoomRecords();
      if(room!==initialRoom)return;
      data=blankRoom(initialRoom);
      profileCache={characters:[],users:[],plot:null};
      profileDraftSelection={userId:'',characterIds:[]};
      profileInfo='저장된 프로필 없음';
      profilePanelOpen=false;settingsOpen=true;settingTab='data';
      render();show('모든 채팅방의 게시판 데이터를 초기화했어요. 공통 기본/API 설정은 유지됩니다.');
    }catch(e){show('전체 초기화 실패: '+e.message);}
  }
  // Track the comment/reply tree when a post is opened so later activity is unread.
  function activitySignature(p){
    return safeArray(p.comments).map(c=>c.id+':'+safeArray(c.replies).map(r=>r.id).join(',')).join('|')||'empty';
  }
  function needsReview(p){
    const receipt=currentBoard().seen?.[p.id];
    if(!receipt)return true;
    if(receipt===true)return activitySignature(p)!=='empty';
    return receipt!==activitySignature(p);
  }
  function markRead(postId){
    const board=currentBoard(),post=board.posts.find(p=>p.id===postId);
    if(!post)return;
    board.seen=board.seen&&typeof board.seen==='object'?board.seen:{};
    board.seen[postId]=activitySignature(post);
    saved();
  }
  function likeTarget(postId,itemId){
    const post=currentBoard().posts.find(p=>p.id===postId);if(!post)return null;
    if(!itemId||itemId===postId)return post;
    for(const c of post.comments){
      if(c.id===itemId)return c;
      const reply=safeArray(c.replies).find(r=>r.id===itemId);
      if(reply)return reply;
    }
    return null;
  }
  function toggleLike(postId,itemId){
    const target=likeTarget(postId,itemId);if(!target)return;
    const liked=!!target.likedByMe;
    target.likes=Math.max(0,num(target.likes,0,99999999,0)+(liked?-1:1));
    target.likedByMe=!liked;saved();render();
  }
  // Actual time is the default. In RP mode only the newest completed
  // turn's fenced status blocks or API INFO_BOX parts supply dates/clocks.
  // Missing RP components are never guessed or merged with other turns.
  function realTimeStamp(){
    const d=new Date(),pad=n=>String(n).padStart(2,'0');
    return d.getFullYear()+'.'+pad(d.getMonth()+1)+'.'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  function statusBlocksOf(turn){
    const blocks=[];
    for(const part of safeArray(turn?.parts)){
      const value=String(part.text||'');
      if(part.kind==='INFO_BOX')blocks.push(value);
      // Match both unlabeled triple-fence blocks and fenced InfoBox blocks.
      const fences=/\x60{3,}[^\r\n]*\r?\n([\s\S]*?)\x60{3,}/g;
      for(const found of value.matchAll(fences))blocks.push(found[1]);
    }
    return blocks;
  }
  function rpStampFromBlock(value){
    const text=String(value||'');
    const pad=n=>String(n).padStart(2,'0');
    const dates=[];
    const dateRE=/(20\d{2})\s*[.\/-]\s*(1[0-2]|0?[1-9])\s*[.\/-]\s*(3[01]|[12]\d|0?[1-9])|(20\d{2})\s*년\s*(1[0-2]|0?[1-9])\s*월\s*(3[01]|[12]\d|0?[1-9])\s*일/g;
    for(const m of text.matchAll(dateRE)){
      const y=Number(m[1]||m[4]),month=Number(m[2]||m[5]),day=Number(m[3]||m[6]);
      if(new Date(y,month-1,day).getFullYear()===y&&new Date(y,month-1,day).getMonth()===month-1&&new Date(y,month-1,day).getDate()===day)dates.push({index:m.index,value:y+'.'+pad(month)+'.'+pad(day)});
    }
    const clocks=[];
    const ampmRE=/(오전|오후)\s*(1[0-2]|0?[1-9])\s*(?::|시)\s*(?:([0-5]?\d)\s*분?)?/g;
    const meridiemRanges=[];
    for(const m of text.matchAll(ampmRE)){
      const hour=Number(m[2]),minute=Number(m[3]||0),h=(hour%12)+(m[1]==='오후'?12:0);
      clocks.push({index:m.index,value:pad(h)+':'+pad(minute)});
      meridiemRanges.push([m.index,m.index+m[0].length]);
    }
    const clockRE=/(^|[^\d])([01]?\d|2[0-3])\s*(?::\s*([0-5]\d)|시\s*(?:([0-5]?\d)\s*분)?)/gm;
    for(const m of text.matchAll(clockRE)){
      const index=m.index+m[1].length;
      if(meridiemRanges.some(([a,b])=>index>=a&&index<b))continue;
      const h=Number(m[2]),minute=Number(m[3]||m[4]||0);
      clocks.push({index,value:pad(h)+':'+pad(minute)});
    }
    dates.sort((a,b)=>a.index-b.index);
    clocks.sort((a,b)=>a.index-b.index);
    const date=dates.at(-1)?.value||'',clock=clocks.at(-1)?.value||'';
    return [date,clock].filter(Boolean).join(' ');
  }
  function currentRpStamp(){
    if(data?.settings?.timeMode!=='rp')return realTimeStamp();
    const latest=observedTurns.at(-1);
    if(!latest)return '';
    const blocks=statusBlocksOf(latest);
    // If the latest status block has just a date or just a time, show only it.
    // Other turns and real-world time are not used in RP mode.
    for(let i=blocks.length-1;i>=0;i--){
      const stamp=rpStampFromBlock(blocks[i]);
      if(stamp)return stamp;
    }
    return '';
  }
  function rpTimeText(item){
    // Preserve legacy records exactly; an explicit empty timestamp is hidden.
    return item&&Object.prototype.hasOwnProperty.call(item,'rpTime')?String(item.rpTime||''):'RP 시간 미상';
  }
  function stats(c){return {views:c.views||0,likes:c.likes||0,comments:c.comments.reduce((n,x)=>n+1+x.replies.length,0)};}
  function sortedPosts(){const b=currentBoard();const posts=b.sort==='unread'?b.posts.filter(needsReview):b.posts;return [...posts].sort((a,z)=>b.sort==='recent'||b.sort==='unread'?z.time-a.time:((z.likes*5+stats(z).comments*3+z.views/20)/(1+Math.max(0,(now()-z.time)/86400000)*.1))-((a.likes*5+stats(a).comments*3+a.views/20)/(1+Math.max(0,(now()-a.time)/86400000)*.1)));}
  function renderStatus(){if(!panel)return;const el=panel.querySelector('#zab-status');if(el){const phase=autoStage==='waiting'?' · 생성 대기 중':autoStage==='verifying'?' · 최신 대화 확인 중':autoStage==='retry'?' · 조회 재시도 중':autoStage==='failed'?' · 조회 실패':'';el.textContent=busy?'게시글 생성 중…':now()<noticeUntil?notice:data?'자동 '+(data.settings.auto?'ON':'OFF')+' · '+turnCount+'/'+data.settings.turns+'턴'+(completedTurnTotal!==null?' · 전체 '+completedTurnTotal+'턴':(turnStatusError?' · 조회 오류: '+short(turnStatusError,85):turnLoading?' · 대화 수집 '+turnPages+'페이지 / '+turnLoadCount+'개':' · 대화 확인 중'))+(data.settings.auto&&!currentBoard().started?' · 첫 수동 생성 필요':data.settings.auto&&!profileReady()?' · 프로필 선택 필요':phase):'채팅방 연결 대기 중';}const autoButton=panel.querySelector('#zab-auto-toggle');
    if(autoButton){
      const isOn=!!data?.settings?.auto;
      autoButton.disabled=!data;
      autoButton.innerHTML=boardIcon(isOn?'play':'pause');
      autoButton.setAttribute('aria-label',isOn?'자동 갱신 끄기':'자동 갱신 켜기');
      autoButton.setAttribute('title',isOn?'자동 갱신 끄기':'자동 갱신 켜기');
      autoButton.setAttribute('aria-pressed',String(isOn));
      autoButton.dataset.enabled=isOn?'on':'off';
    }
    const count=launcher?.querySelector('.zab-unread');if(count)count.textContent=data?.boards?.[data.settings.selected]?.unread?'●':'';const cancel=panel.querySelector('#zab-cancel');if(cancel)cancel.hidden=!busy;}
  const communityColors={everytime:'#E65360',blind:'#B9282D',reddit:'#FF4500',x:'#505969',office:'#426A9A',neighborhood:'#04C75B',gallery:'#3654A5'};
  let themeMode='system';
  try{themeMode=String(GM_getValue('zab-theme-mode','system')||'system');}catch{}
  if(!['system','light','dark'].includes(themeMode))themeMode='system';
  window.addEventListener('focus',refreshGlobalPreferences);
  function resolvedTheme(){return themeMode==='system'?(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light'):themeMode;}
  function applyTheme(){
    const mode=resolvedTheme(),id=data?.settings?.selected,customColor=safeArray(data?.settings?.custom).find(c=>c.id===id)?.color;const accent=settingsOpen||!data?.settings?.communityConfirmed?'#505969':/^#[0-9a-f]{6}$/i.test(customColor||'')?customColor:id==='neighborhood'&&mode==='dark'?'#388A69':communityColors[id]||'#505969';
    if(panel){panel.dataset.theme=mode;panel.style.setProperty('--zab-accent',accent);}
    if(launcher){launcher.dataset.theme=mode;launcher.style.setProperty('--zab-accent',accent);}
  }
  function themeButtons(){return `<div class="zab-theme-switch" role="group" aria-label="화면 모드">${[['light','라이트 모드'],['dark','다크 모드'],['system','기기 설정']].map(([mode,label])=>btn('theme:'+mode,label,themeMode===mode?'is-active':'')).join('')}</div>`;}
  function timeModeButtons(){const current=data?.settings?.timeMode==='rp'?'rp':'real';return `<div class="zab-theme-switch zab-time-mode-switch" role="group" aria-label="날짜·시간 기준">${[['real','실제 시간'],['rp','RP 시간']].map(([mode,label])=>`<button type="button" data-act="time-mode:${mode}" class="${current===mode?'is-active':''}" aria-pressed="${current===mode?'true':'false'}">${label}</button>`).join('')}</div>`;}
  function settingsSegment(name,options,label){
    const selected=data?.settings?.[name];
    return '<div class="zab-theme-switch zab-setting-segment" role="group" aria-label="'+esc(label)+'">'+options.map(([value,caption])=>
      '<button type="button" data-act="setting-segment:'+esc(name)+':'+esc(value)+'" class="'+(selected===value?'is-active':'')+'" aria-pressed="'+(selected===value?'true':'false')+'">'+esc(caption)+'</button>'
    ).join('')+'</div>';
  }
  function onOffSegment(name,label){
    const active=data?.settings?.[name]!==false;
    return '<div class="zab-setting-toggle-row"><span class="zab-setting-toggle-label">'+esc(label)+'</span><div class="zab-sort-switch zab-setting-onoff" role="group" aria-label="'+esc(label)+'">'+
      [['on','ON'],['off','OFF']].map(([value,caption])=>
        '<button type="button" data-act="toggle-global:'+name+':'+value+'" class="'+((value==='on')===active?'is-active':'')+'" aria-pressed="'+((value==='on')===active?'true':'false')+'">'+caption+'</button>'
      ).join('')+'</div></div>';
  }
  const tabs=[['basic','기본 설정'],['community','프로필/커뮤니티'],['people','주민·닉네임'],['api','API 설정'],['data','데이터 관리']];
  function mount(){if(panel||!document.body)return;const style=document.createElement('style');style.textContent=`
  #zab-launch{position:fixed;right:13px;bottom:calc(95px + env(safe-area-inset-bottom,0px));border:1px solid #c4cad3;background:#fff;color:#222;border-radius:999px;padding:10px 14px;font:700 13px system-ui;box-shadow:0 4px 18px #0003;z-index:2147483600;touch-action:none}
  #zab-launch .zab-unread{color:#e34b57;margin-left:4px}
  #zab-panel{position:fixed;right:10px;bottom:calc(145px + env(safe-area-inset-bottom,0px));width:min(400px,calc(100vw - 20px));height:min(610px,75dvh);min-width:245px;min-height:240px;z-index:2147483601;border-radius:14px;background:#fff;color:#24272b;border:1px solid #d9dde2;box-shadow:0 12px 35px #0005;display:flex;flex-direction:column;font:13px/1.5 system-ui;overflow:hidden;box-sizing:border-box}
  #zab-panel[hidden]{display:none!important}#zab-panel *{box-sizing:border-box}#zab-panel button{font:600 12px system-ui;border:1px solid #d5d7df;background:#fff;color:#333;border-radius:7px;padding:7px 9px;cursor:pointer}#zab-panel button:disabled{opacity:.45;cursor:default}#zab-panel button.zab-primary{background:#d94d50;border-color:#d94d50;color:white}#zab-panel button.zab-danger{color:#c03943}#zab-panel button[hidden],#zab-panel [hidden]{display:none!important}
  #zab-panel .zab-author-badge{display:inline-block;margin-left:5px;padding:1px 5px;border-radius:5px;font-size:10px;font-weight:700;vertical-align:middle;white-space:nowrap}#zab-panel .zab-author-character{background:#eae7ff;color:#5943ad}#zab-panel .zab-author-me{background:#e4f1ff;color:#1564a1}#zab-panel .zab-author-character-name{color:#5943ad;font-weight:800}#zab-panel .zab-author-me-name{color:#1564a1;font-weight:800}
  #zab-panel .zab-head{padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;min-height:45px;cursor:grab;touch-action:none;user-select:none}#zab-panel .zab-head strong{font-size:15px;flex:1}#zab-panel .zab-head button{padding:4px 8px}
  #zab-panel .zab-content{overflow:auto;overscroll-behavior:contain;flex:1;padding:12px;min-height:0}#zab-panel .zab-status{font-size:11px;color:#6d737a;min-height:15px}#zab-panel .zab-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}#zab-panel .zab-flex{display:flex;justify-content:space-between;align-items:center;gap:8px}#zab-panel .zab-tabs{display:flex;gap:4px;overflow-x:auto;white-space:nowrap;padding:2px 0 8px}#zab-panel .zab-tabs button{flex-shrink:0}#zab-panel .zab-tabs .active{color:#d94d50;border-color:#d94d50;background:#fff4f4}#zab-panel .zab-card{border-bottom:1px solid #eee;padding:12px 2px;cursor:pointer}#zab-panel .zab-card:hover{background:#fcfcfc}#zab-panel .zab-card h3{margin:0 0 4px;font-size:14px;line-height:1.4}#zab-panel .zab-card .excerpt{color:#6b6f77;font-size:12px;margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}#zab-panel .zab-meta{font-size:11px;color:#81858c;overflow-wrap:anywhere}#zab-panel .zab-section{padding:10px 0;border-bottom:1px solid #eee}#zab-panel .zab-settings-section{border-bottom:none}#zab-panel .zab-section h4{margin:0 0 8px;font-size:13px}#zab-panel label{display:block;font-size:12px;font-weight:600;margin:9px 0 4px}#zab-panel input:not([type=checkbox]),#zab-panel select,#zab-panel textarea{width:100%;font:13px/1.5 system-ui;border:1px solid #ced2d9;border-radius:7px;padding:8px;color:#24272b;background:#fff}#zab-panel textarea{resize:vertical;min-height:55px}#zab-panel input[type=number]{max-width:115px}#zab-panel .zab-comment{padding:8px 0;border-bottom:1px solid #f0f0f0}#zab-panel .zab-reply{margin:6px 0 0 17px;border-left:2px solid #e5e5e5;padding-left:10px}#zab-panel .zab-note{font-size:11px;color:#7b8087}#zab-panel .zab-chip{display:inline-block;background:#f1f3f5;color:#696f78;padding:2px 6px;border-radius:6px;font-size:11px}#zab-panel .zab-resize{position:absolute;right:0;bottom:0;width:32px;height:32px;cursor:nwse-resize;touch-action:none;user-select:none;font:20px system-ui;color:#9ba1a9;text-align:right;padding:8px 4px 0 0;background:transparent}#zab-panel label.zab-profile-choice{display:flex;align-items:flex-start;gap:8px;padding:9px 6px;border:1px solid #eceef0;border-radius:7px;margin:5px 0;font-weight:400}#zab-panel .zab-profile-choice input{flex:0 0 auto;margin-top:4px}#zab-panel .zab-profile-choice span{display:block;min-width:0}#zab-panel .zab-profile-choice small{display:block;color:#848a90;font-size:11px;overflow-wrap:anywhere}#zab-panel .zab-divider{height:1px;background:#eee;margin:10px 0}#zab-panel .zab-toolbar{display:flex;gap:6px;margin:10px 0}#zab-panel .zab-toolbar button{flex:1;white-space:nowrap}#zab-panel .zab-footer{padding:6px 10px;border-top:1px solid #eee;display:flex;align-items:center;gap:8px;justify-content:space-between}#zab-panel p{white-space:pre-wrap;overflow-wrap:anywhere}

  /* v0.5 shared modern community UI: same cards and controls for every community */
  #zab-launch,#zab-panel{--zab-accent:#505969;--zab-bg:#F5F6F8;--zab-surface:#FFFFFF;--zab-surface2:#F2F4F7;--zab-text:#242832;--zab-muted:#727984;--zab-border:#E5E8EE;color-scheme:light}
  #zab-launch[data-theme="dark"],#zab-panel[data-theme="dark"]{--zab-bg:#15171B;--zab-surface:#22252B;--zab-surface2:#2B2F36;--zab-text:#EFF1F4;--zab-muted:#A6ACB5;--zab-border:#3A3E46;color-scheme:dark}
  #zab-launch{background:var(--zab-surface);color:var(--zab-text);border-color:var(--zab-border);border-radius:999px;box-shadow:0 8px 26px #0002}
  #zab-panel{background:var(--zab-bg);color:var(--zab-text);border:1px solid var(--zab-border);border-radius:17px;box-shadow:0 18px 44px #0005}
  #zab-panel .zab-head{background:var(--zab-surface);border-bottom:1px solid var(--zab-border);padding:12px 14px;min-height:52px}
  #zab-panel .zab-head strong{font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #zab-panel .zab-content{padding:14px;scrollbar-color:var(--zab-border) transparent}
  #zab-panel button{background:var(--zab-surface);color:var(--zab-text);border:1px solid var(--zab-border);border-radius:10px;padding:9px 11px;min-height:35px;transition:background .16s,border-color .16s}
  #zab-panel button.zab-primary{background:var(--zab-accent);border-color:var(--zab-accent);color:#fff}
  #zab-panel button.zab-danger{color:#D95360}
  #zab-panel button:focus-visible,#zab-panel input:focus-visible,#zab-panel textarea:focus-visible,#zab-panel select:focus-visible{outline:2px solid var(--zab-accent);outline-offset:2px}
  #zab-panel .zab-tabs{gap:7px;padding-bottom:11px}
  #zab-panel .zab-tabs button{border-radius:999px;padding:8px 12px}
  #zab-panel .zab-tabs button.active{color:#fff;background:var(--zab-accent);border-color:var(--zab-accent)}
  #zab-panel .zab-card{border:1px solid var(--zab-border);background:var(--zab-surface);border-radius:13px;padding:14px;margin:10px 0;box-shadow:0 2px 8px #00000008}
  #zab-panel .zab-card:hover{background:var(--zab-surface2);border-color:var(--zab-accent)}
  #zab-panel .zab-card h3{font-size:14px;font-weight:750;line-height:1.45;margin-bottom:7px}
  #zab-panel .zab-card .excerpt{color:var(--zab-muted);font-size:12px;line-height:1.6}
  #zab-panel .zab-meta,#zab-panel .zab-note{color:var(--zab-muted)}
  #zab-panel .zab-board-hero{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--zab-surface);border:1px solid var(--zab-border);border-radius:13px;padding:14px;margin-bottom:12px}
  #zab-panel .zab-board-name{font-size:17px;font-weight:800;overflow-wrap:anywhere}
  #zab-panel .zab-board-hero .zab-note{margin-top:4px}
  #zab-panel .zab-list-heading{margin:13px 0 6px;gap:6px;flex-wrap:wrap}
  #zab-panel .zab-list-heading button{font-size:11px;padding:7px 9px}
  #zab-panel .zab-section{border-color:var(--zab-border)}
  #zab-panel .zab-settings-section{border:1px solid var(--zab-border);background:var(--zab-surface);border-radius:13px;padding:15px;margin-top:7px}
  #zab-panel .zab-settings-topline{display:flex;align-items:center;gap:12px;margin:3px 0 13px}
  #zab-panel .zab-settings-top-title{font-size:15px;font-weight:700;color:var(--zab-text)}
  #zab-panel .zab-settings-section h4{font-size:14px}
  #zab-panel .zab-profile-section-heading{margin:0 0 9px;gap:10px}
  #zab-panel .zab-profile-section-heading strong{font-size:14px;line-height:1.4}
  #zab-panel .zab-profile-section-heading button{padding:5px 9px;min-height:30px}
  #zab-panel .zab-profile-load-actions{display:flex;align-items:center;justify-content:flex-start;margin:0 0 4px}
  #zab-panel .zab-profile-load-actions button{margin:0}
  #zab-panel .zab-profile-status-lines{margin:4px 0 10px;line-height:1.5}
  #zab-panel .zab-profile-status-lines span{display:block}
  #zab-panel .zab-settings-section h4.zab-main-settings-heading{font-size:15px;font-weight:700;line-height:1.4;margin:4px 0 12px}
  #zab-panel .zab-settings-section .zab-divider:has(+ .zab-main-settings-heading){margin:20px 0 16px}
  #zab-panel .zab-setting-segment{gap:4px}
  #zab-panel .zab-setting-segment button{white-space:normal;overflow-wrap:anywhere;text-align:center;min-width:0;flex:1 1 auto}
  /* Container-based layout follows the resizable panel, not the viewport. */
  #zab-panel .zab-community-grid-wrap{container-type:inline-size;width:100%;margin:7px 0 11px}
  #zab-panel .zab-community-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
  #zab-panel .zab-community-grid-button{min-width:0;min-height:44px;padding:7px 3px;border:1px solid var(--zab-border);border-radius:9px;background:var(--zab-surface);color:var(--zab-muted);font-size:10px;line-height:1.35;overflow-wrap:anywhere;text-align:center}
  #zab-panel .zab-community-grid-button.is-active{background:var(--zab-surface2);border-color:var(--zab-accent);color:var(--zab-text);font-weight:750}
  #zab-panel .zab-community-grid-button:focus-visible{outline:2px solid var(--zab-accent);outline-offset:1px}
  @container (max-width:319px){#zab-panel .zab-community-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @container (max-width:239px){#zab-panel .zab-community-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}

  #zab-panel .zab-divider{background:var(--zab-border);margin:14px 0}
  #zab-panel input:not([type=checkbox]),#zab-panel select,#zab-panel textarea{background:var(--zab-surface);color:var(--zab-text);border-color:var(--zab-border);border-radius:10px;min-height:39px;padding:10px}
  #zab-panel input::placeholder,#zab-panel textarea::placeholder{color:var(--zab-muted);opacity:.8}
  #zab-panel label.zab-profile-choice{background:var(--zab-surface2);border-color:var(--zab-border);border-radius:10px;padding:10px}
  #zab-panel .zab-profile-choice small{color:var(--zab-muted)}
  #zab-panel .zab-comment{padding:12px 0;border-color:var(--zab-border)}
  #zab-panel .zab-section > .zab-comment:last-child{border-bottom:0}
  #zab-panel .zab-reply{border-left-color:var(--zab-accent);margin-left:12px;padding-left:12px}
  #zab-panel .zab-chip{background:var(--zab-surface2);color:var(--zab-accent);border-radius:6px;font-weight:700}
  #zab-panel .zab-footer{background:var(--zab-surface);border-color:var(--zab-border);padding:5px 10px;min-height:29px;gap:6px}
  #zab-panel .zab-status{color:var(--zab-muted)}
  #zab-panel .zab-footer-status{display:flex;align-items:center;gap:5px;flex:1;min-width:0}
  #zab-panel .zab-footer-status .zab-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #zab-panel button#zab-auto-toggle{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;min-height:18px;padding:1px;border:0;border-radius:4px;background:transparent;color:var(--zab-muted);box-shadow:none;cursor:pointer;touch-action:manipulation}
  #zab-panel button#zab-auto-toggle .zab-ui-icon{width:15px;height:15px}
  #zab-panel button#zab-auto-toggle:hover{background:var(--zab-surface2)}
  #zab-panel button#zab-auto-toggle:focus-visible{outline:2px solid var(--zab-accent);outline-offset:1px}
  #zab-panel button#zab-auto-toggle:disabled{opacity:.45;cursor:default}
  #zab-panel .zab-footer #zab-cancel{padding:3px 7px;min-height:24px;flex:0 0 auto}
  #zab-panel .zab-resize{color:var(--zab-muted)}
  #zab-panel .zab-toolbar{gap:8px;flex-wrap:wrap}
  #zab-panel .zab-toolbar button{min-width:0;white-space:normal}
  #zab-panel[data-theme="dark"] .zab-author-character{background:#393352;color:#C4B5FD}
  #zab-panel[data-theme="dark"] .zab-author-me{background:#233B50;color:#A6D5FF}
  #zab-panel[data-theme="dark"] .zab-author-character-name{color:#C4B5FD}
  #zab-panel[data-theme="dark"] .zab-author-me-name{color:#A6D5FF}
  @media(max-width:380px){#zab-panel .zab-content{padding:10px}#zab-panel .zab-list-heading{align-items:flex-start}#zab-panel .zab-head{padding:9px 10px}#zab-panel .zab-tabs button{padding:8px 9px}}

  /* v0.5.2 controls: clear profile actions, compact reactions, community-matched badges */
  #zab-panel .zab-profile-choose-header{display:flex;flex-direction:column;align-items:flex-start;gap:7px;margin:14px 0 9px}
  #zab-panel .zab-profile-choose-header label{margin:0;line-height:1.45;overflow-wrap:anywhere}
  #zab-panel .zab-profile-actions{display:flex;flex-direction:row;align-items:center;gap:7px;width:100%;flex-wrap:nowrap}
  #zab-panel .zab-profile-actions button{font-size:12px;min-height:32px;flex:0 1 auto;padding:6px 11px;white-space:nowrap}
  #zab-panel button.zab-setup-card{width:100%;display:flex;gap:11px;align-items:center;text-align:left;padding:15px;margin:0 0 14px;border:1px solid var(--zab-accent);border-radius:13px;background:var(--zab-surface);color:var(--zab-text);box-shadow:0 2px 9px #00000009}
  #zab-panel .zab-setup-symbol{display:flex;align-items:center;justify-content:center;min-width:39px;height:39px;padding:0 6px;border-radius:11px;background:var(--zab-accent);color:#fff;font-size:13px;font-weight:800}
  #zab-panel .zab-setup-body{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px}
  #zab-panel .zab-setup-body strong{font-size:13px}
  #zab-panel .zab-setup-body>span{font-size:12px;line-height:1.55;color:var(--zab-muted);overflow-wrap:anywhere}
  #zab-panel .zab-setup-chevron{font-size:24px;line-height:1;color:var(--zab-muted)}
  #zab-panel button.zab-my-button{flex-shrink:0;min-width:43px;font-weight:800;letter-spacing:.1px;border-color:var(--zab-border);color:var(--zab-accent)}
  #zab-panel .zab-engagement{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:12px}
  #zab-panel .zab-comment-actions{display:flex;align-items:center;gap:14px;margin:5px 0 4px}
  #zab-panel button.zab-like-inline{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;box-shadow:none;min-height:28px;padding:2px 3px;color:var(--zab-muted);font-size:12px;font-weight:600}
  #zab-panel button.zab-like-inline span:first-child{font-size:19px;line-height:1}
  #zab-panel button.zab-like-inline.is-liked{color:var(--zab-accent)}
  #zab-panel button.zab-like-inline:hover{background:var(--zab-surface2)}
  #zab-panel button.zab-text-action{border:0;background:transparent;padding:3px 5px;min-height:28px;color:var(--zab-muted);font-size:12px}
  #zab-panel .zab-translate-switch{display:flex;align-items:center;gap:2px;justify-content:flex-end;margin:7px 0 12px}
  #zab-panel .zab-translate-switch button{border:0;background:transparent;min-height:28px;padding:5px 9px;color:var(--zab-muted);border-radius:8px;font-size:12px;font-weight:600}
  #zab-panel .zab-translate-switch button.is-active{color:var(--zab-text);background:color-mix(in srgb,var(--zab-accent) 10%,var(--zab-surface))}
  #zab-panel .zab-author-me-name,#zab-panel .zab-author-character-name,#zab-panel[data-theme="dark"] .zab-author-me-name,#zab-panel[data-theme="dark"] .zab-author-character-name{color:var(--zab-text);font-weight:750}
  #zab-panel .zab-author-me,#zab-panel[data-theme="dark"] .zab-author-me{background:var(--zab-accent);color:#fff}
  #zab-panel .zab-author-character,#zab-panel[data-theme="dark"] .zab-author-character{background:color-mix(in srgb,var(--zab-accent) 15%,var(--zab-surface));color:var(--zab-text);border:1px solid color-mix(in srgb,var(--zab-accent) 36%,var(--zab-border))}
  @media(max-width:380px){#zab-panel .zab-profile-actions button{padding:6px 9px;font-size:11px}#zab-panel button.zab-setup-card{padding:11px}#zab-panel .zab-setup-symbol{min-width:35px;height:35px}}

  /* v0.5.3: true white light surface, deeper dark theme, consistent badges and continuous reply thread */
  #zab-launch,#zab-panel{--zab-bg:#FFFFFF;--zab-surface:#FFFFFF;--zab-surface2:#F7F7F8;--zab-text:#202124;--zab-muted:#737780;--zab-border:#E9EAED}
  #zab-launch[data-theme="dark"],#zab-panel[data-theme="dark"]{--zab-bg:#0C0C0E;--zab-surface:#141416;--zab-surface2:#202023;--zab-text:#F2F2F4;--zab-muted:#9B9CA3;--zab-border:#2A2A2F}
  #zab-panel .zab-content{background:var(--zab-bg)}
  #zab-panel .zab-head,#zab-panel .zab-footer{background:var(--zab-surface)}
  #zab-panel .zab-translate-switch{justify-content:flex-start}
  #zab-panel .zab-replies{border-left:2px solid var(--zab-accent);margin:8px 0 0 16px;padding:0 0 0 12px}
  #zab-panel .zab-replies>.zab-reply{border:0!important;margin:0 0 12px 0;padding:0;min-width:0}
  #zab-panel .zab-replies>.zab-reply:last-child{margin-bottom:0}
  #zab-panel .zab-author-me,#zab-panel .zab-author-character,#zab-panel[data-theme="dark"] .zab-author-me,#zab-panel[data-theme="dark"] .zab-author-character{color:var(--zab-text);border:0;padding:2px 6px}
  #zab-panel .zab-author-me,#zab-panel[data-theme="dark"] .zab-author-me{background:color-mix(in srgb,var(--zab-accent) 40%,var(--zab-surface))}
  #zab-panel .zab-author-character,#zab-panel[data-theme="dark"] .zab-author-character{background:color-mix(in srgb,var(--zab-accent) 25%,var(--zab-surface))}
  #zab-panel .zab-author-me-name,#zab-panel .zab-author-character-name{color:var(--zab-text)}

  /* v0.5.4 theme switch shares the low-contrast original/translation design */
  #zab-panel .zab-theme-switch{display:flex;align-items:center;justify-content:flex-start;gap:3px;flex-wrap:wrap;margin:5px 0 12px}
  #zab-panel .zab-theme-switch button{border:0;background:transparent;color:var(--zab-muted);border-radius:8px;padding:6px 10px;min-height:30px;font-size:12px;font-weight:600;white-space:nowrap}
  #zab-panel .zab-theme-switch button.is-active{background:var(--zab-surface2);color:var(--zab-text)}
  #zab-panel .zab-theme-switch button:focus-visible{outline:2px solid var(--zab-accent);outline-offset:2px}

  /* v0.5.5 custom community HEX input alongside color picker */
  #zab-panel .zab-color-control{display:flex;align-items:center;gap:10px}
  #zab-panel .zab-color-control input[data-custom-hex="yes"]{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #zab-panel .zab-color-control input[type=color]{flex:0 0 47px;width:47px!important;height:39px;min-height:39px;padding:4px;cursor:pointer;border-radius:9px}

  /* v0.5.7: stronger title/body weight contrast; compact sorting tabs */
  #zab-panel .zab-card h3{font-weight:800}
  #zab-panel .zab-card .excerpt{font-weight:400}
  #zab-panel[data-theme="dark"] .zab-card .excerpt{color:#B5B6BE}
  #zab-panel .zab-section>h2{font-weight:800}
  #zab-panel .zab-section>h2+p{font-weight:400}
  #zab-panel .zab-sort-switch{display:flex;align-items:center;gap:2px;flex-wrap:nowrap}
  #zab-panel .zab-list-heading .zab-sort-switch button{border:0;background:transparent;box-shadow:none;min-height:28px;padding:5px 9px;color:var(--zab-muted);border-radius:8px;font-size:12px;font-weight:600;white-space:nowrap}
  #zab-panel .zab-list-heading .zab-sort-switch button.is-active{color:var(--zab-text);background:var(--zab-surface2)}
  #zab-panel .zab-list-heading .zab-sort-switch button:focus-visible{outline:2px solid var(--zab-accent);outline-offset:2px}



  /* v0.8.2: label and ON/OFF control on the same line, even in a narrow popup. */
  #zab-panel .zab-setting-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;margin:8px 0}
  #zab-panel .zab-setting-toggle-label{font-size:12px;font-weight:600;line-height:1.4;min-width:0;flex:1 1 auto;overflow-wrap:keep-all}
  #zab-panel .zab-setting-toggle-row .zab-setting-onoff{flex:0 0 auto;margin:0}
  #zab-panel .zab-setting-toggle-row .zab-setting-onoff button{min-width:42px;padding:6px 8px}

  /* v0.8.1: compact segmented ON/OFF toggles matching list sort controls. */
  #zab-panel .zab-setting-onoff{display:inline-flex;gap:3px;margin:4px 0 9px;padding:3px;border-radius:10px;background:var(--zab-surface2)}
  #zab-panel .zab-setting-onoff button{min-width:63px;min-height:32px;padding:6px 13px;border:0;border-radius:8px;background:transparent;color:var(--zab-muted);box-shadow:none;font-size:12px;font-weight:600}
  #zab-panel .zab-setting-onoff button.is-active{background:color-mix(in srgb,var(--zab-accent) 10%,var(--zab-surface));color:var(--zab-text);font-weight:750}
  #zab-panel .zab-setting-onoff button:focus-visible{outline:2px solid var(--zab-accent);outline-offset:1px}

  /* v0.7.0: participation dot and subtle original-author reply highlights. */
  #zab-panel .zab-card{position:relative}
  #zab-panel .zab-participation-dot{position:absolute;right:14px;top:15px;width:8px;height:8px;border-radius:50%;background:var(--zab-accent);pointer-events:none}
  #zab-panel .zab-card:has(.zab-participation-dot) h3{padding-right:17px}
  #zab-panel .zab-comment.zab-post-author-reply,#zab-panel .zab-reply.zab-post-author-reply{background:color-mix(in srgb,var(--zab-accent) 9%,var(--zab-surface));border-radius:9px}
  #zab-panel .zab-comment.zab-post-author-reply{padding:12px 10px}
  #zab-panel .zab-reply.zab-post-author-reply{padding:9px 10px}
  #zab-panel[data-theme="dark"] .zab-comment.zab-post-author-reply,#zab-panel[data-theme="dark"] .zab-reply.zab-post-author-reply{background:color-mix(in srgb,var(--zab-accent) 17%,var(--zab-surface))}

  /* v0.5.8: subtle resize grip (keep touch target), right-aligned comment actions */
  #zab-panel .zab-resize{width:30px;height:30px;font-size:13px;line-height:1;display:flex;align-items:flex-end;justify-content:flex-end;padding:0 3px 3px 0;color:var(--zab-muted);opacity:.24;touch-action:none}
  #zab-panel[data-theme="dark"] .zab-resize{color:var(--zab-muted);opacity:.20}
  #zab-panel .zab-comment-submit{display:flex;justify-content:flex-end;align-items:center;margin:8px 0 0}
  #zab-panel .zab-reply-submit{display:flex;justify-content:flex-end;align-items:center;gap:7px;margin:8px 0 5px}
  #zab-panel .zab-comment-submit button,#zab-panel .zab-reply-submit button{flex:0 0 auto}

  /* v0.5.10: light active-sort tint, pencil write button, subtle card metrics */
  #zab-panel .zab-list-heading .zab-sort-switch button.is-active{background:color-mix(in srgb,var(--zab-accent) 10%,var(--zab-surface));color:var(--zab-text)}
  #zab-panel .zab-toolbar button.zab-write-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--zab-accent);border-color:var(--zab-accent);color:#fff}
  #zab-panel .zab-ui-icon{flex:0 0 auto;display:inline-block;vertical-align:middle;width:15px;height:15px}
  #zab-panel .zab-write-button .zab-ui-icon{width:15px;height:15px}
  #zab-panel .zab-head button[data-act="settings"] .zab-ui-icon{width:20px;height:20px;display:block;margin:auto}
  #zab-panel .zab-card-metrics{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:4px}
  #zab-panel .zab-card-metric{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:var(--zab-muted);font-size:11px;line-height:1.5}
  #zab-panel .zab-card-metric.is-liked{color:var(--zab-accent)}

  /* v0.5.12: flexible, image-inspired compose card with bottom-right actions */
  #zab-panel #zab-main[data-view="write"]{display:block;height:100%;min-height:0;overflow-y:auto}
  #zab-panel .zab-write-screen{display:flex;flex-direction:column;min-height:0;gap:11px}
  #zab-panel .zab-write-card{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;padding:15px;border:1px solid var(--zab-border);border-radius:14px;background:var(--zab-surface)}
  #zab-panel .zab-write-card h3{font-size:16px;font-weight:750;margin:0 0 18px}
  #zab-panel .zab-write-card label{font-size:12px;font-weight:700;margin:10px 0 6px}
  #zab-panel .zab-write-card .zab-required{color:#D95360;font-weight:800}
  #zab-panel .zab-write-card input#zab-own-title{flex:0 0 auto}
  #zab-panel .zab-write-card textarea#zab-own-body{display:block;flex:0 0 auto;min-height:112px;height:112px;max-height:none;resize:none;box-sizing:border-box}
  #zab-panel .zab-write-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex:0 0 auto;padding:0 2px 4px}
  #zab-panel .zab-write-actions button{flex:0 0 auto;min-height:35px;padding:8px 13px}
  #zab-panel .zab-write-actions button[data-act="back"]{background:var(--zab-surface2);border-color:transparent}
  #zab-panel .zab-write-actions button[data-act="publish"]{background:var(--zab-accent);border-color:var(--zab-accent);color:#fff}
  @media(max-height:520px){#zab-panel .zab-write-card h3{margin-bottom:8px}}
  `;document.documentElement.appendChild(style);launcher=document.createElement('button');launcher.type='button';launcher.id='zab-launch';launcher.dataset.jhDockIcon='📋';launcher.innerHTML='익명 게시판 <span class="zab-unread"></span>';panel=document.createElement('section');panel.id='zab-panel';panel.hidden=true;panel.innerHTML='<div class="zab-head" id="zab-drag"><strong id="zab-community-title">익명 게시판</strong><button data-act="settings" aria-label="설정" title="설정">'+boardIcon('sliders')+'</button><button data-act="close" aria-label="닫기" title="닫기">×</button></div><div class="zab-content" id="zab-main"></div><div class="zab-footer"><div class="zab-footer-status"><button type="button" id="zab-auto-toggle" data-act="footer-auto-toggle" aria-label="자동 갱신 끄기" aria-pressed="true" title="자동 갱신 끄기"></button><span class="zab-status" id="zab-status">채팅방 연결 대기 중</span></div><button id="zab-cancel" data-act="cancel" hidden>생성 취소</button></div><div class="zab-resize" id="zab-resize">◢</div>';
    document.body.append(launcher,panel);launcher.addEventListener('click',()=>{if(launcher.dataset.dragging==='yes'){launcher.dataset.dragging='';return;}panel.hidden=!panel.hidden;if(!panel.hidden){const b=currentBoard();b.unread=0;saved();render();applySize();}});
    try{window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',applyTheme);}catch{}
    panel.addEventListener('click',onClick);panel.addEventListener('change',onChange);panel.addEventListener('input',onInput);installDrag(launcher,launcher,'launch');installDrag(panel.querySelector('#zab-drag'),panel,'panel');installResize(panel.querySelector('#zab-resize'));applySize();render();}
  function applySize(){if(!panel)return;const vw=innerWidth,vh=innerHeight;if(uiPos.w)panel.style.width=Math.min(vw-8,Math.max(Math.min(245,vw-8),uiPos.w))+'px';if(uiPos.h)panel.style.height=Math.min(vh-8,Math.max(Math.min(240,vh-8),uiPos.h))+'px';if(uiPos.x!=null){const w=panel.getBoundingClientRect().width;panel.style.left=Math.max(4,Math.min(uiPos.x,vw-w-4))+'px';panel.style.right='auto';}if(uiPos.y!=null){const h=panel.getBoundingClientRect().height;panel.style.top=Math.max(4,Math.min(uiPos.y,vh-h-4))+'px';panel.style.bottom='auto';}if(uiPos.launch){const r=launcher.getBoundingClientRect();launcher.style.left=Math.max(4,Math.min(uiPos.launch.x,vw-r.width-4))+'px';launcher.style.top=Math.max(4,Math.min(uiPos.launch.y,vh-r.height-4))+'px';launcher.style.right='auto';launcher.style.bottom='auto';}}
  function installDrag(handle,el,type){handle.addEventListener('pointerdown',e=>{if(e.button!==0||(type!=='launch'&&e.target.closest('button,input,select,textarea')))return;const r=el.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;let moved=false;const move=v=>{if(v.pointerId!==e.pointerId)return;const dx=v.clientX-sx,dy=v.clientY-sy;if(!moved&&Math.hypot(dx,dy)<6)return;moved=true;v.preventDefault();el.style.left=Math.max(4,Math.min(r.left+dx,innerWidth-r.width-4))+'px';el.style.top=Math.max(4,Math.min(r.top+dy,innerHeight-r.height-4))+'px';el.style.bottom='auto';el.style.right='auto';};const end=v=>{if(v.pointerId!==e.pointerId)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);if(moved){const a=el.getBoundingClientRect();if(type==='launch'){uiPos.launch={x:a.left,y:a.top};launcher.dataset.dragging='yes';setTimeout(()=>launcher.dataset.dragging='',500);}else{uiPos.x=a.left;uiPos.y=a.top;}localStorage.setItem(persistedUIKey,JSON.stringify(uiPos));}};window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);});}
  function installResize(handle){handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();const r=panel.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;panel.style.left=r.left+'px';panel.style.top=r.top+'px';panel.style.right='auto';panel.style.bottom='auto';const move=v=>{if(v.pointerId!==e.pointerId)return;v.preventDefault();uiPos.w=Math.max(Math.min(245,innerWidth-8),Math.min(r.width+v.clientX-sx,innerWidth-r.left-4));uiPos.h=Math.max(Math.min(240,innerHeight-8),Math.min(r.height+v.clientY-sy,innerHeight-r.top-4));panel.style.width=uiPos.w+'px';panel.style.height=uiPos.h+'px';};const end=v=>{if(v.pointerId!==e.pointerId)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);uiPos.x=r.left;uiPos.y=r.top;localStorage.setItem(persistedUIKey,JSON.stringify(uiPos));};window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);});}
  function btn(action,text,klass='',extra=''){return `<button type="button" data-act="${esc(action)}" class="${klass}" ${extra}>${esc(text)}</button>`;}
  function inp(name,val,type='text',more=''){return `<input data-setting="${esc(name)}" type="${type}" value="${esc(val)}" ${more}>`;}
  function ta(name,val,rows=3){return `<textarea data-setting="${esc(name)}" rows="${rows}">${esc(val)}</textarea>`;}
  function selection(name,current,opts){return `<select data-setting="${esc(name)}">${opts.map(([id,label])=>`<option value="${esc(id)}" ${id===current?'selected':''}>${esc(label)}</option>`).join('')}</select>`;}
  function setupGuide(){
    if(!data||profileReady()&&data.settings.communityConfirmed)return '';
    return `<button type="button" class="zab-setup-card" data-act="setup-profile" title="프로필/커뮤니티 설정 열기" aria-label="프로필 불러오기와 커뮤니티 설정 열기"><span class="zab-setup-symbol" aria-hidden="true">My</span><span class="zab-setup-body"><strong>게시판 시작 설정</strong><span>My 버튼을 눌러 프로필 불러오기 + 커뮤니티 설정하기</span></span><span class="zab-setup-chevron" aria-hidden="true">›</span></button>`;
  }
  function resizeOwnBody(el){
    if(!el||el.id!=='zab-own-body')return;
    el.style.height='auto';
    const area=panel?.querySelector('#zab-main');
    const available=area?.clientHeight||window.innerHeight;
    const max=Math.max(112,Math.floor(available*.64));
    const desired=Math.max(112,el.scrollHeight);
    el.style.height=Math.min(desired,max)+'px';
    el.style.overflowY=desired>max?'auto':'hidden';
  }
  function render(){if(!panel)return;applyTheme();renderStatus();const title=panel.querySelector('#zab-community-title');if(title)title.textContent=data?.settings?.communityConfirmed?currentCommunity().name:'익명 게시판';const node=panel.querySelector('#zab-main');if(!node)return;if(!data){node.innerHTML='<p>제타 채팅방을 열고 메시지가 로드되면 연결됩니다.</p>';return;}node.dataset.view=!settingsOpen&&postsView==='write'?'write':'other';node.innerHTML=settingsOpen?renderSettings():postsView==='detail'?renderDetail():postsView==='write'?renderWrite():renderList();if(node.dataset.view==='write')resizeOwnBody(node.querySelector('#zab-own-body'));}
  // Each Everytime post has its own numbering. The author is '익명'
  // on the post and '글쓴이' in replies, with no board-wide number registry.
  function everytimeIdentity(item){
    if(item?.source==='user')return 'user';
    if(item?.characterProfileId)return 'character:'+item.characterProfileId;
    if(item?.residentId)return 'resident:'+item.residentId;
    return 'local:'+item.id;
  }
  function everytimeNames(post){
    const map=new Map(),identities=new Map();
    let next=1;
    const author=everytimeIdentity(post);
    map.set(post.id,'익명');
    const apply=item=>{
      const identity=everytimeIdentity(item);
      if(identity===author){map.set(item.id,'글쓴이');return;}
      if(!identities.has(identity))identities.set(identity,'익명'+next++);
      map.set(item.id,identities.get(identity));
    };
    for(const c of safeArray(post.comments)){
      apply(c);
      for(const reply of safeArray(c.replies))apply(reply);
    }
    return map;
  }
  function communityAuthorName(item,post){
    if(item?.nicknameGuideKey)return authorName(item);
    if(currentCommunity().id==='gallery')return authorName({...item,nick:galleryDisplayNick(item)});
    if(currentCommunity().id!=='everytime'||!post)return authorName(item);
    return authorName({...item,nick:everytimeNames(post).get(item.id)||'익명'});
  }
  function boardIcon(name){
    const paths={
      sliders:'<path d="M3 6h6m4 0h8M11 3v6M3 12h12m4 0h2M17 9v6M3 18h3m4 0h11M8 15v6"/>',
      pen:'<path d="M12 19h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/>',
      eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
      heart:'<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"/>',
      play:'<path d="m8 5 11 7-11 7V5Z"/>',
      pause:'<path d="M8 5v14M16 5v14"/>',
      message:'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>'
    };
    return '<svg class="zab-ui-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||'')+'</svg>';
  }
  function boardListMetrics(p){
    return '<div class="zab-card-metrics zab-meta">'+
      '<span class="zab-card-metric">'+boardIcon('eye')+'<span>조회 '+p.views.toLocaleString()+'</span></span>'+
      '<span class="zab-card-metric">'+boardIcon('message')+'<span>댓글 '+stats(p).comments+'</span></span>'+
      '<span class="zab-card-metric'+(p.likedByMe?' is-liked':'')+'">'+boardIcon('heart')+'<span>'+p.likes.toLocaleString()+'</span></span>'+
    '</div>';
  }
  // Participation is based on source/profile identity, never nickname text.
  function isUserOrCharacterAuthor(item){
    return !!item&&(item.source==='user'||!!item.characterProfileId);
  }
  function hasUserOrCharacterParticipation(post){
    if(isUserOrCharacterAuthor(post))return true;
    for(const comment of safeArray(post?.comments)){
      if(isUserOrCharacterAuthor(comment))return true;
      if(safeArray(comment.replies).some(isUserOrCharacterAuthor))return true;
    }
    return false;
  }
  function postAuthorIdentity(item){
    if(!item)return '';
    if(item.source==='user')return 'user';
    if(item.characterProfileId)return 'character:'+item.characterProfileId;
    if(item.residentId)return 'resident:'+item.residentId;
    return item.id?'item:'+item.id:'';
  }
  function isPostAuthorReply(item,post){
    const original=postAuthorIdentity(post);
    return !!original&&original===postAuthorIdentity(item);
  }
  function renderList(){const b=currentBoard(),com=currentCommunity();return `${setupGuide()}<div class="zab-board-hero"><div><strong class="zab-board-name">${esc(communityBoardTitle())}</strong><div class="zab-note">${esc(short(com.id==='gallery'?(data.settings.galleryDescription||com.desc):com.desc,95))}</div></div><button class="zab-my-button" data-act="profiles-panel" aria-label="My: 프로필/커뮤니티 설정" title="My: 프로필/커뮤니티 설정">My</button></div>
    <div class="zab-toolbar"><button type="button" data-act="write" class="zab-write-button zab-primary">${boardIcon('pen')}<span>글쓰기</span></button>${btn('generate','수동 생성')}${btn('regen','다시 생성','',!b.lastBatch?'disabled':'')}</div>
    <div class="zab-flex zab-list-heading"><b>전체 게시글 ${b.posts.length}</b><div class="zab-sort-switch" role="group" aria-label="게시글 정렬">${btn('sort-recent','최신순',b.sort==='recent'?'is-active':'')}${btn('sort-popular','인기순',b.sort==='popular'?'is-active':'')}${btn('sort-unread','미확인',b.sort==='unread'?'is-active':'')}</div></div>
    ${translationToggle()}${!b.posts.length?'<div class="zab-section" style="text-align:center;padding:40px 10px;color:#888">게시글이 없어요.<br>수동 생성 버튼으로 첫 게시글을 만들어 보세요.</div>':b.sort==='unread'&&!sortedPosts().length?'<div class="zab-section" style="text-align:center;padding:40px 10px;color:#888">미확인 게시글이 없어요.</div>':sortedPosts().map(p=>`<div class="zab-card" data-open="${esc(p.id)}">${data.settings.showParticipationDot!==false&&hasUserOrCharacterParticipation(p)?'<span class="zab-participation-dot" aria-label="유저 또는 RP 캐릭터 참여" title="유저 또는 RP 캐릭터 참여"></span>':''}<h3>${needsReview(p)?'<span class="zab-chip">NEW</span> ':''}${esc(translatedText(p,'title'))}</h3><div class="excerpt">${esc(short(translatedText(p,'body'),150))}</div><div class="zab-meta">${communityAuthorName(p,p)}${rpTimeText(p)?' · '+esc(rpTimeText(p)):''}</div>${boardListMetrics(p)}</div>`).join('')}`;}
  function likeControl(postId,item){
    return `<button type="button" class="zab-like-inline${item.likedByMe?' is-liked':''}" data-act="like:${esc(postId)}:${esc(item.id)}" aria-label="좋아요 ${num(item.likes,0,99999999,0)}개" aria-pressed="${item.likedByMe?'true':'false'}"><span aria-hidden="true">${item.likedByMe?'♥':'♡'}</span><span>${num(item.likes,0,99999999,0)}</span></button>`;
  }
  function renderDetail(){const p=currentBoard().posts.find(x=>x.id===detailId);if(!p){postsView='list';return renderList();}const comments=p.comments.map(c=>`<div class="zab-comment${data.settings.highlightPostAuthor!==false&&isPostAuthorReply(c,p)?' zab-post-author-reply':''}"><div><b>${communityAuthorName(c,p)}</b> ${rpTimeText(c)?'<span class="zab-meta">'+esc(rpTimeText(c))+'</span>':''}</div><p style="margin:4px 0">${esc(translatedText(c,'text'))}</p><div class="zab-comment-actions">${likeControl(p.id,c)}${btn('reply:'+c.id,'답글','zab-text-action',`data-post="${esc(p.id)}"`)}</div><div class="zab-inline-reply" data-reply-parent="${esc(c.id)}"></div>${c.replies.length?`<div class="zab-replies">${c.replies.map(r=>`<div class="zab-reply${data.settings.highlightPostAuthor!==false&&isPostAuthorReply(r,p)?' zab-post-author-reply':''}"><b>${communityAuthorName(r,p)}</b> ${rpTimeText(r)?'<span class="zab-meta">'+esc(rpTimeText(r))+'</span>':''}<p style="margin:4px 0">${esc(translatedText(r,'text'))}</p><div class="zab-comment-actions">${likeControl(p.id,r)}${btn('reply:'+c.id,'답글','zab-text-action',`data-post="${esc(p.id)}"`)}</div></div>`).join('')}</div>`:''} </div>`).join('');return `<div class="zab-flex">${btn('back','← 목록')} <div>${btn('react','AI 반응 생성','zab-primary')}${btn('delete','게시글 삭제','zab-danger','')}</div></div>${translationToggle()}<div class="zab-section"><span class="zab-meta">${communityAuthorName(p,p)}${rpTimeText(p)?' · '+esc(rpTimeText(p)):''}</span><h2 style="margin:10px 0;font-size:17px">${esc(translatedText(p,'title'))}</h2><p>${esc(translatedText(p,'body'))}</p><div class="zab-engagement">${likeControl(p.id,p)}<span class="zab-card-metric">${boardIcon('message')}<span>댓글 ${stats(p).comments}</span></span><span class="zab-card-metric">${boardIcon('eye')}<span>조회 ${p.views}</span></span></div></div><div class="zab-section"><b>댓글 ${stats(p).comments}</b>${comments||'<p class="zab-note">아직 댓글이 없어요.</p>'}</div><label>댓글 작성</label><textarea id="zab-comment-text" rows="2" placeholder="댓글 입력"></textarea><div class="zab-comment-submit">${btn('send-comment','댓글 등록','zab-primary')}</div>`;}
  function renderWrite(){return `<div class="zab-write-screen"><div class="zab-write-card"><h3>글쓰기</h3><label for="zab-own-title">제목 <span class="zab-required" aria-hidden="true">*</span></label><input id="zab-own-title" maxlength="180" placeholder="게시글 제목을 입력하세요" required><label for="zab-own-body">본문 <span class="zab-required" aria-hidden="true">*</span></label><textarea id="zab-own-body" rows="4" placeholder="내용을 입력하세요" required></textarea></div><div class="zab-write-actions">${btn('back','취소')}${btn('publish','게시글 등록','zab-primary')}</div></div>`;}
  function renderProfilePanel(){
    const profiles=data?.settings?.profiles||{};
    return `<div class="zab-profile-load-actions">${btn('refresh-profiles','제타 프로필 불러오기','zab-primary')}</div>
      <p class="zab-note zab-profile-status-lines"><span id="zab-profile-status">${esc(profileInfo)}</span><span id="zab-profile-count">불러온 후보: 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.users.length}개</span></p>
      ${renderProfileChoices()}
      ${!profileCache.characters.length&&!profileCache.users.length?`<p class="zab-note">저장된 프로필이 없어요. 불러오기를 눌러 제타에서 가져온 뒤 수정하고 저장하세요.</p>`:''}
      <div class="zab-divider"></div><h4>정보 보완</h4>
      <label>세계관 설정·배경</label>${ta('profiles.world',profiles.world||'',4)}
      <p class="zab-note">세계관 설명을 입력해도 필수 프로필 선택이 생략되지는 않아요.</p>`;
  }
  function renderSettings(){const s=data.settings;return `<div class="zab-settings-topline">${btn('settings-back','← 게시판으로')}<span class="zab-settings-top-title">설정</span></div><div class="zab-tabs">${tabs.map(([id,name])=>btn('tab:'+id,name,settingTab===id?'active':'')).join('')}</div><div class="zab-section zab-settings-section">${settingTab==='basic'?`<h4 class="zab-main-settings-heading">테마</h4><label>화면 모드</label>${themeButtons()}<div class="zab-divider"></div><h4 class="zab-main-settings-heading">공통 설정</h4><p class="zab-note">공통 설정은 모든 채팅방에서 공유됩니다. 아래 채팅방별 설정과 실제 턴 카운트·자동 생성 진행 상태는 채팅방마다 유지됩니다.</p>${onOffSegment('auto','자동 갱신')}<label>자동 갱신 주기 (턴)</label>${inp('turns',s.turns,'number','min="1" max="999" step="1"')}<label>자동 생성 대기 시간 (초)</label>${inp('autoDelaySeconds',num(s.autoDelaySeconds,1,300,10),'number','min="1" max="300" step="1"')}<p class="zab-note">기본 대기 10초 · 설정 범위 1~300초 · 신규 턴 감지 후 대기</p><div class="zab-divider"></div><h4>AI 생성 설정</h4><label>새 게시글 생성 수</label>${inp('posts',s.posts,'number','min="1" max="15"')}<label>새 게시글당 댓글 최대 개수</label>${inp('newComments',s.newComments,'number','min="0" max="30"')}<label>기존 글 댓글·대댓글 최대 개수</label>${inp('oldComments',s.oldComments,'number','min="0" max="100"')}<label>댓글 추가 대상 최근 게시글 수</label>${inp('oldPostWindow',s.oldPostWindow,'number','min="0" max="300"')}<label>공개적으로 목격된 새 사건이 없을 때</label>${settingsSegment('quiet',[['daily','일상 게시글 생성'],['skip','게시글 생성 안 함'],['rumors','기존 소문 이어가기']],'공개적으로 목격된 새 사건이 없을 때')}<div class="zab-divider"></div><h4>게시판 표시 설정</h4>${onOffSegment('showParticipationDot','게시글 카드 참여 표시')}${onOffSegment('highlightPostAuthor','게시글 작성자 댓글 강조')}<div class="zab-divider"></div><h4 class="zab-main-settings-heading">채팅방별 설정</h4><h4>날짜·시간 설정</h4><label>게시글과 댓글에 표시할 시간 기준</label>${timeModeButtons()}<p class="zab-note">RP 시간은 가장 최근 턴의 코드블록/InfoBox 상태창에서 읽으며, 날짜 또는 시간만 있으면 확인된 항목만 표시합니다.</p>`:
  settingTab==='community'?`<div class="zab-flex zab-profile-section-heading"><strong>프로필 불러오기</strong>${btn('toggle-profile-section',profileSectionOpen?'접기':'펼치기')}</div>
  ${profileSectionOpen?renderProfilePanel():`<p class="zab-note">${esc(profileSelectionStatus())}</p>`}
  <div class="zab-divider"></div><h4>② 커뮤니티 설정</h4>
  <label>현재 커뮤니티</label>
  ${communityGrid()}
  ${communityDraft?.id==='gallery'?`<label>갤러리 소개·주제</label><textarea data-gallery-topic="yes" rows="3" placeholder="예: 우리 학교 학생들의 일상과 소문">${esc(communityDraft.galleryDescription)}</textarea>`:''}
  ${communityDraft?.id==='__new_custom__'?`
    <label>강조색 (HEX)</label><div class="zab-color-control"><input type="text" data-custom-hex="yes" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" value="${esc(communityDraft.custom.color)}" placeholder="#FFFFFF" aria-label="커뮤니티 강조색 HEX"><input type="color" data-community-field="color" value="${esc(/^#[0-9a-f]{6}$/i.test(communityDraft.custom.color)?communityDraft.custom.color:'#505969')}" aria-label="강조색 팔레트에서 선택"></div>
    <label>커뮤니티 이름</label><input data-community-field="name" maxlength="80" value="${esc(communityDraft.custom.name)}" placeholder="예: 캠퍼스 대나무숲">
    <label>게시판 이름</label><input data-community-field="title" maxlength="100" value="${esc(communityDraft.custom.title)}" placeholder="예: 자유게시판">
    <label>커뮤니티 소개</label><textarea data-community-field="desc" rows="3" placeholder="예: 성격·분위기">${esc(communityDraft.custom.desc)}</textarea>
    <label>말투 지침</label><textarea data-community-field="style" rows="3">${esc(communityDraft.custom.style)}</textarea>
    <label>말투 예시 (선택사항)</label><textarea data-community-field="example" rows="3">${esc(communityDraft.custom.example)}</textarea>
  `:`
    <label>게시판 이름</label><input data-community-title="yes" maxlength="100" value="${esc(communityDraft?.title??s.boardTitles?.[s.selected]??'')}" placeholder="자동 제목 사용">
    <label class="zab-profile-choice"><input type="checkbox" data-community-translate="yes" ${(communityDraft?communityDraft.translate:translationFor(s.selected))?'checked':''}> 한국어 번역 옵션 (원문/번역 전환)</label>
    <p class="zab-note">한국어 번역 옵션을 활성화하면 추가 출력 토큰이 사용될 수 있습니다.</p>
  `}
  <label>추가 지침 (말투·분위기 등)</label><textarea data-community-guide="yes" rows="4" placeholder="선택한 커뮤니티에만 적용할 Gemini 추가 지침을 입력하세요.">${esc(communityDraft?.guide||'')}</textarea>
  <p class="zab-note">현재 채팅방의 선택한 커뮤니티에만 적용됩니다. 커뮤니티 설정 확인을 눌러 저장하세요.</p>
  <p class="zab-note">커뮤니티를 변경해도 게시글·주민 기록은 보존됩니다.</p>
  ${btn('confirm-community',communitySettingsConfirmed()?'커뮤니티 설정 확인됨':'커뮤니티 설정 확인',communitySettingsConfirmed()?'':'zab-primary')}
  ${s.custom.length?`<h4 style="margin-top:18px">사용자 지정 커뮤니티</h4>${s.custom.map(c=>`<div class="zab-flex zab-section"><span>${esc(c.name)}</span>${btn('edit-custom:'+c.id,'수정')}${btn('remove-custom:'+c.id,'삭제')}</div>`).join('')}`:''}`:
  settingTab==='people'?`<h4>내 닉네임</h4>${settingsSegment('userNickMode',[['auto','커뮤니티별 자동 부여'],['custom','직접 설정']],'내 닉네임 설정')}<label>직접 사용할 닉네임</label>${inp('userNick',s.userNick)}<p class="zab-note">자동 닉네임은 커뮤니티별 규칙에 맞춰 서로 구분되는 익명 별명을 적용합니다(블라인드 회사명 · 별명 / X @핸들 / Reddit u/핸들 / 에브리타임 익명번호). 직접 입력한 별명은 우선 적용되며 기존 글·댓글은 유지됩니다.</p><div class="zab-divider"></div><h4>고정 주민 닉네임 수정</h4>${Object.values(currentBoard().residents).length?Object.values(currentBoard().residents).map(r=>`<div class="zab-flex"><span style="font-size:11px;max-width:100px;overflow-wrap:anywhere">${esc(r.id)}</span><input data-resident="${esc(r.id)}" value="${esc(r.nick)}" maxlength="60"></div>`).join(''):'<p class="zab-note">아직 등장한 고정 주민이 없어요.</p>'}<p class="zab-note">수정한 이름은 새 활동부터 적용되고 과거 게시글 표시는 유지돼요.</p>`:
  settingTab==='api'?`<h4>API 설정</h4><p class="zab-note">API 키와 모델 설정은 모든 채팅방에서 공유됩니다.</p><label>Gemini API 키</label><div class="zab-row"><input id="zab-api-key" type="password" placeholder="키 입력 후 저장" style="flex:1;min-width:100px" autocomplete="off">${btn('save-key','키 저장')}</div><p class="zab-note">키는 Tampermonkey 저장소에만 보관하며 JSON 백업에 포함하지 않아요.</p><label>Gemini 모델</label>${modelSelection()}<div class="zab-row">${btn('models','모델 목록 불러오기')}</div>`:
  `<h4>데이터 관리</h4><div class="zab-row">${btn('export','JSON 내보내기','zab-primary')}${btn('import','JSON 가져오기')}</div><input type="file" id="zab-import-file" accept="application/json,.json" hidden><p class="zab-note">가져오기할 때 덮어쓰기와 합치기 중 선택합니다. Gemini API 키는 제외됩니다.</p><div class="zab-divider"></div><h4>초기화</h4>
    <div class="zab-row">${btn('reset-community','현재 커뮤니티 초기화','zab-danger')}
    ${btn('reset-room-communities','현재 채팅방 초기화','zab-danger')}
    ${btn('reset-all-chatrooms','모든 채팅방 초기화','zab-danger')}</div>
    <p class="zab-note">현재 커뮤니티 초기화: 현재 채팅방의 선택한 커뮤니티 기록만 삭제합니다. 다른 커뮤니티와 설정은 유지됩니다.</p>
    <p class="zab-note">현재 채팅방 초기화: 현재 채팅방의 모든 커뮤니티 기록을 삭제합니다. 설정과 프로필은 유지됩니다.</p>
    <p class="zab-note">모든 채팅방 초기화: 모든 채팅방의 게시판 데이터·채팅방별 설정·프로필을 삭제합니다. 공통 기본/API 설정은 유지됩니다.</p>
    <p class="zab-note"><b>세 가지 모두 Gemini API 키는 삭제하지 않습니다.</b> 삭제 전에 JSON 백업을 권장합니다.</p>`}</div>`;}
  async function onClick(e){const b=e.target.closest('button[data-act]');if(!b){const card=e.target.closest('[data-open]');if(card){detailId=card.dataset.open;const board=currentBoard();if(!board.seen||typeof board.seen!=='object')board.seen={};markRead(detailId);postsView='detail';render();}return;}const a=b.dataset.act;if(a==='close'){panel.hidden=true;return;}if(a==='footer-auto-toggle'){if(data)toggleAuto(!data.settings.auto);return;}if(a.startsWith('toggle-global:')){if(!data)return;const [name,value]=a.slice('toggle-global:'.length).split(':');if(!['auto','showParticipationDot','highlightPostAuthor'].includes(name)||!['on','off'].includes(value))return;const enabled=value==='on';if(name==='auto')return toggleAuto(enabled);data.settings[name]=enabled;saveSettings(true);return;}if(a.startsWith('setting-segment:')){if(!data)return;const parts=a.slice('setting-segment:'.length).split(':');const name=parts[0],value=parts[1];const allowed=name==='quiet'?['daily','skip','rumors']:name==='userNickMode'?['auto','custom']:[];if(!allowed.includes(value))return;data.settings[name]=value;saveSettings(name==='quiet');return;}if(a.startsWith('time-mode:')){if(!data)return;const mode=a.slice(10);if(!['real','rp'].includes(mode))return;data.settings.timeMode=mode;saveSettings();return;}if(a.startsWith('theme:')){const mode=a.slice(6);if(!['system','light','dark'].includes(mode))return;themeMode=mode;try{GM_setValue('zab-theme-mode',themeMode);}catch{}render();return;}if(a==='profiles-panel'||a==='setup-profile'){settingsOpen=true;if(!communityDraft)startCommunityDraft();profilePanelOpen=false;settingTab='community';profileSectionOpen=true;render();return;}if(a==='setup-community'||a==='pick-community'){settingsOpen=true;if(!communityDraft)startCommunityDraft();settingTab='community';profileSectionOpen=false;render();return;}if(a==='toggle-profile-section'){profileSectionOpen=!profileSectionOpen;render();return;}if(a==='confirm-community'){confirmCommunityDraft();return;}if(a.startsWith('choose-community:')){const id=a.slice('choose-community:'.length);if(id!=='__new_custom__'&&![...presets,...safeArray(data.settings.custom)].some(c=>c.id===id))return;selectCommunityDraft(id);return;}if(a==='settings'){profilePanelOpen=false;settingsOpen=!settingsOpen;if(settingsOpen)startCommunityDraft();else communityDraft=null;render();return;}if(a==='settings-back'){settingsOpen=false;communityDraft=null;render();return;}if(a.startsWith('tab:')){settingTab=a.slice(4);if(settingTab==='community'&&!communityDraft)startCommunityDraft();render();if(settingTab==='basic')updateProfileStatus();return;}if(a==='write'){postsView='write';render();return;}if(a==='back'){postsView='list';render();return;}if(a==='publish'){makeOwnPost(panel.querySelector('#zab-own-title')?.value||'',panel.querySelector('#zab-own-body')?.value||'');return;}if(a==='generate')return generate('manual');if(a==='regen')return generate('regenerate');if(a==='cancel'){cancelBusy();show('생성을 취소했어요. 0턴부터 시작합니다.');return;}if(a==='sort-recent'||a==='sort-popular'||a==='sort-unread'){currentBoard().sort=a==='sort-recent'?'recent':a==='sort-popular'?'popular':'unread';saved();render();return;}if(a.startsWith('like:')){const parts=a.slice(5).split(':');toggleLike(parts[0],parts[1]);return;}if(a==='translation-original'||a==='translation-ko'){currentBoard().translationView=a==='translation-ko'?'ko':'original';saved();render();return;}if(a==='delete')return deletePost(detailId);if(a==='send-comment'){addOwnComment(detailId,'',panel.querySelector('#zab-comment-text')?.value||'');return;}if(a.startsWith('reply:')){
    const parentId=a.slice(6);
    const areas=[...panel.querySelectorAll('[data-reply-parent]')];
    const area=areas.find(el=>el.dataset.replyParent===parentId);
    if(!area)return;
    const alreadyOpen=!!area.querySelector('textarea');
    for(const el of areas)el.replaceChildren();
    if(alreadyOpen)return;
    area.innerHTML=`<label>대댓글 작성</label><textarea class="zab-reply-text" rows="2" placeholder="답글 입력"></textarea><div class="zab-row zab-reply-submit"><button type="button" data-act="cancel-reply">취소</button><button type="button" data-act="send-reply:${esc(parentId)}" class="zab-primary">등록</button></div>`;
    area.querySelector('textarea')?.focus();
    return;
  }
  if(a==='cancel-reply'){panel.querySelectorAll('[data-reply-parent]').forEach(el=>el.replaceChildren());return;}
  if(a.startsWith('send-reply:')){
    const area=b.closest('[data-reply-parent]');
    const parentId=a.slice(11);
    if(!area||area.dataset.replyParent!==parentId)return;
    addOwnComment(detailId,parentId,area.querySelector('textarea')?.value||'');
    return;
  }if(a==='react'){return generate('react',currentBoard().posts.find(x=>x.id===detailId));}if(a==='save-key'){setKey(panel.querySelector('#zab-api-key')?.value||'');panel.querySelector('#zab-api-key').value='';show('API 키를 저장했어요.');return;}if(a==='models')return fetchModels();if(a==='check-model')return checkSelectedModel();if(a==='set-manual-model'){const id=String(panel.querySelector('#zab-manual-model')?.value||'').trim().replace(/^models\//,'');if(!/^[a-zA-Z0-9._-]{3,100}$/.test(id))return show('올바른 Gemini 모델 ID를 입력하세요.');data.settings.model=id;saveSettings(true);return show('모델을 '+id+'로 설정했어요.');}if(a==='refresh-profiles'){requestProfiles();return;}if(a==='select-all-characters'||a==='clear-all-characters'){profileDraftSelection.characterIds=a==='select-all-characters'?profileCache.characters.map(profileKey):[];render();return;}if(a==='save-profiles'){saveProfileDraft();return;}if(a==='discard-profiles'){discardProfileDraft();return;}if(a.startsWith('edit-custom:')){const id=a.slice(12),c=data.settings.custom.find(x=>x.id===id);if(!c)return;const name=prompt('커뮤니티 이름',c.name);if(name===null)return;const desc=prompt('커뮤니티 설명·분위기',c.desc);if(desc===null)return;const nick=prompt('닉네임 형식',c.nick);if(nick===null)return;const style=prompt('말투 지침',c.style);if(style===null)return;const color=prompt('강조색 HEX (예: #505969)',c.color||'#505969');if(color===null)return;if(!/^#[0-9a-f]{6}$/i.test(color))return show('강조색은 #RRGGBB 형식으로 입력해 주세요.');Object.assign(c,{name:short(name,80)||c.name,desc:short(desc,2000),nick:short(nick,400),style:short(style,2000),color});saveSettings();return;}if(a.startsWith('remove-custom:')){const id=a.slice(14);if(!confirm('커뮤니티 설정을 삭제할까요? 기록도 삭제하려면 데이터 관리에서 먼저 초기화해 주세요.'))return;data.settings.custom=data.settings.custom.filter(x=>x.id!==id);if(data.settings.selected===id)communityChange('everytime');saveSettings();return;}if(a==='reset-community')return resetCommunity();if(a==='reset-room-communities')return resetRoomCommunities();if(a==='reset-all-chatrooms')return resetAllChatRooms();if(a==='export')return exportJSON();if(a==='import')return panel.querySelector('#zab-import-file')?.click();}
  function onInput(e){const el=e.target;
    if(el.id==='zab-own-body'){resizeOwnBody(el);return;}
    if(el.dataset.profileEdit){
      const p=el.dataset.profileEdit==='user'?profileCache.users.find(x=>profileKey(x)===profileDraftSelection.userId):profileCache.characters.find(x=>profileKey(x)===el.dataset.profileId);
      if(p&&['name','description'].includes(el.dataset.profileField)){
        if(!p._key)p._key=profileKey(p);
        p[el.dataset.profileField]=short(el.value,el.dataset.profileField==='name'?160:16000);
      }
      return;
    }
    if(el.dataset.customHex==='yes'){if(!communityDraft)startCommunityDraft();const color=el.value.trim();communityDraft.custom.color=color;if(/^#[0-9a-f]{6}$/i.test(color)){const picker=panel?.querySelector('input[data-community-field="color"]');if(picker)picker.value=color;}refreshCommunityConfirmButton();return;}if(el.dataset.communityField==='color'){if(!communityDraft)startCommunityDraft();communityDraft.custom.color=el.value;const hex=panel?.querySelector('input[data-custom-hex="yes"]');if(hex)hex.value=el.value.toUpperCase();refreshCommunityConfirmButton();return;}if(el.dataset.communityGuide==='yes'){if(!communityDraft)startCommunityDraft();communityDraft.guide=el.value.slice(0,5000);refreshCommunityConfirmButton();return;}if(el.dataset.galleryTopic==='yes'){if(!communityDraft)startCommunityDraft();communityDraft.galleryDescription=short(el.value,2000);refreshCommunityConfirmButton();return;}if(el.dataset.communityField){if(!communityDraft)startCommunityDraft();communityDraft.custom[el.dataset.communityField]=short(el.value,el.dataset.communityField==='name'?80:el.dataset.communityField==='title'?100:2000);refreshCommunityConfirmButton();return;}if(el.dataset.communityTitle==='yes'){if(!communityDraft)startCommunityDraft();communityDraft.title=short(el.value,100);refreshCommunityConfirmButton();return;}if(!el.dataset.resident)return;const r=currentBoard().residents[el.dataset.resident];if(r){r.nick=short(el.value,60);saved();}}
  function onChange(e){const el=e.target;if(el.id==='zab-import-file'){const file=el.files?.[0];if(file)importJSON(file);el.value='';return;}if(!data)return;
    if(el.dataset.customHex==='yes'){if(!/^#[0-9a-f]{6}$/i.test(el.value.trim()))show('강조색은 #FFFFFF처럼 #RRGGBB 형식으로 입력해 주세요.');return;}if(el.dataset.profileUser==='yes'||el.hasAttribute('data-profile-character')){
      const previous=profileDraftSelection;
      if(el.dataset.profileUser==='yes')previous.userId=el.checked?String(el.value||''):(previous.userId===String(el.value||'')?'':previous.userId);
      else{const id=el.dataset.profileCharacter;const ids=new Set(safeArray(previous.characterIds));if(el.checked)ids.add(id);else ids.delete(id);previous.characterIds=[...ids];}
      profileDraftSelection=previous;render();return;
    }
    if(el.dataset.topTitle==='yes'){data.settings.topTitles=data.settings.topTitles&&typeof data.settings.topTitles==='object'?data.settings.topTitles:{};const v=short(el.value,100);if(v)data.settings.topTitles[data.settings.selected]=v;else delete data.settings.topTitles[data.settings.selected];saveSettings();return;}if(el.dataset.communityTitle==='yes'){if(!communityDraft)startCommunityDraft();communityDraft.title=short(el.value,100);refreshCommunityConfirmButton();return;}if(el.dataset.communityTranslate==='yes'){if(!communityDraft)startCommunityDraft();communityDraft.translate=!!el.checked;refreshCommunityConfirmButton();return;}const name=el.dataset.setting;if(!name)return;const s=data.settings,v=el.type==='checkbox'?el.checked:el.value;if(name==='auto')return toggleAuto(v);if(name==='translation-toggle'){s.translationEnabled=s.translationEnabled&&typeof s.translationEnabled==='object'?s.translationEnabled:{};s.translationEnabled[s.selected]=!!v;return saveSettings();}if(name==='ui-theme'){themeMode=['system','light','dark'].includes(v)?v:'system';try{GM_setValue('zab-theme-mode',themeMode);}catch{}render();return;}if(name==='selected')return selectCommunityDraft(v);if(name.startsWith('profiles.')){s.profiles[name.slice(9)]=short(v,20000);}else if(['turns','autoDelaySeconds','posts','newComments','oldComments','oldPostWindow'].includes(name)){const limits={turns:[1,999],autoDelaySeconds:[1,300],posts:[1,15],newComments:[0,30],oldComments:[0,100],oldPostWindow:[0,300]};s[name]=num(v,...limits[name],defaults()[name]);if(name==='turns'){runEpoch++;clearTimeout(autoTimer);turnCount=0;}if(name==='autoDelaySeconds'){clearTimeout(autoTimer);autoTimer=null;clearTimeout(autoRetryTimer);autoRetryTimer=null;pendingAutoCheck=null;autoWaitUntil=0;autoStage='';if(s.auto&&currentBoard().started&&turnCount>=s.turns&&activeTurnKey&&!busy)scheduleAuto(activeTurnKey,activeTurnHash);}}else s[name]=v;saveSettings(GLOBAL_PREF_FIELDS.includes(name));}
  function exportJSON(){if(!data)return;const payload={format:'zeta-anonymous-board',version:VERSION,exportedAt:new Date().toISOString(),room:data.room,settings:copy(data.settings),boards:copy(data.boards)};delete payload.settings.apiKey;const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='zeta-anonymous-board-'+data.room.slice(0,8)+'-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),45000);show('JSON 백업 다운로드를 요청했어요.');}
  async function importJSON(file){if(file.size>25*1024*1024)return show('25MB를 넘는 파일은 가져올 수 없어요.');let obj;try{obj=JSON.parse(await file.text());}catch{return show('JSON 파일을 해석할 수 없어요.');}if(obj?.format!=='zeta-anonymous-board'||!obj.room||!obj.boards||typeof obj.boards!=='object'||Array.isArray(obj.boards)||!obj.settings)return show('제타 익명 게시판 백업 형식이 아니에요.');if(obj.room!==room&&!confirm('백업의 채팅방 ID가 현재 방과 달라요. 현재 방에 복원할까요?'))return;const choice=prompt('복원 방식 선택: 1 = 덮어쓰기, 2 = 합치기','2');if(!['1','2'].includes(choice))return;const before=copy(data);try{migrateCommunityGuides(obj.settings);if(choice==='1'){data.settings={...defaults(),...obj.settings,selected:obj.settings.selected||'everytime'};data.settings.profileSelection={userId:String(obj.settings.profileSelection?.userId||''),characterIds:safeArray(obj.settings.profileSelection?.characterIds).map(String)};data.boards=copy(obj.boards);}else{for(const [id,src] of Object.entries(obj.boards)){if(!src||!Array.isArray(src.posts))continue;const target=data.boards[id]||(data.boards[id]=blankBoard());const ids=new Map(target.posts.map(p=>[p.id,p]));for(const p of src.posts){if(!p?.id||!Array.isArray(p.comments))continue;if(!ids.has(p.id)){target.posts.push(p);ids.set(p.id,p);}else{const existing=ids.get(p.id);if(existing.title!==p.title||existing.body!==p.body){if(confirm('중복 게시글 내용이 달라요. 백업 내용으로 덮어쓸까요?\n'+p.title))Object.assign(existing,p);}else{const comments=new Set(existing.comments.map(x=>x.id));for(const c of p.comments)if(c.id&&!comments.has(c.id)){existing.comments.push(c);comments.add(c.id);}}}}target.residents={...safeObj(src.residents),...safeObj(target.residents)};target.started=target.started||src.started||target.posts.length>0;}
      if(!data.settings.savedProfiles&&obj.settings.savedProfiles?.user)data.settings.savedProfiles=copy(obj.settings.savedProfiles);for(const c of safeArray(obj.settings.custom)){if(!data.settings.custom.some(x=>x.id===c.id))data.settings.custom.push(c);}data.settings.communityGuides=data.settings.communityGuides&&typeof data.settings.communityGuides==='object'?data.settings.communityGuides:{};for(const [id,guide] of Object.entries(obj.settings.communityGuides||{})){if(!Object.prototype.hasOwnProperty.call(data.settings.communityGuides,id)&&typeof guide==='string')data.settings.communityGuides[id]=guide;}}
      for(const b of Object.values(data.boards)){b.posts=safeArray(b.posts).filter(p=>p&&p.id&&Array.isArray(p.comments)).slice(0,10000);b.residents=safeObj(b.residents);b.lastBatch=null;b.unread=0;}
      runEpoch++;cancelBusy();turnCount=0;
      const snap=data.settings.savedProfiles;
      profileCollectionActive=false;
      profileCache=snap?.user?{users:[copy(snap.user)],characters:copy(safeArray(snap.characters)),plot:null}:{users:[],characters:[],plot:null};
      profileDraftSelection=snap?.user?{userId:profileKey(snap.user),characterIds:safeArray(snap.characters).map(profileKey)}:{userId:'',characterIds:[]};
      applyGlobalPreferences();await writeRoom(data);show('백업 복원이 완료됐어요.');settingsOpen=false;render();}catch(e){data=before;show('복원 실패: '+e.message);}}
  const safeObj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
  window.addEventListener('resize',applySize);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
  // Only expose non-sensitive diagnostic information. Authentication never leaves the Zeta page bridge.
  window.zetaAnonymousBoardDiagnostics=()=>({version:VERSION,room,turnCount,turns:observedTurns.length,auto:!!data?.settings.auto,community:data?.settings.selected,busy:!!busy,profileCandidates:{users:profileCache.users.length,characters:profileCache.characters.length},profileChosen:profileSelection().valid,started:!!data?.boards?.[data?.settings?.selected]?.started,baselineReady,seenTurns:seenTurnIds.size,activeTurnKey,turnEvents,autoStage,lastLiveSync,lastLatestRequest,turnMessagesSeen,turnPages,turnStatusError,turnLoading,turnLoadCount,lastTurnAnchor,completedTurnTotal,lastBridgeResponse,bridgeInstallError});
})();
