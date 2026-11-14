// 仅在 PET_SELFTEST=1 时由 main.js 载入:在真实 Electron 里端到端验证渲染/鼠标穿透/拖拽/合影。
const fs = require('fs'), path = require('path');
const { app, ipcMain } = require('electron');
const OUT = process.env.PET_SELFTEST_OUT || '/tmp/pet-selftest';
module.exports = (win, { send }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const log = (...a) => { console.log('[selftest]', ...a); };
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) { errors.push(msg); log('console error:', msg); } });
  win.webContents.on('render-process-gone', (_e, d) => { log('RENDERER GONE', JSON.stringify(d)); });
  let ignoreCalls = [];
  ipcMain.on('set-ignore', (_e, v) => ignoreCalls.push(v));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); return img; };
  const results = {};
  const fail = (m) => { results.fail = (results.fail || []); results.fail.push(m); log('FAIL', m); };

  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(2500);
      const n0 = await js('window.__world ? window.__world.pets.length : -1');
      log('pets after load =', n0);
      if (n0 < 1) fail('world not created / no pets');

      // 掩码是否可用(canvas 未被污染)
      const kindsList = await js(`window.__world.kinds`);
      const maskOk = await js(`(() => { const m = window.__dbg.masks.sunny; if(!m) return 'no masks'; const f = m.hero; let s=0; for (const v of f) s+=v; return s; })()`);
      log('hero mask opaque cells =', maskOk);
      if (typeof maskOk !== 'number' || maskOk < 300) fail('mask not built: ' + maskOk);

      // 添加两只 → 3 只
      send({ action: 'add', kind: 'sunny' }); send({ action: 'add', kind: 'sunny' });
      await wait(500);
      await js(`(() => { const w = window.__world; w.pets.forEach((p,i)=>{ w.enter(p,'idle',999); p.x = 300 + i*260; p.alt=-1; }); })()`);
      await wait(600);
      await shot('01_three_pets');
      const img = await win.webContents.capturePage();
      const bm = img.toBitmap(); // BGRA
      let transparent = 0, opaque = 0; for (let i = 3; i < bm.length; i += 4 * 97) { if (bm[i] === 0) transparent++; else opaque++; }
      log('capture alpha: transparent', transparent, 'opaque', opaque);
      if (transparent < opaque) fail('canvas should be mostly transparent');
      if (opaque === 0) fail('nothing drawn');

      // 命中检测:宠物身体内为真,空白处为假
      const hit = await js(`(() => { const w = window.__world; const p = w.pets[0]; const r = w.rectOf(p);
        return { body: window.__dbg.hitTest(r.x + r.w/2, r.y + r.h*0.5), corner: window.__dbg.hitTest(5,5), id: p.id }; })()`);
      log('hitTest', JSON.stringify(hit));
      if (hit.body !== hit.id) fail('hitTest body should hit pet'); if (hit.corner !== null) fail('hitTest empty should be null');

      // 鼠标穿透切换:移入宠物 → 不再穿透;移出 → 穿透
      ignoreCalls = [];
      const pos = await js(`(() => { const w = window.__world; const r = w.rectOf(w.pets[0]); return { x: Math.round(r.x + r.w/2), y: Math.round(r.y + r.h*0.5) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
      await wait(200);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await wait(200);
      log('ignore toggles', JSON.stringify(ignoreCalls));
      if (!(ignoreCalls.includes(false) && ignoreCalls[ignoreCalls.length - 1] === true)) fail('ignore toggling wrong: ' + JSON.stringify(ignoreCalls));

      // 拖拽:按下 → 移动 → 松开 → 掉落 → 落地
      const id = await js('window.__world.pets[0].id');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
      await wait(100);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x + i * 12, y: pos.y - i * 20 }); await wait(30); }
      const st = await js(`window.__world.get(${JSON.stringify(id)}).state`);
      log('state while dragging =', st);
      if (st !== 'drag') fail('should be dragging, got ' + st);
      await shot('02_dragging');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x + 96, y: pos.y - 160, button: 'left', clickCount: 1 });
      await wait(150);
      const st2 = await js(`window.__world.get(${JSON.stringify(id)}).state`);
      log('state after release =', st2);
      if (st2 !== 'fall') fail('should fall after release, got ' + st2);
      await wait(2500);
      const st3 = await js(`window.__world.get(${JSON.stringify(id)}).state`);
      const y3 = await js(`window.__world.get(${JSON.stringify(id)}).y - window.__world.floor`);
      log('state after landing =', st3, 'y-floor =', y3);
      if (y3 !== 0) fail('should be on floor');

      // 点击
      const pos2 = await js(`(() => { const w = window.__world; const p = w.pets[1]; w.enter(p,'idle',999); const r = w.rectOf(p); return { id: p.id, x: Math.round(r.x + r.w/2), y: Math.round(r.y + r.h*0.5) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos2.x, y: pos2.y }); await wait(100);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
      await wait(300);
      const st4 = await js(`window.__world.get(${JSON.stringify(pos2.id)}).state`);
      log('state after click =', st4);
      if (st4 !== 'react') fail('click should trigger react, got ' + st4);
      await shot('03_click_bubble');

      // 合影
      await wait(2200);
      send({ action: 'photo' });
      let done = false, flashSeen = false, shotPose = false;
      for (let i = 0; i < 70 && !done; i++) {
        await wait(400);
        const s = await js(`({ photo: !!window.__world.photo, phase: window.__world.photo && window.__world.photo.phase, flash: window.__world.effects.flash })`);
        if (s.flash >= 0) flashSeen = true;
        if (s.phase === 'pose' && !shotPose) { shotPose = true; await shot('04_photo_pose'); }
        if (!s.photo) done = true;
      }
      log('photo done =', done, 'flash =', flashSeen);
      if (!done || !flashSeen) fail('photo flow incomplete');

      await wait(500);
      await shot('05_after');
      // QA:全部移除后的恢复路径
      await js(`(() => { const w = window.__world; w.pets.slice().forEach(p => w.removePet(p.id)); })()`);
      await wait(300);
      const empty = await js(`({ n: window.__world.pets.length, hit: window.__dbg.hitTest(window.innerWidth/2, window.innerHeight-70), miss: window.__dbg.hitTest(10,10) })`);
      log('all removed ->', JSON.stringify(empty));
      if (empty.n !== 0 || empty.hit !== '__summon__' || empty.miss !== null) fail('empty-state summon button/hit-test wrong: ' + JSON.stringify(empty));
      await shot('05b_empty_summon');
      send({ action: 'restore-if-empty' }); await wait(400);
      const r1 = await js(`window.__world.pets.map(p=>p.kind).sort().join(',')`);
      log('restore-if-empty ->', r1);
      if (r1.split(',').length !== Object.keys(kindsList).length) fail('restore-if-empty did not bring back all: ' + r1);
      send({ action: 'restore-if-empty' }); await wait(300);
      const r2 = await js(`window.__world.pets.length`);
      if (r2 !== r1.split(',').length) fail('restore-if-empty must not duplicate when non-empty: ' + r2);
      await js(`(() => { const w = window.__world; w.removePet(w.pets[0].id); w.removePet(w.pets[0].id); })()`);
      send({ action: 'restore' }); await wait(300);
      const r3 = await js(`window.__world.pets.map(p=>p.kind).sort().join(',')`);
      log('restore (missing only) ->', r3);
      if (r3 !== r1) fail('restore should refill missing kinds only: ' + r3);
      // 空场景下点击召唤按钮
      await js(`(() => { const w = window.__world; w.pets.slice().forEach(p => w.removePet(p.id)); })()`);
      await js(`window.__dbg.restoreAll(false)`);
      const r4 = await js(`window.__world.pets.length`);
      if (r4 !== r1.split(',').length) fail('summon click should restore all: ' + r4);
      // 所有角色同屏
      await js(`(() => { const w = window.__world; w.pets.slice().forEach(p => w.removePet(p.id)); const ks = Object.keys(w.kinds); ks.forEach((k,i) => { const p = w.addPet(k, (i+0.5)/ks.length*w.width); w.enter(p,'idle',999); p.facing = 1; }); })()`);
      await wait(400);
      await js(`(() => { const w = window.__world; const fr = ['greet','cheer','photo','click']; w.pets.forEach((p,i)=>{ w.react(p, fr[i%4], 999); }); })()`);
      await wait(500);
      await shot('06_all_kinds');
      log('errors:', errors.length);
      if (errors.length) fail('console errors: ' + errors.join(' | '));
    } catch (e) { fail('exception: ' + (e && e.stack || e)); }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 1));
    log(results.fail ? 'RESULT: FAIL' : 'RESULT: PASS');
    app.exit(results.fail ? 1 : 0);
  });
};
