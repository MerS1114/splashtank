const {PAGE, OUT} = require('./paths');
const { launch, pageUrl } = require('./browser');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const br=await launch();
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900});
 await pg.goto(pageUrl(PAGE)); await wait(5000);
 for (let r=0;r<3;r++){
 await pg.click('#btn-reset'); await wait(300); await pg.click('#btn-play'); await wait(4000); await pg.click('#btn-play'); await wait(400);
 console.log(JSON.stringify(await pg.evaluate(()=>Object.assign(window.__splash.lc(),{frame:window.__splash.S.frame}))));
 await pg.evaluate(()=>{ const r=document.querySelector('#s-grav').closest('.row'); r._st.commit(8+Math.random()); }); await wait(300);
 }
 await br.close(); })();
