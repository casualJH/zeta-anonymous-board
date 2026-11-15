// ==UserScript==
// @name         제타 익명 게시판
// @namespace    zeta-anonymous-board
// @version      0.2.1
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
  const VERSION='0.2.1', DB='zeta-anonymous-board-v1', API='https://api.zeta-ai.io';
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
    {id:'office',name:'사내 익명 게시판',desc:'같은 회사 직원들이 일상과 소문을 나눔',nick:'익명직원, 개발팀 익명',style:'사내 익명 게시판 말투'},
    {id:'reddit',name:'Reddit',desc:'서브레딧식 토론, 농담과 반응',nick:'u/name',style:'Reddit 토론 문화에 맞는 말투를 한국어로 자연스럽게 표현'},
    {id:'x',name:'X',desc:'짧은 글, 실시간 화제와 반응',nick:'@handle',style:'짧고 속도감 있는 SNS 말투'},
    {id:'neighborhood',name:'동네 게시판',desc:'동네 생활, 목격담과 지역 정보',nick:'동네산책러, 이웃주민',style:'주민 카페 말투'}
  ];
  const defaults=()=>({auto:true,turns:1,posts:3,newComments:7,oldComments:10,oldPostWindow:20,quiet:'daily',model:'gemini-3.5-flash-lite',fallback:'gemini-3.1-flash-lite',temperature:0.9,guide:'',userNickMode:'auto',userNick:'',selected:'everytime',custom:[],status:'',profiles:{user:'',characters:'',world:''},profileSelection:{userId:'',characterIds:[]},savedProfiles:null});
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
  let room='',data=null,postsView='list',detailId='',settingsOpen=false,profilePanelOpen=false,settingTab='basic',panel=null,launcher=null,notice='',noticeUntil=0;
  let busy=null,pending=null,turnCount=0,activeTurnKey='',activeTurnHash='',lastTurnKeys=[],baselineReady=false,autoTimer=null,latestTimer=null,loadBusy=false,lastLiveSync=0,runEpoch=0,pendingAutoCheck=null;
  let seenTurnIds=new Set(),lastTurnTime=0,autoRetryTimer=null,autoWaitUntil=0,autoStage='',turnEvents=0;
  let profileCollectionActive=false, profileDraftSelection={userId:'',characterIds:[]};
  let profileCache={characters:[],users:[],plot:null}, profileDetection={seen:0,paths:new Set(),lastPath:'',apiError:''}, profileInfo='프로필 연결 대기 중', profileRequestRoom='', profileWaitTimer=null,profileAttempt=0, captured=null, networkRoom='',roomMarker='';
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
      // Export DEV compatible cursor pagination, HTTP fallback, and source message-ID de-duplication.
      // Authentication stays inside the page bridge. Initial/explicit fetches may span pages.
      let latestBusy=false,latestQueued=null,latestRuns=0;
      async function latest(requestId=''){
        discover();
        const target=currentRoom;
        if(!target||!headers.authorization){
          emit('messagesStatus',{room:target,ok:false,error:'제타 인증 정보 없음'});
          if(requestId)emit('latestEnd',{room:target,requestId,ok:false});
          return;
        }
        if(latestBusy){if(requestId)latestQueued=requestId;return;}
        latestBusy=true;latestRuns++;
        const isBaseline=latestRuns===1, limitPages=isBaseline?12:3;
        const unique=new Map(),cursors=new Set();
        let cursor='',limit=100,ok=false,error='',pages=0,throttles=0;
        try{
          for(let page=0;page<limitPages;page++){
            if(target!==currentRoom)break;
            const url=origin+'/v1/rooms/'+target+'/messages?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'');
            const response=await base.call(window,url,{headers:{...headers},credentials:'include',cache:'no-store'});
            if((response.status===400||response.status===422)&&limit!==20){limit=20;page--;continue;}
            if(response.status===429){if(++throttles>3){error='제타 API 요청 제한 (429)';break;}await new Promise(r=>setTimeout(r,2500));page--;continue;}
            throttles=0;
            if(!response.ok){error='제타 메시지 API HTTP '+response.status;break;}
            const body=await response.json();
            if(!Array.isArray(body.messages)){error='메시지 응답 형식 오류';break;}
            pages++;ok=true;
            for(const m of body.messages)if(m&&typeof m.id==='string'&&!unique.has(m.id))unique.set(m.id,m);
            if(!body.nextCursor||!body.messages.length)break;
            if(typeof body.nextCursor!=='string'||cursors.has(body.nextCursor)){error='페이지 커서 중복';break;}
            cursors.add(body.nextCursor);cursor=body.nextCursor;
            // The first page is always attempted; remaining pages extend overlap with previous history.
            await new Promise(r=>setTimeout(r,220));
          }
          if(target===currentRoom&&ok){
            emit('messages',{room:target,messages:[...unique.values()],latest:true});
          }
        }catch(e){error=String(e.message||e);}
        finally{
          if(target===currentRoom){
            emit('messagesStatus',{room:target,ok,count:unique.size,pages,error});
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
      window.addEventListener('message',e=>{if(e.source!==window||e.data?.tag!=='zab-control'||e.data.channel!==channel)return;if(e.data.action==='latest')latest(e.data.requestId||'');else if(e.data.action==='profiles')refreshProfiles();else if(e.data.action==='state'){discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});}});
      setInterval(discover,800);discover();emit('state',{room:currentRoom,authorized:!!headers.authorization});
    };
    try{fn.call(page,bridgeId);}catch(e){console.warn('[제타 익명 게시판] 페이지 연결 실패',e);}
  }
  installBridge();
  function bridge(action,requestId=''){window.postMessage({tag:'zab-control',channel:bridgeId,action,requestId},'*');}
  async function setRoom(id){if(!id||!UUID.test(id)||id===room)return;cancelBusy(false);clearTimeout(autoTimer);clearTimeout(latestTimer);clearTimeout(autoRetryTimer);autoRetryTimer=null;autoWaitUntil=0;autoStage='';pendingAutoCheck=null;runEpoch++;turnCount=0;activeTurnKey='';activeTurnHash='';lastTurnKeys=[];seenTurnIds=new Set();lastTurnTime=0;turnEvents=0;lastTurnAnchor='';turnMessagesSeen=0;turnStatusError='';turnPages=0;baselineReady=false;independentProfileCollector.roomChanged();room=id;postsView='list';detailId='';profilePanelOpen=false;profileCache={characters:[],users:[],plot:null};profileDetection={seen:0,paths:new Set(),lastPath:'',apiError:''};clearTimeout(profileWaitTimer);profileWaitTimer=null;profileAttempt++;profileInfo='저장된 프로필 확인 중';profileRequestRoom='';profileCollectionActive=false;profileDraftSelection={userId:'',characterIds:[]};try{data=await readRoom(id)||blankRoom(id);}catch(e){data=blankRoom(id);alert('저장소를 읽지 못해 임시 데이터로 시작합니다: '+e);}if(room!==id)return;data.settings={...defaults(),...data.settings};data.settings.profiles={...defaults().profiles,...data.settings.profiles};data.settings.profileSelection={userId:String(data.settings.profileSelection?.userId||''),characterIds:safeArray(data.settings.profileSelection?.characterIds).map(String)};
    // Only a confirmed snapshot may be used after a reload. Old versions stored IDs
    // but not source content, so those users must import and save once.
    const snapshot=data.settings.savedProfiles;
    if(snapshot?.user&&safeArray(snapshot.characters).length){
      const storedUser=copy(snapshot.user),storedChars=copy(snapshot.characters);
      profileCache={users:[storedUser],characters:storedChars,plot:null};
      profileDraftSelection={userId:profileKey(storedUser),characterIds:storedChars.map(profileKey)};
      profileInfo='저장된 프로필 불러옴 · 자동 재감지 안 함';
    }else{profileInfo='저장된 프로필 없음 · 불러오기 → 수정 → 저장';}
    if(!data.settings.fallbackPreferenceV014){if(!data.settings.fallback)data.settings.fallback='gemini-3.1-flash-lite';data.settings.fallbackPreferenceV014=true;saved();}if(['apartment','dating'].includes(data.settings.selected))data.settings.selected='everytime';render();setTimeout(()=>{if(room!==id)return;bridge('state');bridge('latest');profileRequestRoom=id;},650);}
  function endProfileLoading(message){
    clearTimeout(profileWaitTimer);profileWaitTimer=null;
    profileInfo=message;
    updateProfileStatus();
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
    // Independent deadline, even when Safari loses bridge completion events.
    profileWaitTimer=setTimeout(()=>{
      if(attempt!==profileAttempt||room!==forRoom)return;
      const count=profileCache.characters.length+profileCache.users.length;
      endProfileLoading(count?'확인 완료 · 수집된 프로필 '+count+'개 (추가 응답 없음)':'프로필 요청 시간 초과 · 제타 채팅방을 새로고침한 뒤 다시 시도하세요.');
    },10000);
    independentProfileCollector.refresh();
  }
  function currentBoard(){if(!data)return blankBoard();const id=data.settings.selected;if(!data.boards[id])data.boards[id]=blankBoard();return data.boards[id];}
  function currentCommunity(){return [...presets,...safeArray(data?.settings.custom)].find(x=>x.id===data?.settings.selected)||presets[0];}
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
  let lastTurnAnchor='',turnMessagesSeen=0,turnStatusError='',turnPages=0;
  function processMessages(msgs,latest=false){
    if(!room||!data)return;
    const {groups,normalized}=turnGroups(msgs);
    if(!normalized.length)return;
    turnMessagesSeen=Math.max(turnMessagesSeen,new Set(normalized.map(p=>p.messageId)).size);
    if(latest)lastRawMessageSnapshot=normalized;
    if(!baselineReady){
      observedTurns=groups.map(g=>g.turn);
      acceptBaseline(groups);
      lastTurnAnchor=groups.at(-1)?.anchor||'';
      renderStatus();return;
    }
    if(!groups.length)return;
    const tail=groups.at(-1),lastKey=tail.key,lastHash=fingerprint(tail.turn);
    const lastOverlap=groups.reduce((index,g,i)=>seenTurnIds.has(g.key)?i:index,-1);
    // A partial snapshot ending at a known earlier turn must not rewind our baseline.
    if(seenTurnIds.has(lastKey)&&lastKey!==activeTurnKey)return;
    const candidates=groups.filter((g,i)=>!seenTurnIds.has(g.key)&&(
      lastOverlap>=0?i>lastOverlap:
      g.time>0&&lastTurnTime>0&&g.time>lastTurnTime
    ));
    // Replacement of the most recent CHARACTER answer after the SAME USER
    // is a reroll when the previous answer vanished, not an additional turn.
    const reroll=lastKey!==activeTurnKey&&!!lastTurnAnchor&&tail.anchor===lastTurnAnchor&&
      !groups.some(g=>g.key===activeTurnKey)&&
      candidates.length===1&&candidates[0].key===lastKey;
    if(reroll){
      seenTurnIds.add(lastKey);
      turnEvents++;
      const rerollEligible=data.settings.auto&&currentBoard().started&&(turnCount>=data.settings.turns||!!currentBoard().lastBatch?.temporary||busy?.kind==='auto');
      invalidatePending('최근 답변 변경 감지 · 15초 대기 재시작');
      if(rerollEligible){turnCount=Math.max(turnCount,data.settings.turns);scheduleAuto(lastKey,lastHash);}
    }else if(candidates.length){
      for(const g of candidates)seenTurnIds.add(g.key);
      turnEvents+=candidates.length;
      if(data.settings.auto&&currentBoard().started){
        turnCount+=candidates.length;
        const previousBatch=currentBoard().lastBatch;
        if(previousBatch?.temporary){previousBatch.temporary=false;saved();}
        if(turnCount>=num(data.settings.turns,1,999,1))scheduleAuto(lastKey,lastHash);
        else show('새 턴 '+candidates.length+'개 · '+turnCount+'/'+data.settings.turns+'턴');
      }
    }else if(lastKey===activeTurnKey&&lastHash!==activeTurnHash){
      const eligible=data.settings.auto&&currentBoard().started&&(turnCount>=data.settings.turns||!!currentBoard().lastBatch?.temporary||busy?.kind==='auto');
      invalidatePending('최근 답변 내용 변경 · 15초 대기 재시작');
      if(eligible){turnCount=Math.max(turnCount,data.settings.turns);scheduleAuto(lastKey,lastHash);}
    }else if(lastOverlap<0&&!seenTurnIds.has(lastKey)){
      // No overlap or comparable timestamp: do not count historical pages.
      for(const g of groups)seenTurnIds.add(g.key);
    }
    if(candidates.length||lastKey===activeTurnKey){
      activeTurnKey=lastKey;activeTurnHash=lastHash;
      lastTurnAnchor=tail.anchor||'';
      lastTurnTime=Math.max(lastTurnTime,tail.time);
      lastTurnKeys=groups.map(g=>g.key);
      observedTurns=groups.map(g=>g.turn);
    }
    if(seenTurnIds.size>2000)seenTurnIds=new Set([...seenTurnIds].slice(-1200));
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
    autoStage='waiting';autoWaitUntil=now()+15000;
    show('게시글 생성 대기 중 · 15초');
    const epoch=runEpoch,roomAt=room,comm=data.settings.selected;
    autoTimer=setTimeout(()=>{
      autoTimer=null;autoWaitUntil=0;
      if(epoch!==runEpoch||roomAt!==room||comm!==data?.settings.selected)return;
      verifyAutoTurn({epoch,roomAt,comm,key,hash},0);
    },15000);
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
  window.addEventListener('message',e=>{const m=e.data;if(e.source!==window||m?.tag!=='zab-bridge'||m.channel!==bridgeId)return;if(m.type==='room'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='state'&&m.room&&UUID.test(m.room))setRoom(m.room);if(m.type==='messages'&&m.room===room){processMessages(m.messages,!!m.latest);lastLiveSync=now();}if(m.type==='latestEnd'&&m.room===room)completeAutoCheck(m);if(m.type==='messagesStatus'&&m.room===room){turnStatusError=m.error||'';turnPages=m.pages||0;if(m.ok)lastLiveSync=now();else if(m.error)show('메시지 조회 실패 · '+m.error);}if(m.type==='profile'&&m.room===room&&profileCollectionActive){profileDetection.seen++;profileDetection.lastPath=m.path||'';if(m.path)profileDetection.paths.add(m.path);ingestProfile(m.profile,m.path||'');if(profileWaitTimer&&(profileCache.characters.length||profileCache.users.length))endProfileLoading('프로필 수집됨 · 추가 캐릭터 확인 가능');else updateProfileStatus();}
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
      if(profilePanelOpen)render();
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
      if(profilePanelOpen)render();
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
        endProfileLoading('제타 API 감지 대기 · 채팅방을 새로고침하거나 프로필 선택 화면을 열어 주세요.');
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
    saved();render();show('현재 채팅방에 프로필 원문을 저장했어요.');
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
        <label>캐릭터 설명 수정</label><textarea data-profile-edit="character" data-profile-id="${esc(id)}" data-profile-field="description" rows="5">${esc(p.description)}</textarea>${!String(p.description||'').trim()?'<p class="zab-note">설명 미확인 · 제타에서 캐릭터 프로필 사진을 클릭해 상세 설명을 연 다음, 프로필을 다시 불러오세요.</p>':''}`:`<p class="zab-note">${esc(short(p.description,180)||'설명 미확인 · 제타에서 캐릭터 프로필 사진을 클릭해 상세 설명을 열고 다시 불러오세요.')}</p>`}</div>`;
    }).join('');
    return `<label>Gemini에 전달할 유저 프로필 (필수 · 1개)</label>${userRows||'<p class="zab-note">불러온 유저 프로필이 없어요.</p>'}${userEditor}
      <label>Gemini에 전달할 캐릭터 프로필 (필수 · 1명 이상)</label>
      ${charRows||'<p class="zab-note">저장된 프로필이 없어요. 불러오기 버튼으로 가져오세요.</p>'}
      <p class="zab-note">편집 내용은 아래 저장 버튼을 눌러야 적용됩니다. 기존 저장본은 그전까지 유지돼요.</p>
      <div class="zab-row">${btn('save-profiles','프로필 저장','zab-primary')}${btn('discard-profiles','수정 취소')}</div>`;
  }
  function updateProfileStatus(){
    const el=panel?.querySelector('#zab-profile-status');
    if(el)el.textContent=`${profileInfo} · ${profileSelectionStatus()} · 불러온 후보 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.users.length}개`;
    const list=panel?.querySelector('#zab-profile-selection-status');
    if(list)list.textContent=profileSelectionStatus();
    renderStatus();
  }
  let lastLatestRequest=0;
  function requestLatest(){if(!room||loadBusy)return;loadBusy=true;lastLatestRequest=now();bridge('latest');setTimeout(()=>{loadBusy=false;},2200);}
  let lastBridgeStateAsk=0;const runner=setInterval(()=>{if(!document.body)return;const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname);if(m)setRoom(m[1]);if(now()-lastBridgeStateAsk>6000){lastBridgeStateAsk=now();bridge('state');}if(!room||!data)return;if(now()-lastLatestRequest>8000)requestLatest();if(!panel)mount();},2000);
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
  function promptPayload(kind,post){const b=currentBoard(),s=data.settings,community=currentCommunity(),recent=observedTurns.slice(-Math.max(10,num(s.turns,1,999,1)+5)).map((t,i)=>({turn:i+1,content:t.parts.map(p=>`${p.speaker} (${p.role}): ${short(p.text,1300)}`).join('\n').slice(0,4500)}));const older=b.posts.slice(-num(s.oldPostWindow,0,300,20)).map(p=>({id:p.id,title:p.title,body:short(p.body,850),comments:p.comments.slice(-8).map(c=>({id:c.id,author:c.nick,text:short(c.text,250)}))}));const residents=Object.values(b.residents).slice(-40);
    const instructions=`당신은 가상의 RP 세계에 실제 거주하는 익명 커뮤니티 운영 시뮬레이터다. 관찰자·독자가 아니라 세계관 주민의 입장에서 작성하라. 공개적으로 목격·전달될 수 있는 사건만 목격 사실로 쓰고, 비밀 대화·내면·보이지 않는 사적 행동을 누설하지 마라. 소문은 반드시 소문/추측으로 표현하라. RP 주인공에 관한 글과 주민들의 독립적인 일상을 자연스럽게 섞고, 주어진 세계관의 주요 사실을 바꾸지 않는 선에서 새로운 회사·가게·지역·주민 등 배경 요소 창작은 허용한다. 기존 주민 ID는 재사용 가능하며 새로운 주민을 만들어도 된다. 사용자 글은 삭제·수정하지 마라. 글과 댓글의 닉네임은 해당 커뮤니티에 맞게 만들고, 대댓글은 최대 한 단계. 출력은 반드시 JSON 객체 하나이며 Markdown 코드펜스는 제외.`;
    const schema=`JSON 형태: {"posts":[{"title":"제목","body":"본문","nick":"닉네임","residentId":"재사용할 주민 ID 또는 새 주민용 임의 별칭","views":10,"likes":2,"comments":[{"nick":"닉네임","residentId":"임의 별칭","text":"댓글","likes":1,"replies":[{"nick":"닉네임","residentId":"임의 별칭","text":"대댓글","likes":0}]}]}],"updates":[{"postId":"과거 게시글 ID","comments":[{"nick":"닉네임","residentId":"임의 별칭","text":"추가 댓글","likes":0,"replies":[]}]}]}. 원본에 없는 postId는 사용 금지.`;
    const task=kind==='react'?`아래 사용자 게시글/댓글을 대상으로 AI 주민의 반응만 생성. 새 게시글은 0개. 대상 글 ID=${post?.id||''}. 이전 글 중 해당 글에만 댓글을 추가.`:`새 게시글 ${num(s.posts,1,15,3)}개를 목표로 생성하라. 새 게시글당 댓글 최대 ${num(s.newComments,0,30,7)}개. 기존 최근 ${num(s.oldPostWindow,0,300,20)}개 글 중 내용 관련성이 높은 글에만 추가 댓글을 작성하되, 모든 기존 글에 추가되는 댓글·대댓글 총합은 ${num(s.oldComments,0,100,10)}개 이하. ${s.quiet==='skip'?'공개 사건이 전혀 없다면 게시글과 댓글 생성 생략':s.quiet==='rumors'?'새 사건이 없으면 기존 소문만 이어가기':'새 사건이 없으면 세계관 주민 일상 글 작성'}.`;
    return `${instructions}\n${schema}\n[작업] ${task}\n[커뮤니티] ${JSON.stringify(community)}\n[커뮤니티별 생성 지침] ${short(s.guide,5000)}\n[수집된 프로필] ${JSON.stringify({user:short(s.profiles.user,5000),characters:short(s.profiles.characters,9000),world:short(s.profiles.world,6500),selectedCharacters:profileSelection().characters.slice(0,30),selectedUser:profileSelection().user})}\n[최근 RP 대화 (개인정보 및 비공개 사실은 주민에게 직접 노출 금지)] ${JSON.stringify(recent).slice(0,20000)}\n[기존 주민] ${JSON.stringify(residents).slice(0,7500)}\n[최근 커뮤니티 게시글] ${JSON.stringify(older).slice(0,14000)}\n[사용자 반응 대상] ${JSON.stringify(post||{}).slice(0,5000)}\nJSON 객체만 답하라.`;
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
  async function generate(kind='manual',post=null){if(!data)return;const board=currentBoard(),key=getKey();if(busy)return show('이미 생성 중이에요.');if(!key){settingsOpen=true;settingTab='api';render();return show('Gemini API 키를 입력해 주세요.');}
    if(!profileReady()){
      if(kind==='auto')return show('자동 생성 대기 · '+profileSelectionStatus());
      profilePanelOpen=true;settingsOpen=false;render();return show('필수 프로필 선택이 필요해요. '+profileSelectionStatus());
    }
    if(!board.started&&kind==='auto')return;clearTimeout(autoTimer);const batchToReplace=kind==='regenerate'?board.lastBatch:null;
    const request={id:uid(),kind,cancelled:false,room,community:data.settings.selected,epoch:runEpoch,request:null};const countedAtStart=turnCount;let succeeded=false;busy=request;reactionTarget=post?.id||'';renderStatus();try{const prompt=promptPayload(kind==='react'?'react':'generate',post);const model=data.settings.model||models[0];const body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.9,responseMimeType:'application/json',maxOutputTokens:8192}};const res=await generateWithFallback(key,model,body,request);if(request.cancelled||busy!==request||request.room!==room||request.community!==data?.settings.selected||request.epoch!==runEpoch)return;const result=parseGemini(res);if(kind==='regenerate'&&batchToReplace&&board.lastBatch!==batchToReplace)throw Error('재생성 대상이 변경되었습니다.');const next=applyResult(result,kind,batchToReplace);if(kind==='manual'||kind==='auto'){turnCount=kind==='auto'?Math.max(0,turnCount-countedAtStart):0;autoStage='';if(kind==='manual'&&baselineReady){const {groups}=turnGroups(lastRawMessageSnapshot);if(groups.length){acceptBaseline(groups);lastTurnAnchor=groups.at(-1)?.anchor||'';}}}if(kind==='regenerate'){next.temporary=batchToReplace?.temporary||false;saved();}succeeded=true;show('게시판 갱신 완료 · 새 게시글 '+next.created.length+'개');render();}
    catch(e){if(!request.cancelled)show('게시글 생성 실패: '+e.message);}finally{if(busy===request)busy=null;reactionTarget='';if(succeeded&&kind==='auto'&&turnCount>=data?.settings.turns&&data?.settings.auto&&!autoTimer&&activeTurnKey&&!request.cancelled)scheduleAuto(activeTurnKey,activeTurnHash);render();}
  }
  function chooseNick(){if(data.settings.userNickMode==='custom'&&data.settings.userNick.trim())return short(data.settings.userNick,60);const c=currentCommunity();if(c.id==='everytime')return'익명';if(c.id==='blind')return'익명';return '익명 주민';}
  function makeOwnPost(title,body){if(!title.trim()||!body.trim())return show('제목과 본문을 입력해 주세요.');const b=currentBoard();b.posts.push({id:uid(),title:short(title,180),body:short(body,8500),nick:chooseNick(),residentId:'user',views:0,likes:0,time:now(),source:'user',comments:[]});saved();postsView='list';render();}
  function addOwnComment(postId,parentId,text){if(!text.trim())return;const p=currentBoard().posts.find(x=>x.id===postId);if(!p)return;const c={id:uid(),nick:chooseNick(),residentId:'user',text:short(text,3500),likes:0,time:now(),source:'user',replies:[]};if(parentId){const parent=p.comments.find(c=>c.id===parentId)||p.comments.find(c=>c.replies.some(r=>r.id===parentId));if(parent){c.parentId=parent.id;parent.replies.push(c);}}else p.comments.push(c);saved();render();}
  function deletePost(id){if(!confirm('이 게시글과 모든 댓글을 삭제할까요?'))return;const b=currentBoard();b.posts=b.posts.filter(p=>p.id!==id);if(b.lastBatch?.created.includes(id))b.lastBatch.created=b.lastBatch.created.filter(x=>x!==id);saved();postsView='list';render();}
  function resetCommunity(){if(!confirm('현재 커뮤니티의 게시글·댓글·주민 기록을 모두 삭제할까요?'))return;invalidatePending('');runEpoch++;turnCount=0;data.boards[data.settings.selected]=blankBoard();saved();postsView='list';render();}
  function stats(c){return {views:c.views||0,likes:c.likes||0,comments:c.comments.reduce((n,x)=>n+1+x.replies.length,0)};}
  function sortedPosts(){const b=currentBoard();return [...b.posts].sort((a,z)=>b.sort==='recent'?z.time-a.time:((z.likes*5+stats(z).comments*3+z.views/20)/(1+Math.max(0,(now()-z.time)/86400000)*.1))-((a.likes*5+stats(a).comments*3+a.views/20)/(1+Math.max(0,(now()-a.time)/86400000)*.1)));}
  function renderStatus(){if(!panel)return;const el=panel.querySelector('#zab-status');if(el){const phase=autoStage==='waiting'?' · 생성 대기 중':autoStage==='verifying'?' · 최신 대화 확인 중':autoStage==='retry'?' · 조회 재시도 중':autoStage==='failed'?' · 조회 실패':'';el.textContent=busy?'게시글 생성 중…':now()<noticeUntil?notice:data?'자동 '+(data.settings.auto?'ON':'OFF')+' · '+turnCount+'/'+data.settings.turns+'턴'+(data.settings.auto&&!currentBoard().started?' · 첫 수동 생성 필요':data.settings.auto&&!profileReady()?' · 프로필 선택 필요':phase):'채팅방 연결 대기 중';}const count=launcher?.querySelector('.zab-unread');if(count)count.textContent=data?.boards?.[data.settings.selected]?.unread?'●':'';const cancel=panel.querySelector('#zab-cancel');if(cancel)cancel.hidden=!busy;}
  const tabs=[['basic','기본 설정'],['api','API 설정'],['ai','AI 설정'],['community','커뮤니티 관리'],['people','주민·닉네임'],['data','데이터 관리']];
  function mount(){if(panel||!document.body)return;const style=document.createElement('style');style.textContent=`
  #zab-launch{position:fixed;right:13px;bottom:calc(95px + env(safe-area-inset-bottom,0px));border:1px solid #c4cad3;background:#fff;color:#222;border-radius:999px;padding:10px 14px;font:700 13px system-ui;box-shadow:0 4px 18px #0003;z-index:2147483600;touch-action:none}
  #zab-launch .zab-unread{color:#e34b57;margin-left:4px}
  #zab-panel{position:fixed;right:10px;bottom:calc(145px + env(safe-area-inset-bottom,0px));width:min(400px,calc(100vw - 20px));height:min(610px,75dvh);min-width:245px;min-height:240px;z-index:2147483601;border-radius:14px;background:#fff;color:#24272b;border:1px solid #d9dde2;box-shadow:0 12px 35px #0005;display:flex;flex-direction:column;font:13px/1.5 system-ui;overflow:hidden;box-sizing:border-box}
  #zab-panel[hidden]{display:none!important}#zab-panel *{box-sizing:border-box}#zab-panel button{font:600 12px system-ui;border:1px solid #d5d7df;background:#fff;color:#333;border-radius:7px;padding:7px 9px;cursor:pointer}#zab-panel button:disabled{opacity:.45;cursor:default}#zab-panel button.zab-primary{background:#d94d50;border-color:#d94d50;color:white}#zab-panel button.zab-danger{color:#c03943}#zab-panel button[hidden],#zab-panel [hidden]{display:none!important}
  #zab-panel .zab-head{padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;min-height:45px;cursor:grab;touch-action:none;user-select:none}#zab-panel .zab-head strong{font-size:15px;flex:1}#zab-panel .zab-head button{padding:4px 8px}
  #zab-panel .zab-content{overflow:auto;overscroll-behavior:contain;flex:1;padding:12px;min-height:0}#zab-panel .zab-status{font-size:11px;color:#6d737a;min-height:15px}#zab-panel .zab-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}#zab-panel .zab-flex{display:flex;justify-content:space-between;align-items:center;gap:8px}#zab-panel .zab-tabs{display:flex;gap:4px;overflow-x:auto;white-space:nowrap;padding:2px 0 8px}#zab-panel .zab-tabs button{flex-shrink:0}#zab-panel .zab-tabs .active{color:#d94d50;border-color:#d94d50;background:#fff4f4}#zab-panel .zab-card{border-bottom:1px solid #eee;padding:12px 2px;cursor:pointer}#zab-panel .zab-card:hover{background:#fcfcfc}#zab-panel .zab-card h3{margin:0 0 4px;font-size:14px;line-height:1.4}#zab-panel .zab-card .excerpt{color:#6b6f77;font-size:12px;margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}#zab-panel .zab-meta{font-size:11px;color:#81858c;overflow-wrap:anywhere}#zab-panel .zab-section{padding:10px 0;border-bottom:1px solid #eee}#zab-panel .zab-section h4{margin:0 0 8px;font-size:13px}#zab-panel label{display:block;font-size:12px;font-weight:600;margin:9px 0 4px}#zab-panel input:not([type=checkbox]),#zab-panel select,#zab-panel textarea{width:100%;font:13px/1.5 system-ui;border:1px solid #ced2d9;border-radius:7px;padding:8px;color:#24272b;background:#fff}#zab-panel textarea{resize:vertical;min-height:55px}#zab-panel input[type=number]{max-width:115px}#zab-panel .zab-comment{padding:8px 0;border-bottom:1px solid #f0f0f0}#zab-panel .zab-reply{margin:6px 0 0 17px;border-left:2px solid #e5e5e5;padding-left:10px}#zab-panel .zab-note{font-size:11px;color:#7b8087}#zab-panel .zab-chip{display:inline-block;background:#f1f3f5;color:#696f78;padding:2px 6px;border-radius:6px;font-size:11px}#zab-panel .zab-resize{position:absolute;right:0;bottom:0;width:32px;height:32px;cursor:nwse-resize;touch-action:none;user-select:none;font:20px system-ui;color:#9ba1a9;text-align:right;padding:8px 4px 0 0;background:transparent}#zab-panel label.zab-profile-choice{display:flex;align-items:flex-start;gap:8px;padding:9px 6px;border:1px solid #eceef0;border-radius:7px;margin:5px 0;font-weight:400}#zab-panel .zab-profile-choice input{flex:0 0 auto;margin-top:4px}#zab-panel .zab-profile-choice span{display:block;min-width:0}#zab-panel .zab-profile-choice small{display:block;color:#848a90;font-size:11px;overflow-wrap:anywhere}#zab-panel .zab-divider{height:1px;background:#eee;margin:10px 0}#zab-panel .zab-toolbar{display:flex;gap:6px;margin:10px 0}#zab-panel .zab-toolbar button{flex:1;white-space:nowrap}#zab-panel .zab-footer{padding:6px 10px;border-top:1px solid #eee;display:flex;align-items:center;gap:8px;justify-content:space-between}#zab-panel p{white-space:pre-wrap;overflow-wrap:anywhere}
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
  function render(){if(!panel)return;renderStatus();const node=panel.querySelector('#zab-main');if(!node)return;if(!data){node.innerHTML='<p>제타 채팅방을 열고 메시지가 로드되면 연결됩니다.</p>';return;}node.innerHTML=profilePanelOpen?renderProfilePanel():settingsOpen?renderSettings():postsView==='detail'?renderDetail():postsView==='write'?renderWrite():renderList();}
  function renderList(){const b=currentBoard(),com=currentCommunity();return `<div class="zab-flex"><div><strong style="font-size:17px">${esc(com.name)}</strong><div class="zab-note">${esc(short(com.desc,95))}</div></div><button data-act="profiles-panel" aria-label="프로필 감지 및 선택" title="프로필 선택">👤</button></div>
    <div class="zab-toolbar">${btn('write','글쓰기')}${btn('generate','수동 생성','zab-primary')}${btn('regen','다시 생성','',!b.lastBatch?'disabled':'')}</div>
    <div class="zab-flex"><b>전체 게시글 ${b.posts.length}</b><div>${btn('sort-recent','최신순',b.sort==='recent'?'zab-primary':'')}${btn('sort-popular','인기순',b.sort==='popular'?'zab-primary':'')}</div></div>
    ${!b.posts.length?'<div class="zab-section" style="text-align:center;padding:40px 10px;color:#888">게시글이 없어요.<br>수동 생성 버튼으로 첫 게시글을 만들어 보세요.</div>':sortedPosts().map(p=>`<div class="zab-card" data-open="${esc(p.id)}"><h3>${esc(p.title)}</h3><div class="excerpt">${esc(short(p.body,150))}</div><div class="zab-meta">${esc(p.nick)} · ${esc(timeText(p.time))}</div><div class="zab-meta">조회 ${p.views.toLocaleString()} · 좋아요 ${p.likes.toLocaleString()} · 댓글 ${stats(p).comments}</div></div>`).join('')}`;}
  function renderDetail(){const p=currentBoard().posts.find(x=>x.id===detailId);if(!p){postsView='list';return renderList();}const comments=p.comments.map(c=>`<div class="zab-comment"><div><b>${esc(c.nick)}</b> <span class="zab-meta">${timeText(c.time)} · ♥ ${c.likes}</span></div><p style="margin:4px 0">${esc(c.text)}</p>${btn('reply:'+c.id,'답글','',`data-post="${esc(p.id)}"`)}${c.replies.map(r=>`<div class="zab-reply"><b>${esc(r.nick)}</b> <span class="zab-meta">♥ ${r.likes}</span><p style="margin:4px 0">${esc(r.text)}</p>${btn('reply:'+c.id,'답글','',`data-post="${esc(p.id)}"`)}</div>`).join('')}</div>`).join('');return `<div class="zab-flex">${btn('back','← 목록')} <div>${btn('react','AI 반응 생성','zab-primary')}${btn('delete','게시글 삭제','zab-danger','')}</div></div><div class="zab-section"><span class="zab-meta">${esc(p.nick)} · ${timeText(p.time)}</span><h2 style="margin:10px 0;font-size:17px">${esc(p.title)}</h2><p>${esc(p.body)}</p><div class="zab-meta">조회 ${p.views} · 좋아요 ${p.likes} · 댓글 ${stats(p).comments}</div></div><div class="zab-section"><b>댓글 ${stats(p).comments}</b>${comments||'<p class="zab-note">아직 댓글이 없어요.</p>'}</div><label>댓글 작성</label><textarea id="zab-comment-text" rows="2" placeholder="댓글 입력"></textarea>${btn('send-comment','댓글 등록','zab-primary')}<div id="zab-reply-area"></div>`;}
  function renderWrite(){return `${btn('back','← 목록')}<h3>게시글 작성</h3><label>제목</label><input id="zab-own-title" maxlength="180" placeholder="제목"><label>본문</label><textarea id="zab-own-body" rows="8" placeholder="게시글 내용"></textarea><div class="zab-toolbar">${btn('publish','게시글 등록','zab-primary')}${btn('back','취소')}</div><p class="zab-note">직접 작성한 글은 RP 리롤과 AI 다시 생성으로 삭제되지 않아요.</p>`;}
  function renderProfilePanel(){
    const profiles=data?.settings?.profiles||{};
    return `${btn('profiles-back','← 게시판으로')}<h3>👤 프로필 감지·선택</h3>
      <div class="zab-row">${btn('refresh-profiles','제타 프로필 불러오기','zab-primary')}</div>
      <p class="zab-note" id="zab-profile-status">${esc(profileInfo)} · ${esc(profileSelectionStatus())} · 불러온 후보 캐릭터 ${profileCache.characters.length}명 · 유저 ${profileCache.users.length}개</p>
      ${renderProfileChoices()}
      ${!profileCache.characters.length&&!profileCache.users.length?`<p class="zab-note">저장된 프로필이 없어요. 불러오기를 눌러 제타에서 가져온 뒤 수정하고 저장하세요.</p>`:''}
      <p class="zab-note">진단: 제타 프로필 응답 ${profileDetection.seen}회 · 마지막 경로 ${esc(profileDetection.lastPath||'없음')} · 독립 감시 ${independentProfileCollector.diagnostics().installed?'동작':'실패'} · 인증 ${independentProfileCollector.diagnostics().authorized?'감지':'대기'}</p>
      <div class="zab-divider"></div><h4>수동 정보 보완</h4>
      <label>세계관 설정·배경</label>${ta('profiles.world',profiles.world||'',4)}
      <label>유저 프로필 설명 보완</label>${ta('profiles.user',profiles.user||'',3)}
      <label>캐릭터 프로필 설명 보완</label>${ta('profiles.characters',profiles.characters||'',5)}
      <p class="zab-note">설명을 직접 입력해도 필수 프로필 선택이 생략되지는 않아요.</p>`;
  }
  function renderSettings(){const s=data.settings;return `${btn('settings-back','← 게시판으로')}<h3 style="margin:12px 0 8px">게시판 설정</h3><div class="zab-tabs">${tabs.map(([id,name])=>btn('tab:'+id,name,settingTab===id?'active':'')).join('')}</div><div class="zab-section">${settingTab==='basic'?`<h4>기본 설정</h4><label><input type="checkbox" data-setting="auto" ${s.auto?'checked':''}> 자동 갱신 ON</label><label>자동 갱신 주기 (턴)</label>${inp('turns',s.turns,'number','min="1" max="999" step="1"')}<p class="zab-note">테스트 초기값 1턴 · 정식 사용 권장 3턴 · 완료 후 15초 대기</p><p class="zab-note">최초 수동 AI 생성 이후 자동 갱신됩니다. API 키와 유저·캐릭터 프로필 직접 선택이 필수예요.</p><p class="zab-note">${esc(profileSelectionStatus())}</p>`:
  settingTab==='api'?`<h4>API 설정</h4><label>Gemini API 키</label><div class="zab-row"><input id="zab-api-key" type="password" placeholder="키 입력 후 저장" style="flex:1;min-width:100px" autocomplete="off">${btn('save-key','키 저장')}</div><p class="zab-note">키는 Tampermonkey 저장소에만 보관하며 JSON 백업에 포함하지 않아요.</p><label>Gemini 모델</label>${modelSelection()}<div class="zab-row">${btn('models','모델 목록 불러오기')}</div>`:
  settingTab==='ai'?`<h4>AI 설정</h4><label>새 게시글 수</label>${inp('posts',s.posts,'number','min="1" max="15"')}<label>새 게시글당 최대 댓글 수</label>${inp('newComments',s.newComments,'number','min="0" max="30"')}<label>기존 글 추가 댓글 전체 최대 개수</label>${inp('oldComments',s.oldComments,'number','min="0" max="100"')}<label>기존 댓글 추가 대상 최근 게시글 수</label>${inp('oldPostWindow',s.oldPostWindow,'number','min="0" max="300"')}<label>공개적으로 목격된 새 사건이 없을 때</label>${selection('quiet',s.quiet,[['daily','일상 게시글 생성'],['skip','게시글 생성 안 함'],['rumors','기존 소문 이어가기']])}<label>추가 말투·생성 지침</label>${ta('guide',s.guide,4)}<div class="zab-divider"></div><h4>프로필 선택</h4>${btn('profiles-panel','👤 프로필 선택 화면 열기','zab-primary')}<p class="zab-note">${esc(profileSelectionStatus())}</p>`:
  settingTab==='community'?`<h4>커뮤니티 관리</h4><label>현재 커뮤니티</label>${selection('selected',s.selected,[...presets,...s.custom].map(x=>[x.id,x.name]))}<p class="zab-note">커뮤니티를 변경해도 게시글·주민 기록은 보존되고 자동 갱신은 0턴부터 다시 시작합니다.</p><h4>사용자 지정 커뮤니티 만들기</h4><label>이름</label><input id="zab-custom-name" placeholder="예: 우리 학교 대나무숲"><label>소개·분위기</label><textarea id="zab-custom-desc" rows="3"></textarea><label>닉네임 형식</label><input id="zab-custom-nick" placeholder="예: 익명, ㅇㅇ, 동네산책러"><label>말투 지침</label><textarea id="zab-custom-style" rows="3"></textarea>${btn('add-custom','커뮤니티 추가','zab-primary')}<h4 style="margin-top:18px">사용자 지정 커뮤니티</h4>${s.custom.length?s.custom.map(c=>`<div class="zab-flex zab-section"><span>${esc(c.name)}</span>${btn('edit-custom:'+c.id,'수정')}${btn('remove-custom:'+c.id,'삭제')}</div>`).join(''):'<p class="zab-note">아직 추가한 커뮤니티가 없어요.</p>'}`:
  settingTab==='people'?`<h4>내 닉네임</h4>${selection('userNickMode',s.userNickMode,[['auto','커뮤니티별 자동 부여'],['custom','직접 설정']])}<label>직접 사용할 닉네임</label>${inp('userNick',s.userNick)}<p class="zab-note">변경한 닉네임은 이후 작성하는 글부터 적용합니다.</p><h4>고정 주민 닉네임 수정</h4>${Object.values(currentBoard().residents).length?Object.values(currentBoard().residents).map(r=>`<div class="zab-flex"><span style="font-size:11px;max-width:100px;overflow-wrap:anywhere">${esc(r.id)}</span><input data-resident="${esc(r.id)}" value="${esc(r.nick)}" maxlength="60"></div>`).join(''):'<p class="zab-note">아직 등장한 고정 주민이 없어요.</p>'}<p class="zab-note">수정한 이름은 새 활동부터 적용되고 과거 게시글 표시는 유지돼요.</p>`:
  `<h4>데이터 관리</h4><div class="zab-row">${btn('export','JSON 내보내기','zab-primary')}${btn('import','JSON 가져오기')}</div><input type="file" id="zab-import-file" accept="application/json,.json" hidden><p class="zab-note">가져오기할 때 덮어쓰기와 합치기 중 선택합니다. Gemini API 키는 제외됩니다.</p><div class="zab-divider"></div>${btn('reset-community','현재 커뮤니티 초기화','zab-danger')}<p class="zab-note">다른 커뮤니티·채팅방의 기록은 영향을 받지 않아요.</p>`}</div>`;}
  async function onClick(e){const b=e.target.closest('button[data-act]');if(!b){const card=e.target.closest('[data-open]');if(card){detailId=card.dataset.open;postsView='detail';render();}return;}const a=b.dataset.act;if(a==='close'){panel.hidden=true;return;}if(a==='profiles-panel'){profilePanelOpen=true;settingsOpen=false;render();return;}if(a==='profiles-back'){profilePanelOpen=false;settingsOpen=false;render();return;}if(a==='settings'){profilePanelOpen=false;settingsOpen=!settingsOpen;render();return;}if(a==='settings-back'){settingsOpen=false;render();return;}if(a.startsWith('tab:')){settingTab=a.slice(4);render();if(settingTab==='ai')updateProfileStatus();return;}if(a==='pick-community'){settingsOpen=true;settingTab='community';render();return;}if(a==='write'){postsView='write';render();return;}if(a==='back'){postsView='list';render();return;}if(a==='publish'){makeOwnPost(panel.querySelector('#zab-own-title')?.value||'',panel.querySelector('#zab-own-body')?.value||'');return;}if(a==='generate')return generate('manual');if(a==='regen')return generate('regenerate');if(a==='cancel'){cancelBusy();show('생성을 취소했어요. 0턴부터 시작합니다.');return;}if(a==='sort-recent'||a==='sort-popular'){currentBoard().sort=a==='sort-recent'?'recent':'popular';saved();render();return;}if(a==='delete')return deletePost(detailId);if(a==='send-comment'){addOwnComment(detailId,'',panel.querySelector('#zab-comment-text')?.value||'');return;}if(a.startsWith('reply:')){const area=panel.querySelector('#zab-reply-area');if(area){const id=a.slice(6);area.innerHTML=`<label>대댓글 작성</label><textarea id="zab-reply-text" rows="2"></textarea><button data-act="send-reply:${esc(id)}" class="zab-primary">등록</button>`;}return;}if(a.startsWith('send-reply:')){addOwnComment(detailId,a.slice(11),panel.querySelector('#zab-reply-text')?.value||'');return;}if(a==='react'){return generate('react',currentBoard().posts.find(x=>x.id===detailId));}if(a==='save-key'){setKey(panel.querySelector('#zab-api-key')?.value||'');panel.querySelector('#zab-api-key').value='';show('API 키를 저장했어요.');return;}if(a==='models')return fetchModels();if(a==='check-model')return checkSelectedModel();if(a==='set-manual-model'){const id=String(panel.querySelector('#zab-manual-model')?.value||'').trim().replace(/^models\//,'');if(!/^[a-zA-Z0-9._-]{3,100}$/.test(id))return show('올바른 Gemini 모델 ID를 입력하세요.');data.settings.model=id;saveSettings();return show('모델을 '+id+'로 설정했어요.');}if(a==='refresh-profiles'){requestProfiles();return;}if(a==='save-profiles'){saveProfileDraft();return;}if(a==='discard-profiles'){discardProfileDraft();return;}if(a==='add-custom'){const name=panel.querySelector('#zab-custom-name')?.value.trim();if(!name)return show('커뮤니티 이름을 입력해 주세요.');const c={id:'custom-'+uid(),name:short(name,80),desc:short(panel.querySelector('#zab-custom-desc')?.value,2000),nick:short(panel.querySelector('#zab-custom-nick')?.value,400),style:short(panel.querySelector('#zab-custom-style')?.value,2000)};data.settings.custom.push(c);saveSettings();show('커뮤니티가 추가됐어요.');return;}if(a.startsWith('edit-custom:')){const id=a.slice(12),c=data.settings.custom.find(x=>x.id===id);if(!c)return;const name=prompt('커뮤니티 이름',c.name);if(name===null)return;const desc=prompt('커뮤니티 설명·분위기',c.desc);if(desc===null)return;const nick=prompt('닉네임 형식',c.nick);if(nick===null)return;const style=prompt('말투 지침',c.style);if(style===null)return;Object.assign(c,{name:short(name,80)||c.name,desc:short(desc,2000),nick:short(nick,400),style:short(style,2000)});saveSettings();return;}if(a.startsWith('remove-custom:')){const id=a.slice(14);if(!confirm('커뮤니티 설정을 삭제할까요? 기록도 삭제하려면 데이터 관리에서 먼저 초기화해 주세요.'))return;data.settings.custom=data.settings.custom.filter(x=>x.id!==id);if(data.settings.selected===id)communityChange('everytime');saveSettings();return;}if(a==='reset-community')return resetCommunity();if(a==='export')return exportJSON();if(a==='import')return panel.querySelector('#zab-import-file')?.click();}
  function onInput(e){const el=e.target;
    if(el.dataset.profileEdit){
      const p=el.dataset.profileEdit==='user'?profileCache.users.find(x=>profileKey(x)===profileDraftSelection.userId):profileCache.characters.find(x=>profileKey(x)===el.dataset.profileId);
      if(p&&['name','description'].includes(el.dataset.profileField)){
        if(!p._key)p._key=profileKey(p);
        p[el.dataset.profileField]=short(el.value,el.dataset.profileField==='name'?160:16000);
      }
      return;
    }
    if(!el.dataset.resident)return;const r=currentBoard().residents[el.dataset.resident];if(r){r.nick=short(el.value,60);saved();}}
  function onChange(e){const el=e.target;if(el.id==='zab-import-file'){const file=el.files?.[0];if(file)importJSON(file);el.value='';return;}if(!data)return;
    if(el.dataset.profileUser==='yes'||el.hasAttribute('data-profile-character')){
      const previous=profileDraftSelection;
      if(el.dataset.profileUser==='yes')previous.userId=el.checked?String(el.value||''):(previous.userId===String(el.value||'')?'':previous.userId);
      else{const id=el.dataset.profileCharacter;const ids=new Set(safeArray(previous.characterIds));if(el.checked)ids.add(id);else ids.delete(id);previous.characterIds=[...ids];}
      profileDraftSelection=previous;render();return;
    }
    const name=el.dataset.setting;if(!name)return;const s=data.settings,v=el.type==='checkbox'?el.checked:el.value;if(name==='auto')return toggleAuto(v);if(name==='selected')return communityChange(v);if(name.startsWith('profiles.')){s.profiles[name.slice(9)]=short(v,20000);}else if(['turns','posts','newComments','oldComments','oldPostWindow'].includes(name)){const limits={turns:[1,999],posts:[1,15],newComments:[0,30],oldComments:[0,100],oldPostWindow:[0,300]};s[name]=num(v,...limits[name],defaults()[name]);if(name==='turns'){runEpoch++;clearTimeout(autoTimer);turnCount=0;}}else s[name]=v;saveSettings();}
  function exportJSON(){if(!data)return;const payload={format:'zeta-anonymous-board',version:VERSION,exportedAt:new Date().toISOString(),room:data.room,settings:copy(data.settings),boards:copy(data.boards)};delete payload.settings.apiKey;const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='zeta-anonymous-board-'+data.room.slice(0,8)+'-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),45000);show('JSON 백업 다운로드를 요청했어요.');}
  async function importJSON(file){if(file.size>25*1024*1024)return show('25MB를 넘는 파일은 가져올 수 없어요.');let obj;try{obj=JSON.parse(await file.text());}catch{return show('JSON 파일을 해석할 수 없어요.');}if(obj?.format!=='zeta-anonymous-board'||!obj.room||!obj.boards||typeof obj.boards!=='object'||Array.isArray(obj.boards)||!obj.settings)return show('제타 익명 게시판 백업 형식이 아니에요.');if(obj.room!==room&&!confirm('백업의 채팅방 ID가 현재 방과 달라요. 현재 방에 복원할까요?'))return;const choice=prompt('복원 방식 선택: 1 = 덮어쓰기, 2 = 합치기','2');if(!['1','2'].includes(choice))return;const before=copy(data);try{if(choice==='1'){data.settings={...defaults(),...obj.settings,selected:obj.settings.selected||'everytime'};data.settings.profileSelection={userId:String(obj.settings.profileSelection?.userId||''),characterIds:safeArray(obj.settings.profileSelection?.characterIds).map(String)};data.boards=copy(obj.boards);}else{for(const [id,src] of Object.entries(obj.boards)){if(!src||!Array.isArray(src.posts))continue;const target=data.boards[id]||(data.boards[id]=blankBoard());const ids=new Map(target.posts.map(p=>[p.id,p]));for(const p of src.posts){if(!p?.id||!Array.isArray(p.comments))continue;if(!ids.has(p.id)){target.posts.push(p);ids.set(p.id,p);}else{const existing=ids.get(p.id);if(existing.title!==p.title||existing.body!==p.body){if(confirm('중복 게시글 내용이 달라요. 백업 내용으로 덮어쓸까요?\n'+p.title))Object.assign(existing,p);}else{const comments=new Set(existing.comments.map(x=>x.id));for(const c of p.comments)if(c.id&&!comments.has(c.id)){existing.comments.push(c);comments.add(c.id);}}}}target.residents={...safeObj(src.residents),...safeObj(target.residents)};target.started=target.started||src.started||target.posts.length>0;}
      if(!data.settings.savedProfiles&&obj.settings.savedProfiles?.user)data.settings.savedProfiles=copy(obj.settings.savedProfiles);for(const c of safeArray(obj.settings.custom)){if(!data.settings.custom.some(x=>x.id===c.id))data.settings.custom.push(c);}}
      for(const b of Object.values(data.boards)){b.posts=safeArray(b.posts).filter(p=>p&&p.id&&Array.isArray(p.comments)).slice(0,10000);b.residents=safeObj(b.residents);b.lastBatch=null;b.unread=0;}
      runEpoch++;cancelBusy();turnCount=0;
      const snap=data.settings.savedProfiles;
      profileCollectionActive=false;
      profileCache=snap?.user?{users:[copy(snap.user)],characters:copy(safeArray(snap.characters)),plot:null}:{users:[],characters:[],plot:null};
      profileDraftSelection=snap?.user?{userId:profileKey(snap.user),characterIds:safeArray(snap.characters).map(profileKey)}:{userId:'',characterIds:[]};
      await writeRoom(data);show('백업 복원이 완료됐어요.');settingsOpen=false;render();}catch(e){data=before;show('복원 실패: '+e.message);}}
  const safeObj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
  window.addEventListener('resize',applySize);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
  // Only expose non-sensitive diagnostic information. Authentication never leaves the Zeta page bridge.
  window.zetaAnonymousBoardDiagnostics=()=>({version:VERSION,room,turnCount,turns:observedTurns.length,auto:!!data?.settings.auto,community:data?.settings.selected,busy:!!busy,profileCandidates:{users:profileCache.users.length,characters:profileCache.characters.length},profileChosen:profileSelection().valid,started:!!data?.boards?.[data?.settings?.selected]?.started,baselineReady,seenTurns:seenTurnIds.size,activeTurnKey,turnEvents,autoStage,lastLiveSync,lastLatestRequest,turnMessagesSeen,turnPages,turnStatusError,lastTurnAnchor});
})();
