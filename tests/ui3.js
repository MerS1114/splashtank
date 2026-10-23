const {PAGE, OUT} = require('./paths');
const chromium=require('@sparticuz/chromium').default; const puppeteer=require('puppeteer-core');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const exe=await chromium.executablePath();
 const br=await puppeteer.launch({executablePath:exe,args:[...chromium.args,'--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--ignore-gpu-blocklist','--allow-file-access-from-files'],headless:'shell'});
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid/.test(t)) errs.push(t.slice(0,200));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto('file://'+PAGE); await wait(5000); console.log('loaded', JSON.stringify(errs.slice(0,3)));
 const S=()=>pg.evaluate(()=>window.__splash.S);
 console.log('panel', JSON.stringify(await pg.evaluate(()=>({subs:[...document.querySelectorAll('details.sub')].map(d=>d.dataset.k+(d.open?'+':'-')), closed:[...document.querySelectorAll('.group.closed')].map(g=>g.id), status:document.querySelector('#st-hints').textContent, right:document.querySelector('#st-right').textContent, subtitle:document.querySelector('#subtitle').textContent, pos:[...document.querySelectorAll('#g-sim .pos')].map(p=>p.id)}))));
 await pg.screenshot({path:OUT+'/u3_start.png'});
 // tooltip on Gravity
 await pg.evaluate(()=>document.querySelector('#s-grav').scrollIntoView({block:'center'})); await wait(300);
 const lab = await pg.$('label[for=s-grav]'); const lb=await lab.boundingBox();
 await pg.mouse.move(lb.x+10, lb.y+5); await wait(800);
 console.log('tooltip', JSON.stringify(await pg.evaluate(()=>({vis:!document.querySelector('#tip').hidden, text:document.querySelector('#tip').textContent.slice(0,160), status:document.querySelector('#st-hints').textContent}))));
 await pg.screenshot({path:OUT+'/u3_tip.png'});
 // type a value -> bold label
 await pg.click('#s-grav ~ output'); await wait(200); await pg.keyboard.type('5'); await pg.keyboard.press('Enter'); await wait(200);
 console.log('typed', JSON.stringify(await pg.evaluate(()=>({g:window.__splash.S.g, nd:document.querySelector('#s-grav').closest('.row').classList.contains('nd')}))));
 // right-click menu, reset
 await pg.mouse.click(lb.x+10, lb.y+5, {button:'right'}); await wait(300);
 console.log('ctx', JSON.stringify(await pg.evaluate(()=>({vis:!document.querySelector('#ctx').hidden, items:[...document.querySelectorAll('#ctx button')].map(b=>b.textContent+(b.disabled?' [off]':''))}))));
 await pg.screenshot({path:OUT+'/u3_ctx.png'});
 await pg.click('#ctx button[data-a=reset]'); await wait(200);
 console.log('after reset', JSON.stringify(await pg.evaluate(()=>({g:window.__splash.S.g, nd:document.querySelector('#s-grav').closest('.row').classList.contains('nd'), ctx:!document.querySelector('#ctx').hidden}))));
 // hover + Backspace reset, Ctrl+C / Ctrl+V
 await pg.click('#s-grav ~ output'); await wait(150); await pg.keyboard.type('12'); await pg.keyboard.press('Enter'); await wait(150);
 await pg.mouse.move(lb.x+10, lb.y+5); await wait(100); await pg.keyboard.press('Backspace'); await wait(150);
 console.log('backspace reset g=', (await S()).g);
 await pg.keyboard.down('Control'); await pg.keyboard.press('c'); await pg.keyboard.up('Control');
 const lf = await (await pg.$('label[for=s-flip]')).boundingBox(); console.log('flip label y', lf.y); await pg.mouse.move(lf.x+10, lf.y+5); await wait(100);
 await pg.keyboard.down('Control'); await pg.keyboard.press('v'); await pg.keyboard.up('Control'); await wait(150);
 console.log('pasted 9.8 into FLIP ratio (clamps to 1):', (await S()).flip);
 await pg.keyboard.press('Backspace'); await wait(100); console.log('flip back', (await S()).flip);
 // search
 await pg.mouse.move(700,400); await pg.keyboard.press('F3'); await wait(100);
 console.log('F3 focus', await pg.evaluate(()=>document.activeElement.id));
 await pg.keyboard.type('spray'); await wait(300);
 console.log('search spray', JSON.stringify(await pg.evaluate(()=>({rows:[...document.querySelectorAll('.panel .group .row, .panel .group label.check')].filter(r=>r.offsetParent).map(r=>(r.querySelector('label')||r).textContent.trim()), subs:[...document.querySelectorAll('details.sub')].filter(d=>d.offsetParent).map(d=>d.dataset.k)}))));
 await pg.screenshot({path:OUT+'/u3_search.png'});
 await pg.keyboard.press('Escape'); await wait(200);
 console.log('search cleared', JSON.stringify(await pg.evaluate(()=>({subs:[...document.querySelectorAll('details.sub')].map(d=>d.dataset.k+(d.open?'+':'-')), visible:[...document.querySelectorAll('.panel .group .row')].filter(r=>r.offsetParent).length}))));
 // Shift+A
 const n0=await pg.evaluate(()=>window.__splash.objs.length);
 await pg.mouse.move(500,350); await wait(50); await pg.keyboard.down('Shift'); await pg.keyboard.press('A'); await pg.keyboard.up('Shift'); await wait(300);
 console.log('add menu', JSON.stringify(await pg.evaluate(()=>{ const m=document.querySelector('#addmenu'); const r=m.getBoundingClientRect(); return {vis:!m.hidden, x:Math.round(r.left), y:Math.round(r.top), focus:document.activeElement.textContent.trim(), items:[...m.querySelectorAll('button')].map(b=>b.textContent.trim())}; })));
 await pg.screenshot({path:OUT+'/u3_add.png'});
 await pg.keyboard.press('ArrowDown'); await wait(50); console.log('arrow focus', await pg.evaluate(()=>document.activeElement.textContent.trim()));
 await pg.click('#addmenu button[data-v=cube][data-water]'); await wait(800);
 console.log('added', JSON.stringify(await pg.evaluate((n0)=>({n:window.__splash.objs.length-n0, water:window.__splash.objs[window.__splash.objs.length-1].water, menu:!document.querySelector('#addmenu').hidden}), n0)));
 await pg.click('#btn-add'); await wait(200); console.log('panel add button opens menu', await pg.evaluate(()=>!document.querySelector('#addmenu').hidden));
 await pg.mouse.click(700,300); await wait(200); console.log('closed on click away', await pg.evaluate(()=>document.querySelector('#addmenu').hidden));
 await pg.evaluate(()=>window.__splash.undo()); await wait(300);
 // live cache lanes
 await pg.click('#btn-reset'); await wait(300); await pg.click('#btn-play'); await wait(9000); await pg.click('#btn-play'); await wait(500);
 const lane=()=>pg.evaluate(()=>{ const g=(id)=>{const e=document.getElementById(id); return e.hidden?0:Math.round(parseFloat(e.style.width)||0);}; return {lc:g('lc-bar'), stale:g('lc-stale'), bake:g('bk-bar'), right:document.querySelector('#st-right').textContent, info:(document.querySelector('#lc-info')||{}).textContent}; });
 console.log('after run', JSON.stringify(await lane()));
 await pg.screenshot({path:OUT+'/u3_cached.png'});
 await pg.click('#s-grav ~ output'); await wait(150); await pg.keyboard.type('7'); await pg.keyboard.press('Enter'); await wait(300);
 console.log('after change', JSON.stringify(await lane()));
 await pg.screenshot({path:OUT+'/u3_stale.png'});
 await pg.click('#btn-reset'); await wait(300); await pg.click('#btn-play'); await wait(4000); await pg.click('#btn-play'); await wait(400);
 console.log('re-simulating', JSON.stringify(await lane()));
 // bake: unified settings
 await pg.click('#seg-mode button[data-v=bake]'); await wait(300);
 console.log('bake panel', JSON.stringify(await pg.evaluate(()=>({sliders:[...document.querySelectorAll('#g-bake .row label')].map(l=>l.textContent), res:document.querySelector('#bake-res').textContent, simVisible:!!document.querySelector('#g-sim').offsetParent, r:window.__splash.bakeRes(), liveD:window.__splash.S.liveD, cap:window.__splash.S.cap}))));
 await pg.screenshot({path:OUT+'/u3_bakepanel.png'});
 await pg.click('#seg-bkdetail button[data-v="2"]'); await wait(200);
 console.log('2x finer', JSON.stringify(await pg.evaluate(()=>({res:document.querySelector('#bake-res').textContent, r:window.__splash.bakeRes()}))));
 await pg.click('#seg-bkdetail button[data-v="1"]'); await wait(100);
 await pg.evaluate(()=>{ const s=document.querySelector('#b-dur'); s.value=1; s.dispatchEvent(new Event('input',{bubbles:true})); });
 await pg.click('#btn-bake'); await wait(1500);
 console.log('baking', JSON.stringify(await pg.evaluate(()=>({prog:document.getElementById('bk-prog').hidden?0:document.getElementById('bk-prog').style.width, status:document.querySelector('#bake-status').textContent, right:document.querySelector('#st-right').textContent}))));
 for (let i=0;i<120;i++){ await wait(1000); if (!(await pg.evaluate(()=>window.__splash.S.baking))) break; }
 console.log('baked', JSON.stringify(await pg.evaluate(()=>({status:document.querySelector('#bake-status').textContent, cache:!!window.__splash.S.cache, d:window.__splash.S.cache&&window.__splash.S.cache.d}))));
 await pg.click('#seg-mode button[data-v=live]'); await wait(400);
 console.log('live with bake', JSON.stringify(await lane()));
 await pg.screenshot({path:OUT+'/u3_baked.png'});
 const bb = await pg.evaluate(()=>{ const r=document.getElementById('bk-bar').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width}; });
 await pg.mouse.click(bb.x, bb.y); await wait(500);
 console.log('click purple -> bake playback', JSON.stringify(await pg.evaluate(()=>({tab:window.__splash.S.tab, status:document.querySelector('#st-hints').textContent.slice(0,60)}))));
 console.log('errs', JSON.stringify(errs.slice(0,8)));
 await br.close(); })().catch(e=>console.log('ERR',e.stack));
