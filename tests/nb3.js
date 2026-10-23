const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid|WGSL/i.test(t)) errs.push(t.slice(0,400));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000);
 await pg.select('#scene', 'Meteor lake'); await wait(1500);
 await pg.evaluate(()=>document.querySelector('#s-res').closest('.row')._st.commit(0.08)); await wait(800);
 await pg.evaluate((it)=>{ const s=window.__splash; s.S.nbOn = true; s.S.iters = it; s.resetSim(0); }, +(process.argv[2]||30)); await wait(300);
 const col = ()=>pg.evaluate(async()=>{ const sim=window.__splash.getSim(); await sim.dev.queue.onSubmittedWorkDone(); const c = await sim.dbgColumn(sim.nx>>1, sim.nz>>1); return c.filter(q=>q.j<10).map(q=>q.none?'-':(q.ty+'/'+q.phi+'/'+q.n+'/'+q.vy)).join('  '); });
 for (let k=0;k<=12;k++){ if (k) await pg.evaluate(()=>window.__splash.stepOnce()); console.log('step', k, await col()); }
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(async e=>{console.log('ERR',e.stack); process.exit(1);});
