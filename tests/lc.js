const {PAGE, OUT} = require('./paths');
const { launch, pageUrl } = require('./browser');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const br=await launch();
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid/.test(t)) errs.push(t.slice(0,200));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto(pageUrl(PAGE)); await wait(5000);
 const st=()=>pg.evaluate(()=>{const s=window.__splash; return Object.assign(s.lc(),{frame:s.S.frame, N:s.getSim().N, tlt:+s.S.tl.t.toFixed(2), sub:s.S.lastSub, playing:s.S.playing, info:(document.querySelector('#lc-info')||{}).textContent, bar:(document.querySelector('#lc-bar')||{}).style?.width});});
 // coarse spacing so it runs quickly here
 await pg.evaluate(()=>{ const i=document.querySelector('#s-res'); i.value=Math.round(1000*Math.log(0.08/0.01)/Math.log(16)); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); });
 await wait(1500);
 await pg.click('#btn-reset'); await wait(300);
 console.log('armed', JSON.stringify(await st()));
 await pg.click('#btn-play'); await wait(12000);
 console.log('after run', JSON.stringify(await st()));
 await pg.click('#btn-play'); await wait(300);   // stop
 const before=await st();
 await pg.click('#btn-reset'); await wait(500);
 console.log('reset -> playback', JSON.stringify(await st()));
 await pg.screenshot({path:OUT+'/lc_play.png'});
 await pg.click('#btn-play'); await wait(4000);
 console.log('playing back', JSON.stringify(await st()));
 await wait(Math.max(0, (before.end/60)*1000 - 3000)); await wait(3000);
 console.log('after cache end', JSON.stringify(await st()));
 // change gravity: cache must clear
 await pg.evaluate(()=>{ const i=document.querySelector('#s-grav'); i.value=9.0; i.dispatchEvent(new Event('input',{bubbles:true})); });
 await wait(300);
 console.log('after edit', JSON.stringify(await st()));
 // fast keyframed cube: substeps should rise while it moves and drop after
 await pg.click('#btn-play'); await wait(200);
 await pg.evaluate(()=>{ const s=window.__splash; const c=s.objs.find(o=>o.kind==='mesh'); s.S.colMax=200; c.keys=[{t:0,x:-1.2,y:0.5,z:0,rx:0,yaw:0,rz:0},{t:0.3,x:-1.2,y:0.5,z:0,rx:0,yaw:0,rz:0},{t:0.6,x:1.2,y:0.5,z:0,rx:0,yaw:0,rz:0}]; s.S.tl.smooth=false; s.resetSim(0); s.S.playing=true; });
 const subs=[]; for(let k=0;k<30;k++){ await wait(250); subs.push(await pg.evaluate(()=>[window.__splash.S.frame, window.__splash.S.lastSub, +(window.__splash.getSim().stats?.vmax||0).toFixed(2)])); }
 console.log('frame,substeps,vmax', JSON.stringify(subs));
 console.log('errs', JSON.stringify(errs.slice(0,5)));
 await br.close(); })().catch(e=>console.log('ERR',e.stack));
