const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid|WGSL/i.test(t)) errs.push(t.slice(0,300));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000);
 await pg.select('#scene', 'Dam break'); await wait(2500);
 await pg.evaluate(()=>{ const s=window.__splash.S; s.nbOn=true; s.nbLook=true; window.__splash.resetSim(0); }); await wait(1500);
 await pg.click('#seg-mode button[data-v=bake]'); await wait(300);
 await pg.evaluate(()=>{ const s=document.querySelector('#b-dur'); s.value=1; s.dispatchEvent(new Event('input',{bubbles:true})); });
 await pg.click('#btn-bake'); const t0=Date.now(); let st='';
 while(Date.now()-t0<600000){ await wait(3000); st=await pg.evaluate(()=>document.querySelector('#bake-status').textContent); if(/Baked|failed|cancel/.test(st)) break; }
 console.log('bake', st.slice(0,200));
 const info = await pg.evaluate(()=>{ const c=window.__splash.S.cache; const f=c.frames; const dps=f.map(x=>x.dp?x.dp.n:0);
   const parts=writeCacheParts(c); const tot=parts.reduce((a,p)=>a+p.byteLength,0); const buf=new Uint8Array(tot); let o=0; for(const p of parts){ buf.set(new Uint8Array(p.buffer,p.byteOffset,p.byteLength),o); o+=p.byteLength; }
   const back=parseCache(buf.buffer); const dps2=back.frames.map(x=>x.dp?x.dp.n:0); const same = back.frames.every((x,i)=>x.n===f[i].n) && JSON.stringify(dps)===JSON.stringify(dps2);
   const a=f[f.length-1].dp, b=back.frames[f.length-1].dp; let eq = !a || (a.pos.every((v,i)=>v===b.pos[i]) && a.spd.every((v,i)=>v===b.spd[i]));
   return { F:f.length, dps: dps.slice(0,6).concat(['…', dps[dps.length-1]]), nbLook:c.desc.nbLook, roundtrip: same && eq }; });
 console.log('cache', JSON.stringify(info));
 await pg.evaluate(()=>{ window.__splash.S.ct = 20; window.__splash.snapView('front'); }); await wait(1500);
 console.log('draw', await pg.evaluate(()=>window.__splash.drawCount()));
 await pg.screenshot({path:OUT+'/dp_bake.png'});
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(async e=>{console.log('ERR',e.stack); process.exit(1);});
