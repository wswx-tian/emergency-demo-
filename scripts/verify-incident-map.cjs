// 真实浏览器回归：刷新后立即开始，监控、点位和连线必须等待当前可见地图完成定位。
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=path.resolve(__dirname,'..');
const browserPath=process.env.CHROME_PATH||[
 'C:/Program Files/Google/Chrome/Application/chrome.exe',
 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(file=>fs.existsSync(file));
assert.ok(browserPath,'Chrome or Edge is required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'codex-incident-map-'));
const browser=spawn(browserPath,['--headless=new','--disable-gpu','--no-first-run',
 '--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',
 '--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
(async()=>{
 let socket,call,seq=0;const pending=new Map(),exceptions=[],report=[];
 try{
  const portFile=path.join(profile,'DevToolsActivePort');
  for(let n=0;!fs.existsSync(portFile)&&n<150;n++)await delay(50);
  assert.ok(fs.existsSync(portFile),'Browser debugging endpoint must start');
  const port=fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0];
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  socket=new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage=e=>{
   const m=JSON.parse(e.data);
   if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
   else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);
  };
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{
   const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
   if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
  const cases=[
   {name:'refresh-start-1x',speed:1,healthy:true},
   {name:'refresh-start-2x',speed:2,healthy:true},
   {name:'refresh-start-4x',speed:4,healthy:true},
   {name:'reset-during-zoom',speed:2,healthy:true,action:"setTimeout(()=>{reset();document.getElementById('btnGo').click();},350);"},
   {name:'resize-during-zoom',speed:2,healthy:true,resize:true},
   {name:'slow-tiles-fallback',speed:2,healthy:false,duration:5600},
   {name:'fallback-during-zoom',speed:2,healthy:false,action:'setTimeout(goFallback,350);'},
   {name:'start-before-window-load',speed:2,healthy:true,early:true},
   {name:'no-leaflet-fallback',speed:2,healthy:false,noLeaflet:true},
   {name:'portable-refresh-start',speed:2,healthy:true,entry:
    fs.existsSync(path.join(root,'应急物流仿真平台_跨设备便携版/index.html'))
     ?'应急物流仿真平台_跨设备便携版/index.html':'应急物流仿真平台 (15)-优化版.html'},
   {name:'real-tiles-refresh-start',speed:2,network:true,duration:5600}
  ];
  for(const test of cases){
   await call('Network.setBlockedURLs',{urls:test.network?[]:['https://*','http://*',...(test.noLeaflet?['*leaflet.js*']:[])]});
   await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
   let injection;
   if(test.early){
    injection=(await call('Page.addScriptToEvaluateOnNewDocument',{source:"document.addEventListener('DOMContentLoaded',()=>{S.muted=true;document.getElementById('btnGo').click();M._ok=4;window.__earlyStart=true;},{once:true});"})).identifier;
   }
   await call('Page.navigate',{url:pathToFileURL(path.join(root,test.entry||'index.html')).href+'?map-start-check='+Date.now()});
   let loaded=false;
   for(let n=0;n<150;n++){
    if(await evaluate("document.readyState==='complete'&&typeof S!=='undefined'&&typeof VIEW!=='undefined'")){loaded=true;break;}
    await delay(20);
   }
   assert.ok(loaded,test.name+': application must load');
   if(injection)await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection});
   const samplePromise=evaluate(`(async()=>{
    const initial={online:M.online,started:S.started,hasMap:!!M.map,early:!!window.__earlyStart};
    S.muted=true;S.cfg.speed=${test.speed};
    ${test.healthy?'M._ok=4;':''}
    if(!S.started)document.getElementById('btnGo').click();
    const begin=performance.now(),samples=[],invalid=[],movements=[];
    const movementStart=()=>movements.push({event:'start',ms:Math.round(performance.now()-begin)});
    const movementEnd=()=>movements.push({event:'end',ms:Math.round(performance.now()-begin),zoom:M.map.getZoom()});
    if(M.map){M.map.on('movestart',movementStart);M.map.on('moveend',movementEnd);}
    ${test.action||''}
    let active=true,lastSample=-100;
    const check=()=>{
     if(!active)return;
     const fallback=document.getElementById('mapWrap').classList.contains('fallback');
     const tile=document.querySelector('#incidentCameraFloatingLayer .incident-monitor-float');
     const videoVisible=!!tile&&getComputedStyle(tile).display!=='none'&&getComputedStyle(tile).visibility!=='hidden';
     const linksVisible=!!document.querySelector('#incidentCameraLinks circle');
     const box=document.getElementById('mapFallback').viewBox.baseVal,p=ALL[INCIDENT.epic];
     const zoom=M.map?.getZoom()??null;
     const distance=M.map?M.map.getCenter().distanceTo(L.latLng(ll(INCIDENT.epic))):null;
     const targetReached=fallback
      ?FB.focusId===INCIDENT.epic&&box.width===120&&box.height===108&&box.x===p.x-60&&box.y===p.y-54
      :!!M.map&&!M.moving&&Math.abs(zoom-INCIDENT.zoom)<.000001&&distance<1;
     const state={ms:Math.round(performance.now()-begin),fallback,online:M.online,zoom,distance,moving:M.moving,
      targetReached,mapFocusReady:S.incident.mapFocusReady,videoVisible,linksVisible,step:S.step};
     if((videoVisible||linksVisible)&&!targetReached)invalid.push(state);
     if(state.ms-lastSample>=50){samples.push(state);lastSample=state.ms;}
     requestAnimationFrame(check);
    };
    check();await new Promise(resolve=>setTimeout(resolve,${test.duration||3300}));active=false;
    if(M.map){M.map.off('movestart',movementStart);M.map.off('moveend',movementEnd);}
    return {initial,samples,invalid,movements};
   })()`);
   if(test.resize){await delay(500);await call('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});}
   const result=await samplePromise;
   report.push({test:test.name,...result});
   assert.equal(result.invalid.length,0,test.name+': overlays appeared before the visible map completed focus: '+JSON.stringify(result.invalid[0]));
   assert.ok(result.samples.some(s=>s.videoVisible&&s.linksVisible),test.name+': monitoring overlays must eventually appear');
   if(test.early)assert.equal(result.initial.early,true,'Must start before window.load');
   if(test.noLeaflet)assert.equal(result.initial.hasMap,false,'Must exercise missing Leaflet fallback');
   if(test.name==='slow-tiles-fallback')assert.ok(result.samples.some(s=>s.fallback&&s.videoVisible&&s.linksVisible),'Fallback must retain correctly focused overlays');
   if(test.healthy&&!test.early)assert.equal(result.initial.online,false,'Must start before delayed tile health confirmation');
   const first=result.samples.find(s=>s.videoVisible);
   console.log(`PASS ${test.name}: monitoring at ${first.ms}ms, ${first.fallback?'focused fallback':'zoom '+first.zoom}`);
   if(test.network){
    const shot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(root,'.backups/incident-map-after.png'),Buffer.from(shot.data,'base64'));
   }
  }
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));
  fs.writeFileSync(path.join(root,'.backups/incident-map-report.json'),JSON.stringify({cases:report,runtimeExceptions:exceptions},null,2));
  console.log(`PASS: ${report.length} browser scenarios; no early overlays or runtime exceptions.`);
 }finally{
  if(call)try{await call('Browser.close');}catch{}
  if(socket)socket.close();
  if(browser.exitCode===null)browser.kill();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
