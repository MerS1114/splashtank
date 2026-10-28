const {PAGE, OUT} = require('./paths');
const { launch, pageUrl } = require('./browser');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const br=await launch();
 const pg=await br.newPage(); await pg.setViewport({width:1440,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid/.test(t)) errs.push(t.slice(0,300));}); pg.on('pageerror',e=>errs.push('PAGE '+e.message));
 await pg.goto(pageUrl(PAGE)); await wait(6000);
 const ev=(f,...a)=>pg.evaluate(f,...a);
 // 1. click-drag on an object selects but never moves it
 await ev(()=>{ const s=window.__splash; s.select(null); }); await wait(200);
 const c = await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); const p=s.toScreen(o.target); return {x:p.x,y:p.y,t:[o.target.x,o.target.y,o.target.z]}; });
 await pg.mouse.move(c.x,c.y); await pg.mouse.down(); for(let k=1;k<=10;k++){ await pg.mouse.move(c.x+k*12,c.y+k*6); await wait(20);} await pg.mouse.up(); await wait(300);
 console.log('drag on object', JSON.stringify(await ev((t0)=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); return {moved: Math.hypot(o.target.x-t0[0],o.target.y-t0[1],o.target.z-t0[2]).toFixed(4), tf: !!s.tf, sel: s.selSet.size}; }, c.t)));
 await pg.mouse.click(c.x,c.y); await wait(200);
 console.log('click selects', await ev(()=>{ const s=window.__splash; return [...s.selSet].map(o=>o.name).join(','); }));
 // 2. gizmo: tools and size on screen
 await pg.click('#shelf [data-tool=move]'); await wait(400);
 console.log('move tool', JSON.stringify(await ev(()=>{ const s=window.__splash, g=s.gizmo; const p=g.position.clone(), a=s.toScreen(p), q=s.toScreen(p.clone().add(new THREE.Vector3(g.scale.x,0,0))); return {vis:g.visible, px: Math.round(Math.hypot(q.x-a.x,q.y-a.y)), parts: g.children.filter(m=>m.visible && m.material.opacity>0).length}; })));
 await pg.screenshot({path:OUT+'/u5_move.png'});
 await pg.click('#shelf [data-tool=rotate]'); await wait(300); await pg.screenshot({path:OUT+'/u5_rot.png'});
 await pg.click('#shelf [data-tool=select]'); await wait(200);
 // 3. snapping: Ctrl flips the snap, vertex onto the box corner (front view)
 await ev(()=>window.__splash.snapView('front')); await wait(1500);
 const r = await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); s.select(o); const B=s.b; const corner=new THREE.Vector3(B.x1,B.y0,B.z1); const sc=s.toScreen(corner);
   s.lastM.x=sc.x-80; s.lastM.y=sc.y-60; s.lastM.ctrl=false; s.startTf('g'); s.lastM.x=sc.x+3; s.lastM.y=sc.y-2; s.lastM.ctrl=true; s.evalTf(); const t=s.tfState;
   o.group.updateMatrixWorld(true); let md=1e9; o.mesh.v.forEach(q=>{ const w=new THREE.Vector3(q[0],q[1],q[2]).applyMatrix4(o.group.matrixWorld); md=Math.min(md,w.distanceTo(corner)); });
   const out={snap: !!t.snapAt, md:+md.toFixed(5)}; s.lastM.ctrl=false; s.confirmTf(); return out; });
 console.log('ctrl vertex snap', JSON.stringify(r));
 // snapping while the sim runs (objects lag behind their target) and with the magnet on, edge centre mode
 await pg.click('#btn-play'); await wait(1500);
 const r2 = await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); s.select(o); s.setSnap(true); s.S.snapTo='edge'; const B=s.b; const tgt=new THREE.Vector3((B.x0+B.x1)/2,B.y0,B.z1); const sc=s.toScreen(tgt);
   s.lastM.x=sc.x-60; s.lastM.y=sc.y-90; s.lastM.ctrl=false; s.startTf('g'); s.lastM.x=sc.x+2; s.lastM.y=sc.y+1; s.evalTf(); const t=s.tfState;
   const src=t._src; let md=1e9; const d=t.d; src.forEach(p=>{ md=Math.min(md,p.clone().add(d).distanceTo(tgt)); });
   const out={snap: !!t.snapAt, at: t.snapAt && [t.snapAt.x,t.snapAt.y,t.snapAt.z].map(v=>+v.toFixed(3)), md:+md.toFixed(5)}; s.confirmTf(); s.setSnap(false); s.S.snapTo='vertex'; return out; });
 console.log('magnet edge snap while playing', JSON.stringify(r2));
 await pg.click('#btn-play'); await wait(300);
 // 4. local vs global scale on a turned cube
 const sc = await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); s.select(o); o.yaw=Math.PI/4; o.rx=0; o.rz=0; const ext=(o)=>{ const R=[[1,0,0],[0,1,0],[0,0,1]]; let lx=[1e9,-1e9]; o.mesh.v.forEach(q=>{ lx[0]=Math.min(lx[0],q[0]); lx[1]=Math.max(lx[1],q[0]); }); return +((lx[1]-lx[0])*(o.sx||1)).toFixed(3); };
   const e0=ext(o);
   s.setOrient('local'); s.startTf('s',{axis:'x'}); for(const k of ['2','Enter']) s.modalKey(new KeyboardEvent('keydown',{key:k})); const eL=ext(o);
   s.undo(); const o2=s.objs.find(q=>q.kind==='mesh'); o2.yaw=Math.PI/4; s.select(o2);
   s.setOrient('global'); s.startTf('s',{axis:'x'}); for(const k of ['2','Enter']) s.modalKey(new KeyboardEvent('keydown',{key:k}));
   const o3=s.objs.find(q=>q.kind==='mesh'); const wx=[1e9,-1e9]; o3.mesh.v.forEach(q=>{ const c=Math.cos(o3.yaw), sn=Math.sin(o3.yaw); const x=c*q[0]+sn*q[2]; wx[0]=Math.min(wx[0],x); wx[1]=Math.max(wx[1],x); });
   return {e0, local:eL, globalLocalX:ext(o3), scaleLocal:[o3.sx,o3.sy,o3.sz].map(v=>+v.toFixed(3))}; });
 console.log('scale local/global', JSON.stringify(sc));
 await ev(()=>window.__splash.undo()); await wait(200);
 // 5. edit mode looks
 await ev(()=>{ const s=window.__splash; s.snapView('front'); }); await wait(200);
 await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); s.select(o); s.cam.r=3.2; s.cam.target.set(o.target.x,o.target.y,o.target.z); s.cam.theta=0.7; s.cam.phi=1.0; s.setOrtho(false); s.enterEdit(o); s.setSelMode('v'); s.ES.v.add(0); s.ES.v.add(1); }); await wait(600);
 await pg.screenshot({path:OUT+'/u5_ed_v.png'});
 await ev(()=>{ const s=window.__splash; s.setSelMode('e'); }); await wait(400); await pg.screenshot({path:OUT+'/u5_ed_e.png'});
 await ev(()=>{ const s=window.__splash; s.setSelMode('f'); s.ES.f.add(0); s.selectAllEdit; }); await wait(400); await pg.screenshot({path:OUT+'/u5_ed_f.png'});
 await ev(()=>window.__splash.exitEdit()); await wait(200);
 // 6. keyframes: double-click a key goes to its frame
 const kk = await ev(()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); s.select(o); s.addKey(o, 0); s.S.tl.t=2; s.addKey(o, 2); s.S.tl.t=0; return o.keys.length; });
 await wait(300);
 const kb = await ev(()=>{ const ks=[...document.querySelectorAll('.kf-key')]; const k=ks.find(e=>Math.abs(e._k.t-2)<1e-6); const r=k.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; });
 await pg.mouse.click(kb.x,kb.y); await wait(120);
 const kb2 = await ev(()=>{ const ks=[...document.querySelectorAll('.kf-key')]; const k=ks.find(e=>Math.abs(e._k.t-2)<1e-6); const r=k.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; });
 await pg.mouse.click(kb2.x,kb2.y); await wait(400);
 console.log('dblclick key', JSON.stringify(await ev(()=>({t:window.__splash.S.tl.t, keys:window.__splash.objs.find(q=>q.kind==='mesh').keys.map(k=>k.t)}))));
 // 7. splitter
 const w0 = await ev(()=>document.querySelector('#rightcol').offsetWidth);
 const sp = await ev(()=>{ const r=document.querySelector('#sp-right').getBoundingClientRect(); return {x:r.x+2,y:r.y+200}; });
 await pg.mouse.move(sp.x,sp.y); await pg.mouse.down(); await pg.mouse.move(sp.x-100,sp.y,{steps:5}); await pg.mouse.up(); await wait(300);
 const tl0 = await ev(()=>document.querySelector('#kf-body').offsetHeight);
 const st = await ev(()=>{ const r=document.querySelector('#sp-tl').getBoundingClientRect(); return {x:r.x+300,y:r.y+2}; });
 await pg.mouse.move(st.x,st.y); await pg.mouse.down(); await pg.mouse.move(st.x,st.y-60,{steps:5}); await pg.mouse.up(); await wait(300);
 console.log('splitters', JSON.stringify(await ev((a)=>({rw0:a[0], rw:document.querySelector('#rightcol').offsetWidth, kf0:a[1], kf:document.querySelector('#kf-body').offsetHeight, ls: localStorage.getItem('splashtank.lay')}), [w0, tl0])));
 // 8. slider drag and click to type
 await pg.click('#ptabs [data-ptab=sim]'); await wait(200);
 await ev(()=>document.querySelector('#s-grav').scrollIntoView({block:'center'})); await wait(200);
 const gb = await ev(()=>{ const r=document.querySelector('#s-grav').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}; });
 const g0 = await ev(()=>window.__splash.S.g);
 await pg.mouse.move(gb.x,gb.y); await pg.mouse.down(); await pg.mouse.move(gb.x+40,gb.y,{steps:6}); await pg.mouse.up(); await wait(200);
 const g1 = await ev(()=>window.__splash.S.g);
 await pg.mouse.click(gb.x,gb.y); await wait(200);
 console.log('slider', JSON.stringify({g0, g1, typing: await ev(()=>!!document.querySelector('.num input.typed'))}));
 await pg.keyboard.press('Escape'); await wait(100);
 await pg.screenshot({path:OUT+'/u5_panel.png'});
 // 9. menus
 await pg.click('.menus [data-menu=view]'); await wait(200);
 console.log('view menu', JSON.stringify(await ev(()=>[...document.querySelectorAll('#menu button')].map(b=>b.textContent))));
 await pg.screenshot({path:OUT+'/u5_menu.png'});
 await pg.keyboard.press('Escape'); await wait(100);
 console.log('errs', JSON.stringify(errs.slice(0,10)));
 await br.close();
})().catch(e=>console.log('ERR',e.stack));
