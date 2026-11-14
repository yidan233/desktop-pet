/* renderer.js —— 全屏透明 canvas:渲染所有桌宠、气泡,处理点击/拖拽/右键,并在"空白处"让鼠标穿透。 */
(function () {
  'use strict';
  const api = window.petAPI;
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const MASK = 64;                      // 命中检测用的低分辨率透明度蒙版
  let world = null, kinds = {}, images = {}, masks = {};
  let dpr = window.devicePixelRatio || 1;
  let ignoring = true;
  let drag = null;                      // {id, sx, sy, started}
  let lastClick = { id: null, t: 0 };

  // ---------- 资源 ----------
  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('加载失败 ' + src)); im.src = src; });
  }
  function buildMask(im) {
    const c = document.createElement('canvas'); c.width = c.height = MASK;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0, MASK, MASK);
    const d = g.getImageData(0, 0, MASK, MASK).data, m = new Uint8Array(MASK * MASK);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 40 ? 1 : 0;
    return m;
  }
  async function loadKind(id, manifest) {
    images[id] = {}; masks[id] = {};
    await Promise.all(Object.entries(manifest.frames).map(async ([name, file]) => {
      const im = await loadImage(manifest.baseUrl + file);
      images[id][name] = im; masks[id][name] = buildMask(im);
    }));
  }

  // ---------- 画布尺寸 ----------
  function fit() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (world) world.resize(w, h);
  }

  // ---------- 空场景时的"召唤"按钮 ----------
  function summonRect() { const w = 190, h = 44; return { x: window.innerWidth / 2 - w / 2, y: window.innerHeight - 90, w, h }; }
  function inSummon(px, py) {
    if (!world || world.pets.length) return false;
    const r = summonRect(); return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }
  function restoreAll(onlyMissing) {
    const have = new Set(world.pets.map(p => p.kind));
    const ks = Object.keys(kinds).filter(k => !onlyMissing || !have.has(k));
    ks.forEach((k, i) => world.addPet(k, (i + 0.5) / ks.length * world.width));
    savePrefs();
  }

  // ---------- 命中检测 ----------
  function hitTest(px, py) {
    if (!world) return null;
    if (inSummon(px, py)) return '__summon__';
    const list = world.sprites();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i], r = s.rect;
      if (px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) continue;
      let u = (px - r.x) / r.w; const v = (py - r.y) / r.h;
      if (s.facing < 0) u = 1 - u;
      const m = masks[s.kind] && masks[s.kind][s.frame]; if (!m) continue;
      const ix = Math.min(MASK - 1, Math.max(0, Math.floor(u * MASK))), iy = Math.min(MASK - 1, Math.max(0, Math.floor(v * MASK)));
      if (m[iy * MASK + ix]) return s.id;
    }
    return null;
  }
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; api.setIgnore(v); } }

  // ---------- 鼠标 ----------
  window.addEventListener('mousemove', (e) => {
    if (drag) return;
    const id = hitTest(e.clientX, e.clientY);
    setIgnore(!id);
    document.body.style.cursor = id ? 'grab' : 'default';
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const id = hitTest(e.clientX, e.clientY); if (!id) return;
    if (id === '__summon__') { restoreAll(false); return; }
    drag = { id, sx: e.clientX, sy: e.clientY, started: false };
    canvas.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) {
      drag.started = true; world.startDrag(drag.id, drag.sx, drag.sy, performance.now() / 1000);
    }
    if (drag.started) world.moveDrag(drag.id, e.clientX, e.clientY, performance.now() / 1000);
  });
  function endPointer(e) {
    if (!drag) return;
    const d = drag; drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.started) world.endDrag(d.id);
    else {
      const now = performance.now();
      if (lastClick.id === d.id && now - lastClick.t < 350) { world.signature(d.id); lastClick = { id: null, t: 0 }; }
      else { world.click(d.id); lastClick = { id: d.id, t: now }; }
    }
    const id = hitTest(e.clientX, e.clientY);
    setIgnore(!id); document.body.style.cursor = id ? 'grab' : 'default';
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const id = hitTest(e.clientX, e.clientY); if (!id || id === '__summon__') return;
    const p = world.get(id);
    api.showMenu({ petId: id, name: p.manifest.name, sleeping: p.state === 'sleep' || p.state === 'sleepy', hasSignature: !!(p.manifest.anim && p.manifest.anim.signature), special: p.manifest.special ? p.manifest.special.label : null });
  });

  // ---------- 菜单/托盘动作 ----------
  function savePrefs() { api.savePrefs({ scale: world.scale, pets: world.pets.map(p => p.kind), known: Object.keys(kinds) }); }
  function spread() {
    const n = world.pets.length;
    world.pets.forEach((p, i) => { if (p.state === 'idle' || p.state === 'walk') p.x = world.clampX(p, (i + 0.5) / n * world.width); });
  }
  api.onAction((a) => {
    if (!world) return;
    switch (a.action) {
      case 'sleep': world.toggleSleep(a.petId); break;
      case 'greet': world.greetNearest(a.petId); break;
      case 'signature': world.signature(a.petId); break;
      case 'special': world.special(a.petId); break;
      case 'photo': world.startPhoto(); break;
      case 'add': if (kinds[a.kind]) { world.addPet(a.kind, world.width * (0.3 + 0.4 * Math.random())); savePrefs(); } break;
      case 'remove': world.removePet(a.petId); savePrefs(); break;
      case 'scale': world.setScale(a.scale); savePrefs(); break;
      case 'gather': spread(); break;
      case 'restore': restoreAll(true); break;
      case 'restore-if-empty': if (!world.pets.length) restoreAll(false); break;
    }
  });
  api.onPets((list) => { /* 预留:主进程请求重置桌宠集合 */ });

  // ---------- 绘制 ----------
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function drawBubble(s) {
    const g = ctx; g.font = '600 14px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
    const tw = g.measureText(s.bubble).width, w = tw + 22, h = 28;
    const r = s.rect;
    let x = r.x + r.w / 2 - w / 2, y = r.y - h + r.h * 0.1;
    x = Math.max(4, Math.min(window.innerWidth - w - 4, x)); y = Math.max(4, y);
    g.save();
    g.fillStyle = '#fff'; g.strokeStyle = '#1E1E2A'; g.lineWidth = 2.2; g.lineJoin = 'round';
    roundRect(g, x, y, w, h, 12); g.fill(); g.stroke();
    const cx = Math.max(x + 14, Math.min(x + w - 14, r.x + r.w / 2));
    g.beginPath(); g.moveTo(cx - 6, y + h - 1); g.lineTo(cx, y + h + 8); g.lineTo(cx + 6, y + h - 1); g.closePath();
    g.fillStyle = '#fff'; g.fill(); g.beginPath(); g.moveTo(cx - 6, y + h); g.lineTo(cx, y + h + 8); g.lineTo(cx + 6, y + h); g.stroke();
    g.fillStyle = '#fff'; g.fillRect(cx - 5, y + h - 3, 10, 4);
    g.fillStyle = '#1E1E2A'; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText(s.bubble, x + w / 2, y + h / 2 + 1);
    g.restore();
  }
  function draw() {
    const W = window.innerWidth, H = window.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const list = world.sprites();
    // 影子(固定画在地面,抬起时变淡变小)
    for (const s of list) {
      const p = world.get(s.id), size = world.sizeOf(p), lift = Math.max(0, world.floor - p.y);
      const k = Math.max(0.35, 1 - lift / 300);
      ctx.fillStyle = 'rgba(30,30,42,' + (0.16 * k).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(p.x, world.floor + 1, size * 0.26 * k, size * 0.05 * k, 0, 0, Math.PI * 2); ctx.fill();
    }
    for (const s of list) {
      const im = images[s.kind] && images[s.kind][s.frame]; if (!im) continue;
      const p = world.get(s.id), size = world.sizeOf(p), m = p.manifest;
      ctx.save();
      ctx.translate(p.x, p.y - s.bob);
      ctx.scale(s.facing < 0 ? -1 : 1, s.sy);
      ctx.drawImage(im, -size / 2, -size * m.baseline / m.frameSize, size, size);
      ctx.restore();
    }
    for (const s of list) if (s.bubble) drawBubble(s);
    if (!world.pets.length) {
      const r = summonRect(), g = ctx;
      g.save(); g.fillStyle = '#fff'; g.strokeStyle = '#1E1E2A'; g.lineWidth = 2.5;
      roundRect(g, r.x, r.y, r.w, r.h, 22); g.fill(); g.stroke();
      g.fillStyle = '#1E1E2A'; g.font = '700 16px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('＋ 召唤桌宠们', r.x + r.w / 2, r.y + r.h / 2 + 1);
      g.restore();
    }
    const f = world.effects.flash;
    if (f >= 0) { ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * (1 - f / 0.7)).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }
  }

  // ---------- 主循环(30fps) ----------
  let last = performance.now(), acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = (now - last) / 1000; last = now; acc += dt;
    if (acc < 1 / 31) return;
    world.step(acc); acc = 0;
    draw();
  }

  async function start() {
    const init = await api.getInit();
    kinds = init.kinds;
    await Promise.all(Object.entries(kinds).map(([id, m]) => loadKind(id, m)));
    world = new Brain.World({ width: window.innerWidth, height: window.innerHeight, kinds });
    world.setScale(init.prefs.scale || 1);
    fit();
    // 偏好里记着"保存时已知的角色":新放进 assets/pets 的角色会自动加入,用户主动移除过的不会被加回来
    const known = new Set(init.prefs.known || []);
    let want = (init.prefs.pets || []).filter(k => kinds[k]);
    if (!want.length) want = Object.keys(kinds);
    else for (const k of Object.keys(kinds)) if (!known.has(k) && !want.includes(k)) want.push(k);
    want.forEach((k, i) => world.addPet(k, (i + 0.5) / want.length * world.width));
    savePrefs();
    window.addEventListener('resize', fit);
    window.__world = world; window.__dbg = { hitTest, masks, restoreAll, summonRect };   // 方便调试/自测
    requestAnimationFrame(loop);
  }
  start().catch(err => { console.error(err); });
})();
