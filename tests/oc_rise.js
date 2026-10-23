const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid|WGSL/i.test(t)) errs.push(t.slice(0,300));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000);
 await pg.select('#scene', 'Ocean'); await wait(2500);
 await pg.evaluate(()=>document.querySelector('#s-res').closest('.row')._st.commit(0.06)); await wait(1000);
 await pg.evaluate(()=>{ const s=window.__splash; s.cam.theta=0.55; s.cam.phi=1.3; s.cam.r=11; });
 for (let k=1;k<=390;k++){ await pg.evaluate(()=>window.__splash.stepOnce()); if (k%5===0) await pg.evaluate(()=>window.__splash.getSim().dev.queue.onSubmittedWorkDone());
   if (k===240 || k===390) { await wait(1200); await pg.screenshot({path:OUT+'/oc_rise_'+k+'.png'}); console.log('t', k/60, JSON.stringify(await pg.evaluate(()=>{ const sim=window.__splash.getSim(); return {N:sim.N, fluid: sim.stats&&sim.stats.fluid}; }))); } }
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(async e=>{console.log('ERR',e.stack); process.exit(1);});
