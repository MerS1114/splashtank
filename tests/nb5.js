const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const NB = process.argv[2] === 'nb';
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000);
 await pg.select('#scene', 'Meteor lake'); await wait(1500);
 await pg.evaluate(()=>document.querySelector('#s-res').closest('.row')._st.commit(0.08)); await wait(800);
 if (NB) await pg.evaluate(()=>{ const s=window.__splash; s.S.nbOn = true; s.resetSim(0); }); await wait(300);
 for (let k=1;k<=52;k++){ await pg.evaluate(()=>window.__splash.stepOnce()); if (k%4==0) await pg.evaluate(()=>window.__splash.getSim().dev.queue.onSubmittedWorkDone()); }
 for (let r=0;r<3;r++){
  const rows = await pg.evaluate(async()=>{ const s=window.__splash, sim=s.getSim(); await sim.dev.queue.onSubmittedWorkDone(); const o={}; for (const j of [2,4,5,6,8]) o[j]=(await sim.dbgRow(j, sim.nz>>1)); return {t:s.S.frame/60, rows:o}; });
  console.log(NB?'NB':'FULL', 't', rows.t.toFixed(3));
  for (const j in rows.rows) { const r=rows.rows[j]; console.log(' j='+j, r.slice(9,24).map(s=>{const q=s.split('/'); return q.length<5?'-':(q[0]+':'+q[2]+':'+(+q[3]).toFixed(1)+','+(+q[4]).toFixed(1));}).join(' ')); }
  await pg.evaluate(()=>window.__splash.stepOnce());
 }
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(async e=>{console.log('ERR',e.stack); process.exit(1);});
