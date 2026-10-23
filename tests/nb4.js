const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000);
 await pg.select('#scene', 'Meteor lake'); await wait(1500);
 await pg.evaluate(()=>document.querySelector('#s-res').closest('.row')._st.commit(0.08)); await wait(800);
 await pg.evaluate(()=>{ const s=window.__splash; s.S.nbOn = true; s.resetSim(0); }); await wait(300);
 for (let k=1;k<=8;k++){ await pg.evaluate(()=>window.__splash.stepOnce()); }
 const rows = await pg.evaluate(async()=>{ const sim=window.__splash.getSim(); await sim.dev.queue.onSubmittedWorkDone(); const o={}; for (const j of [1,3,5,6]) o[j]=(await sim.dbgRow(j, sim.nz>>1)); return {nx:sim.nx, ny:sim.ny, rows:o}; });
 console.log('nx', rows.nx, 'ny', rows.ny);
 for (const j in rows.rows) { const r=rows.rows[j]; console.log('j='+j, r.slice(0,5).join('  '), ' ... ', r.slice(14,18).join('  '), ' ... ', r.slice(-5).join('  ')); }
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(async e=>{console.log('ERR',e.stack); process.exit(1);});
