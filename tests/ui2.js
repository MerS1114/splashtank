const {PAGE, OUT} = require('./paths');
const { launch, pageUrl } = require('./browser');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const br=await launch();
 const pg=await br.newPage(); await pg.setViewport({width:1400,height:900}); const errs=[]; pg.on('console',m=>{const t=m.text(); if(/rror|nvalid/.test(t)) errs.push(t.slice(0,200));}); pg.on('pageerror',e=>errs.push(e.message));
 await pg.goto(pageUrl(PAGE)); await wait(5000); console.log('loaded', JSON.stringify(errs.slice(0,3)));
 // 1. typed slider value
 await pg.click('#s-grav ~ output'); await wait(200); await pg.keyboard.type('5.37'); await pg.keyboard.press('Enter'); await wait(200);
 console.log('typed gravity', await pg.evaluate(()=>[window.__splash.S.g, document.querySelector('#s-grav ~ output').textContent]));
 // 2. axis widget: click the +X ball
 const ball = await pg.evaluate(()=>{ const c=document.querySelector('#axisgiz').getBoundingClientRect(); return {x:c.left, y:c.top, w:c.width}; });
 // find +x ball by scanning: use the exposed snapView instead, then check the widget redraw and ortho state
 await pg.evaluate(()=>window.__splash.snapView('front')); await wait(1500);
 console.log('front view', await pg.evaluate(()=>({ortho:window.__splash.S.ortho, cam: window.__splash.getCam().type, theta:+window.__splash.cam.theta.toFixed(3), phi:+window.__splash.cam.phi.toFixed(3)})));
 await pg.screenshot({path:OUT+'/ui_front.png'});
 // click the middle of the widget toggles back to perspective
 await pg.mouse.click(ball.x+ball.w/2, ball.y+ball.w/2); await wait(400);
 console.log('after middle click', await pg.evaluate(()=>window.__splash.S.ortho));
 // click whatever ball is at the top-ish area: test the click path by clicking each ball position
 const balls = await pg.evaluate(()=>{ return [...Array(1)].map(()=>0); });
 // 3. axis line while moving with an axis lock
 await pg.evaluate(()=>{ const s=window.__splash; s.select(s.objs.find(o=>o.kind==='mesh')); });
 await pg.mouse.move(600,400); await wait(100);
 await pg.keyboard.press('g'); await wait(100); await pg.mouse.move(650,420); await pg.keyboard.press('x'); await wait(300);
 console.log('axis line', await pg.evaluate(()=>({vis:window.__splash.tfLines[0].visible, col:window.__splash.tfLines[0].material.color.getHexString()})));
 await pg.screenshot({path:OUT+'/ui_axisline.png'});
 await pg.keyboard.press('Escape'); await wait(200);
 // 4. V snap to a box corner while moving
 const snap = await pg.evaluate(async()=>{ const s=window.__splash, o=s.objs.find(q=>q.kind==='mesh'); const B=s.b; const corner=new THREE.Vector3(B.x1,B.y0,B.z1); const sc=s.toScreen(corner);
   s.lastM.x=sc.x-80; s.lastM.y=sc.y-60; s.startTf('g'); s.lastM.x=sc.x+3; s.lastM.y=sc.y-2; s.S.snapV=true; s.evalTf(); const t=s.tfState; const marker=s.snapMark.visible;
   o.group.updateMatrixWorld(true); let md=1e9; o.mesh.v.forEach(q=>{ const w=new THREE.Vector3(q[0],q[1],q[2]).applyMatrix4(o.group.matrixWorld); md=Math.min(md,w.distanceTo(corner)); });
   s.S.snapV=false; s.cancelTf(); return {marker, closestVertexToCorner:+md.toFixed(5)}; });
 console.log('snap', JSON.stringify(snap));
 // 5. gizmo: turn on, drag the X arrow
 await pg.evaluate(()=>window.__splash.setPtab('display')); await wait(200); await pg.click('#c-gizmo'); await wait(400); console.log('gizmo flag', await pg.evaluate(()=>[window.__splash.S.gizmo, document.querySelector('#c-gizmo').checked, window.__splash.tfState, document.activeElement.id]));
 const gz = await pg.evaluate(()=>{ const s=window.__splash, g=s.gizmo; g.updateMatrixWorld(true); const p=g.position.clone(), k=g.scale.x; const a=s.toScreen(p.clone().add(new THREE.Vector3(0.75*k,0,0))); const o=s.objs.find(q=>q.kind==='mesh'); return {vis:g.visible, ax:a.x, ay:a.y, ox:o.target.x, oy:o.target.y, oz:o.target.z, part: (s.pickGizmo(a.x,a.y)||{}).type}; });
 console.log('gizmo', JSON.stringify(gz));
 await pg.screenshot({path:OUT+'/ui_gizmo.png'});
 await pg.mouse.move(gz.ax, gz.ay); await pg.mouse.down(); await pg.mouse.move(gz.ax+60, gz.ay+5, {steps:5}); await pg.mouse.up(); await wait(300);
 console.log('after arrow drag', JSON.stringify(await pg.evaluate(()=>{ const o=window.__splash.objs.find(q=>q.kind==='mesh'); return {x:+o.target.x.toFixed(3), y:+o.target.y.toFixed(3), z:+o.target.z.toFixed(3)}; })));
 // 6. spray detail: draw count with detail 0 vs 4 (Meteor-like water: drop blob a few times and run)
 console.log('errs', JSON.stringify(errs.slice(0,5)));
 await br.close(); })().catch(e=>console.log('ERR',e.stack));
