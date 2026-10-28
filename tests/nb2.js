const {PAGE, OUT} = require('./paths');
const { launch, pageUrl } = require('./browser');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const NB = process.argv[2] === 'nb', ITERS = +(process.argv[6] || 30), SC = process.argv[3] || 'Meteor lake', STEPS = +(process.argv[4] || 90), SPACING = +(process.argv[5] || 0.08);
(async()=>{ const br=await launch();
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid|WGSL/i.test(t)) errs.push(t.slice(0,400));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto(pageUrl(PAGE)); await wait(5000);
 await pg.select('#scene', SC); await wait(1500);
 await pg.evaluate((sp)=>document.querySelector('#s-res').closest('.row')._st.commit(sp), SPACING); await wait(800);
 await pg.evaluate((it, bd, dbg)=>{ window.__splash.S.iters = it; window.__band = bd; window.__dbg = +dbg; }, ITERS, +(process.argv[7]||3), +(process.argv[8]||0));
 if (process.argv[9]) await pg.evaluate((hh)=>{ const s=window.__splash; s.S.ocean.height = hh; s.resetSim(0); }, +process.argv[9]);
 await pg.evaluate((dbg)=>{ window.__splash.getSim().dbgFlags = dbg; }, +(process.argv[8]||0));
 if (NB) { await pg.evaluate(()=>{ const s=window.__splash; s.S.nbOn = true; s.S.nbBand = +(window.__band||3); s.resetSim(0); s.getSim().dbgFlags = window.__dbg||0; }); await wait(300); }
 const stats = ()=>pg.evaluate(async()=>{ const s=window.__splash, sim=s.getSim(); const buf=new Float32Array(sim.MAXN*4); const n=await sim.readbackInto(buf);
   let alive=0, ys=[], sp=[]; for(let i=0;i<n;i++){ const y=buf[i*4+1]; if(y<-1e5) continue; alive++; ys.push(y); const w=buf[i*4+3]; sp.push(w-64*Math.floor(w/64)); } ys.sort((a,b)=>a-b); sp.sort((a,b)=>a-b); const qs=(f)=>sp.length?+sp[Math.min(sp.length-1,Math.floor(f*sp.length))].toFixed(2):0;
   const q=(f)=>ys.length?+ys[Math.min(ys.length-1,Math.floor(f*ys.length))].toFixed(3):0;
   return { t:+(s.S.frame/60).toFixed(2), N:n, alive, y50:q(0.5), y95:q(0.95), y99:q(0.995), ymin:q(0), up1:ys.filter(y=>y>1.0).length, up15:ys.filter(y=>y>1.5).length, ytop:q(1), s99:qs(0.99), s999:qs(0.999), smax:qs(1), fluid: sim.stats&&sim.stats.fluid, blocks: sim.stats&&sim.stats.sc, ms:+sim.lastMs.toFixed(0) }; });
 console.log(SC, NB?'NARROW BAND':'FULL', 'spacing', SPACING, 'iters', ITERS, JSON.stringify(await stats()));
 for (let k=1;k<=STEPS;k++){ await pg.evaluate(()=>window.__splash.stepOnce()); if (k%3===0) await pg.evaluate(()=>window.__splash.getSim().dev.queue.onSubmittedWorkDone());
   if (k%30===0) console.log(JSON.stringify(await stats())); }
 await pg.screenshot({path:OUT+'/nb_'+(NB?'on':'off')+'_'+SC.replace(/ /g,'')+'_'+ITERS+'.png'});
 console.log('errs', JSON.stringify(errs.slice(0,6)));
 await br.close(); })().catch(e=>console.log('ERR',e.stack));
