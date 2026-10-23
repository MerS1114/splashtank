const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900});
 await pg.goto('file://'+PAGE); await wait(5000);
 for (let r=0;r<3;r++){
 await pg.click('#btn-reset'); await wait(300); await pg.click('#btn-play'); await wait(4000); await pg.click('#btn-play'); await wait(400);
 console.log(JSON.stringify(await pg.evaluate(()=>Object.assign(window.__splash.lc(),{frame:window.__splash.S.frame}))));
 await pg.evaluate(()=>{ const r=document.querySelector('#s-grav').closest('.row'); r._st.commit(8+Math.random()); }); await wait(300);
 }
 await br.close(); })();
