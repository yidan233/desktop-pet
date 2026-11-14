/*
 * brain.js —— 桌宠"世界":所有桌宠的位置、状态机和互动逻辑。
 * 纯逻辑,不依赖 DOM/Electron,可在 node 里直接测试(见 test/brain.test.js)。
 *
 * 坐标:x 为桌宠水平中心,y 为"脚底"所在的像素行(地面 = world.floor)。
 * 素材约定:所有帧朝右,朝左时由渲染层镜像。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Brain = factory();
})(this, function () {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const GENERIC_LINES = {
    greet: ['嗨!'], click: ['嗯?'], drag: ['哇!'], land: ['呼'],
    yawn: ['困了…'], wake: ['醒啦'], photo: ['茄子!'],
    chase_chaser: ['别跑!'], chase_runner: ['救命!'], chase_end: ['哈哈!'],
    pet_hit: ['哎呀!'], signature: ['看我的!'], idle: ['…'],
    admire: ['好看!'], admired: ['……?'], collapse: ['我不行了…'], comfort: ['没事吧?'],
    see_sleep: ['嘘…'], photo_quip: ['茄子!']
  };
  const TIME_KEY = h => (h >= 0 && h < 5) ? 'night' : (h >= 6 && h < 10) ? 'morning' : (h >= 12 && h < 14) ? 'noon' : (h >= 22) ? 'late' : null;

  const MOVING = new Set(['idle', 'walk']); // 可被拉进互动的状态

  class World {
    constructor(opts) {
      this.width = opts.width;
      this.height = opts.height;
      this.kinds = opts.kinds || {};
      this.rng = opts.seed != null ? mulberry32(opts.seed) : Math.random;
      this.scale = 1;
      this.time = 0;
      this.pets = [];
      this.nextId = 1;
      this.pairCooldown = new Map();
      this.photo = null;
      this.effects = { flash: -1 };
      this.checkAcc = 0;
      this.clock = opts.clock || (() => new Date().getHours());
      this.events = []; // 供测试/调试:{t,type,...}
    }

    // ---------- 基础 ----------
    get floor() { return this.height - 2; }
    rand(a, b) { return a + (b - a) * this.rng(); }
    pick(arr) { return arr[Math.floor(this.rng() * arr.length) % arr.length]; }
    log(type, data) { this.events.push(Object.assign({ t: +this.time.toFixed(2), type }, data)); if (this.events.length > 500) this.events.shift(); }

    sizeOf(p) { return p.manifest.size * this.scale; }
    half(p) { return this.sizeOf(p) * 0.36; }
    speedK(p) { return this.sizeOf(p) / 150; }
    clampX(p, x) { const h = this.half(p); return Math.max(h, Math.min(this.width - h, x)); }

    addPet(kind, x) {
      const manifest = this.kinds[kind];
      if (!manifest) throw new Error('未知桌宠: ' + kind);
      const n = this.pets.filter(p => p.kind === kind).length;
      const p = {
        id: kind + '#' + (this.nextId++), kind, manifest,
        x: 0, y: this.floor, vx: 0, vy: 0, facing: this.rng() < 0.5 ? 1 : -1,
        state: 'idle', t: 0, dur: 1, animT: 0, alt: -1, phase: this.rng() * 6.28,
        bubble: null, queue: [], partner: null, role: null, target: 0,
        reactAnim: 'cheer', nextSleepAt: this.time + this.rand(40, 120),
        lastDragT: 0, lastDragX: 0, dragVx: 0, dragOff: { dx: 0, dy: 0 }, clickAt: -9, n
      };
      p.x = this.clampX(p, x != null ? x : this.rand(this.half(p), this.width - this.half(p)));
      this.pets.push(p);
      this.enter(p, 'idle', this.rand(0.5, 2.5));
      return p;
    }

    removePet(id) {
      const p = this.get(id); if (!p) return;
      this.release(p);
      this.pets = this.pets.filter(q => q !== p);
      if (this.photo) { this.photo.ids = this.photo.ids.filter(i => i !== id); }
    }

    get(id) { return this.pets.find(p => p.id === id); }

    resize(w, h) {
      this.width = w; this.height = h;
      for (const p of this.pets) {
        p.x = this.clampX(p, p.x);
        if (p.state !== 'drag' && p.state !== 'fall') p.y = this.floor;
        else p.y = Math.min(p.y, this.floor);
      }
    }

    setScale(s) {
      this.scale = s;
      for (const p of this.pets) p.x = this.clampX(p, p.x);
    }

    // ---------- 状态切换与说话 ----------
    enter(p, state, dur) {
      p.state = state; p.t = 0; p.dur = dur; p.animT = 0; p.talkAnim = null;
      if (state === 'idle') { p.vx = 0; }
    }

    pickLine(p, key, otherKind) {
      const L = p.manifest.lines || {};
      const arr = (L.pair && otherKind && L.pair[otherKind] && L.pair[otherKind][key]) || L[key] || GENERIC_LINES[key];
      return arr && arr.length ? this.pick(arr) : null;
    }

    sayText(p, text, delay, ms, append) {
      if (!text) return;
      if (!append) p.queue = [];
      p.queue.push({ at: this.time + (delay || 0), text, ms: ms || 2400 });
    }

    say(p, key, delay, ms, otherKind) {
      this.sayText(p, this.pickLine(p, key, otherKind), delay, ms);
    }

    // 解除与伙伴/合影的关联
    release(p) {
      const q = p.partner;
      p.partner = null; p.role = null;
      if (q && q.partner === p) {
        q.partner = null; q.role = null;
        if (q.state === 'chase' || q.state === 'greet' || q.state === 'call') this.enter(q, 'idle', this.rand(1, 2));
      }
    }

    // ---------- 用户操作 ----------
    startDrag(id, px, py, now) {
      const p = this.get(id); if (!p) return;
      this.release(p);
      if (this.photo) this.photo.ids = this.photo.ids.filter(i => i !== id);
      p.state = 'drag'; p.t = 0; p.animT = 0;
      p.dragOff = { dx: p.x - px, dy: p.y - py };
      p.lastDragT = now != null ? now : this.time; p.lastDragX = px; p.dragVx = 0;
      p.vx = 0; p.vy = 0;
      p.queue = []; p.bubble = null; p.talkAnim = null;
      this.say(p, 'drag', 0, 2200);
      this.log('drag', { id });
    }

    moveDrag(id, px, py, now) {
      const p = this.get(id); if (!p || p.state !== 'drag') return;
      const t = now != null ? now : this.time;
      const dt = Math.max(0.001, t - p.lastDragT);
      const inst = (px - p.lastDragX) / dt;
      p.dragVx = p.dragVx * 0.7 + inst * 0.3;
      p.lastDragT = t; p.lastDragX = px;
      p.x = this.clampX(p, px + p.dragOff.dx);
      p.y = Math.min(this.floor, Math.max(this.sizeOf(p) * 0.9, py + p.dragOff.dy));
    }

    endDrag(id) {
      const p = this.get(id); if (!p || p.state !== 'drag') return;
      p.vx = Math.max(-420, Math.min(420, p.dragVx)) * 0.5;
      p.vy = 0;
      if (this.photo) this.photo.ids = this.photo.ids.filter(i => i !== id);
      this.enter(p, 'fall', 5);
      this.log('drop', { id });
    }

    click(id) {
      const p = this.get(id); if (!p) return;
      if (p.state === 'drag' || p.state === 'fall') return;
      if (p.state === 'sleep' || p.state === 'sleepy') { this.wake(p); return; }
      if (this.time - p.clickAt < 0.4) return;
      p.clickAt = this.time;
      this.react(p, 'click', 1.8);
      this.say(p, 'click', 0, 2000);
      this.log('click', { id });
    }

    signature(id) {
      const p = this.get(id); if (!p) return;
      if (p.state === 'drag' || p.state === 'fall') return;
      this.react(p, 'signature', 2.4);
      this.say(p, 'signature', 0, 2400);
      this.log('signature', { id });
    }

    // 右键菜单里的"专属动作"(manifest.special = {label, anim, line})
    special(id) {
      const p = this.get(id); if (!p) return;
      if (p.state === 'drag' || p.state === 'fall') return;
      if (p.state === 'sleep' || p.state === 'sleepy') { this.wake(p); return; }
      const sp = p.manifest.special || {};
      if (this.traitOf(p, 'admire') && MOVING.has(p.state)) {
        const o = this.nearest(p, 520, q => MOVING.has(q.state));
        if (o) { this.startAdmire(p, o); return; }
      }
      this.react(p, sp.anim || 'cheer', 2.6);
      this.say(p, sp.line || 'signature', 0, 2600);
      this.log('special', { id });
    }

    traitOf(p, t) { return !!(p.manifest.traits && p.manifest.traits[t]); }

    toggleSleep(id) {
      const p = this.get(id); if (!p) return;
      if (p.state === 'sleep' || p.state === 'sleepy') this.wake(p);
      else if (MOVING.has(p.state)) { this.release(p); this.enter(p, 'sleepy', 1.8); this.say(p, 'yawn', 0, 1800); }
    }

    wake(p) {
      this.react(p, 'cheer', 1.0);
      this.say(p, 'wake', 0, 1800);
      p.nextSleepAt = this.time + this.rand(60, 150);
    }

    greetNearest(id) {
      const p = this.get(id); if (!p) return;
      const o = this.nearest(p, 1e9, q => MOVING.has(q.state));
      if (o && MOVING.has(p.state)) this.startGreet(p, o);
      else { this.react(p, 'greet', 2.2); this.say(p, 'greet', 0, 2000); }
    }

    react(p, animKey, dur) {
      p.reactAnim = animKey;
      this.enter(p, 'react', dur);
    }

    nearest(p, maxDx, filter) {
      let best = null, bd = maxDx;
      for (const q of this.pets) {
        if (q === p || (filter && !filter(q))) continue;
        const d = Math.abs(q.x - p.x);
        if (d < bd) { bd = d; best = q; }
      }
      return best;
    }

    // ---------- 合影 ----------
    startPhoto() {
      if (this.photo || !this.pets.length) return false;
      const ids = [];
      const members = this.pets.filter(p => p.state !== 'drag').sort((a, b) => a.x - b.x);
      const n = members.length;
      if (!n) return false;
      const spacing = Math.min(this.sizeOf(members[0]) * 0.78, (this.width - 120) / Math.max(1, n));
      const cx = this.width / 2;
      members.forEach((p, i) => {
        this.release(p);
        p.slot = this.clampX(p, cx + (i - (n - 1) / 2) * spacing);
        p.target = p.slot;
        ids.push(p.id);
        this.enter(p, 'photo_walk', 20);
      });
      this.photo = { phase: 'gather', t: 0, ids, flashed: false };
      this.log('photo_start', { n });
      return true;
    }

    updatePhoto(dt) {
      const ph = this.photo; if (!ph) return;
      ph.t += dt;
      const members = ph.ids.map(i => this.get(i)).filter(Boolean);
      if (!members.length) { this.photo = null; return; }
      if (ph.phase === 'gather') {
        const ready = members.every(p => p.state === 'photo_wait');
        if (ready || ph.t > 18) {
          ph.phase = 'pose'; ph.t = 0; ph.flashed = false;
          members.forEach((p, i) => {
            p.facing = 1; this.enter(p, 'photo_pose', 3.4);
            if (i === Math.floor(members.length / 2) || members.length === 1) this.say(p, 'photo', 0, 2200);
          });
          const others = members.filter((p, i) => !(i === Math.floor(members.length / 2) || members.length === 1));
          others.sort(() => this.rng() - 0.5).slice(0, 2).forEach((p, k) => this.say(p, 'photo_quip', 0.5 + k * 0.9, 1900));
        }
      } else if (ph.phase === 'pose') {
        if (!ph.flashed && ph.t > 2.4) { ph.flashed = true; this.effects.flash = 0; this.log('photo_flash', {}); }
        if (ph.t > 3.4) {
          members.forEach(p => this.react(p, 'cheer', 1.4));
          this.photo = null; this.log('photo_done', {});
        }
      }
    }

    // ---------- 互动 ----------
    pairKey(a, b) { return a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id; }

    startGreet(a, b, opts) {
      opts = opts || {};
      this.release(a); this.release(b);
      a.partner = b; b.partner = a; a.role = b.role = 'greet';
      a.facing = b.x >= a.x ? 1 : -1; b.facing = -a.facing;
      this.enter(a, 'greet', 2.8); this.enter(b, 'greet', 2.8);
      this.say(a, opts.firstA || 'greet', 0, 1900, b.kind);
      this.say(b, opts.firstB || 'greet', 0.8, 1900, a.kind);
      this.pairCooldown.set(this.pairKey(a, b), this.time + 25);
      this.log('greet', { a: a.id, b: b.id });
    }

    // 对话:读取 a.lines.pair[b.kind].chat(多段剧本,每段是交替台词数组:a, b, a, b …)
    startChat(a, b) {
      const L = a.manifest.lines || {};
      const scripts = L.pair && L.pair[b.kind] && L.pair[b.kind].chat;
      if (!scripts || !scripts.length) { this.startGreet(a, b); return; }
      const script = this.pick(scripts);
      this.release(a); this.release(b);
      a.partner = b; b.partner = a; a.role = b.role = 'greet';
      a.facing = b.x >= a.x ? 1 : -1; b.facing = -a.facing;
      const gap = 1.9;
      const dur = script.length * gap + 0.9;
      this.enter(a, 'greet', dur); this.enter(b, 'greet', dur);
      script.forEach((text, i) => this.sayText(i % 2 ? b : a, text, i * gap, 2200, true));
      this.pairCooldown.set(this.pairKey(a, b), this.time + 35);
      this.log('chat', { a: a.id, b: b.id, n: script.length });
    }

    // 看脸:a(有 admire 特质)盯着 b 说"伟大。",b 害羞/无语
    startAdmire(a, b) {
      this.release(a); this.release(b);
      a.partner = b; b.partner = a; a.role = b.role = 'greet';
      a.facing = b.x >= a.x ? 1 : -1; b.facing = -a.facing;
      this.enter(a, 'greet', 3.4); this.enter(b, 'greet', 3.4);
      a.talkAnim = 'admire'; b.talkAnim = 'shy';
      this.say(a, 'admire', 0.2, 2200, b.kind);
      this.say(b, 'admired', 1.5, 1900, a.kind);
      this.pairCooldown.set(this.pairKey(a, b), this.time + 30);
      this.log('admire', { a: a.id, b: b.id });
    }

    // 安慰:a(有 collapse 特质)说"我不行了"倒下,b 来安慰
    startComfort(a, b) {
      this.release(a); this.release(b);
      a.partner = b; b.partner = a; a.role = b.role = 'greet';
      a.facing = b.x >= a.x ? 1 : -1; b.facing = -a.facing;
      this.enter(a, 'greet', 3.6); this.enter(b, 'greet', 3.6);
      a.talkAnim = 'collapse';
      this.say(a, 'collapse', 0.2, 2000, b.kind);
      this.say(b, 'comfort', 1.6, 2000, a.kind);
      this.pairCooldown.set(this.pairKey(a, b), this.time + 30);
      this.log('comfort', { a: a.id, b: b.id });
    }

    startChase(a, b) {
      this.release(a); this.release(b);
      a.partner = b; b.partner = a; a.role = 'chaser'; b.role = 'runner';
      a.facing = b.x >= a.x ? 1 : -1; b.facing = a.facing;
      this.enter(a, 'call', 0.9); this.enter(b, 'call', 0.9);
      this.say(a, 'chase_chaser', 0, 1800, b.kind);
      this.say(b, 'chase_runner', 0.5, 1800, a.kind);
      this.pairCooldown.set(this.pairKey(a, b), this.time + 30);
      this.log('chase', { a: a.id, b: b.id });
    }

    endChase(a, b) {
      const caught = Math.abs(a.x - b.x) < 60;
      a.partner = b.partner = null; a.role = b.role = null;
      a.facing = b.x >= a.x ? 1 : -1; b.facing = -a.facing;
      this.react(a, caught ? 'photo' : 'cheer', 1.8);
      this.react(b, 'cheer', 1.8);
      this.say(a, 'chase_end', 0, 1800, b.kind);
      this.log('chase_end', { a: a.id, b: b.id, caught });
    }

    maybeInteract() {
      if (this.photo) return;
      const list = this.pets;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (MOVING.has(a.state) !== MOVING.has(b.state) && (a.state === 'sleep' || b.state === 'sleep')) {
            // 路过睡着的:小声说一句
            const w = MOVING.has(a.state) ? a : b, z = w === a ? b : a;
            if (Math.abs(w.x - z.x) < this.sizeOf(w) * 0.6 && this.time >= (this.pairCooldown.get(this.pairKey(a, b)) || 0) && this.rng() < 0.2) {
              this.pairCooldown.set(this.pairKey(a, b), this.time + 45);
              w.facing = z.x >= w.x ? 1 : -1;
              this.say(w, 'see_sleep', 0, 2200, z.kind);
              this.log('see_sleep', { a: w.id, b: z.id });
              return;
            }
            continue;
          }
          if (!MOVING.has(a.state) || !MOVING.has(b.state)) continue;
          const reach = (this.sizeOf(a) + this.sizeOf(b)) * 0.45;
          if (Math.abs(a.x - b.x) > reach || Math.abs(a.y - b.y) > 20) continue;
          if (this.time < (this.pairCooldown.get(this.pairKey(a, b)) || 0)) continue;
          if (this.rng() > 0.3) continue;
          const r = this.rng();
          const adm = this.traitOf(a, 'admire') ? [a, b] : this.traitOf(b, 'admire') ? [b, a] : null;
          const col = this.traitOf(a, 'collapse') ? [a, b] : this.traitOf(b, 'collapse') ? [b, a] : null;
          if (adm && r < 0.45) this.startAdmire(adm[0], adm[1]);
          else if (col && r < 0.3) this.startComfort(col[0], col[1]);
          else if (r < 0.5) this.rng() < 0.5 ? this.startChat(a, b) : this.startChat(b, a);
          else if (r < 0.75) this.startGreet(a, b);
          else if (this.rng() < 0.5) this.startChase(a, b);
          else this.startChase(b, a);
          return;
        }
      }
    }

    // 掉落/拖放到另一只旁边:联动
    dropInteract(p) {
      const o = this.nearest(p, this.sizeOf(p) * 1.0, q => MOVING.has(q.state) || q.state === 'sleep');
      if (!o) return;
      if (o.state === 'sleep') o.state = 'idle';
      if (this.traitOf(p, 'admire')) { this.startAdmire(p, o); this.log('drop_interact', { a: p.id, b: o.id }); return; }
      this.startGreet(p, o, { firstA: 'land', firstB: 'pet_hit' });
      this.log('drop_interact', { a: p.id, b: o.id });
    }

    // ---------- 主循环 ----------
    step(dt) {
      dt = Math.min(dt, 0.1);
      this.time += dt;
      if (this.effects.flash >= 0) { this.effects.flash += dt; if (this.effects.flash > 0.7) this.effects.flash = -1; }
      for (const p of this.pets) this.updatePet(p, dt);
      this.updatePhoto(dt);
      this.checkAcc += dt;
      if (this.checkAcc >= 0.25) { this.checkAcc = 0; this.maybeInteract(); }
    }

    moveToward(p, tx, speed, dt) {
      const dx = tx - p.x;
      const step = speed * this.speedK(p) * dt;
      if (Math.abs(dx) <= step) { p.x = tx; return true; }
      p.x += Math.sign(dx) * step; p.facing = Math.sign(dx);
      return false;
    }

    chooseWalkTarget(p) {
      const h = this.half(p);
      let tx;
      const others = this.pets.filter(q => q !== p && q.state !== 'sleep' && q.state !== 'drag');
      if (others.length && this.rng() < 0.35) {
        const o = this.pick(others);
        const side = o.x > this.width / 2 ? -1 : 1;
        tx = o.x + side * this.sizeOf(p) * this.rand(0.45, 0.7);
      } else {
        tx = this.rand(h, this.width - h);
      }
      return this.clampX(p, tx);
    }

    updatePet(p, dt) {
      p.t += dt; p.animT += dt;
      if (p.queue.length) {
        const i = p.queue.findIndex(q => this.time >= q.at);
        if (i >= 0) {
          const q = p.queue.splice(i, 1)[0];
          p.bubble = { text: q.text, until: this.time + q.ms / 1000 };
        }
      }
      if (p.bubble && this.time > p.bubble.until) p.bubble = null;

      switch (p.state) {
        case 'drag': break;

        case 'fall': {
          p.vy += 2200 * dt;
          p.y += p.vy * dt;
          p.x += p.vx * dt;
          p.vx *= (1 - 0.6 * dt);
          const h = this.half(p);
          if (p.x < h) { p.x = h; p.vx = Math.abs(p.vx) * 0.5; }
          if (p.x > this.width - h) { p.x = this.width - h; p.vx = -Math.abs(p.vx) * 0.5; }
          if (p.y >= this.floor) {
            p.y = this.floor; p.vx = 0; p.vy = 0;
            this.react(p, 'cheer', 0.7);
            this.say(p, 'land', 0, 1600);
            this.dropInteract(p);
          }
          break;
        }

        case 'idle':
          if (p.t >= p.dur) this.decideIdle(p);
          break;

        case 'walk':
          if (this.moveToward(p, p.target, 52, dt) || p.t > 25) this.enter(p, 'idle', this.rand(1.5, 5));
          break;

        case 'sleepy':
          if (p.t >= p.dur) { this.enter(p, 'sleep', this.rand(12, 26)); }
          break;

        case 'sleep':
          if (p.t >= p.dur) this.wake(p);
          break;

        case 'react':
          if (p.t >= p.dur) this.enter(p, 'idle', this.rand(1, 3));
          break;

        case 'greet':
          if (p.t >= p.dur) {
            const q = p.partner; p.partner = null; p.role = null;
            if (q && q.partner === p) { q.partner = null; q.role = null; }
            this.enter(p, 'idle', this.rand(1, 2));
          }
          break;

        case 'call': {
          const q = p.partner;
          if (!q) { this.enter(p, 'idle', 1); break; }
          if (p.t >= p.dur) {
            this.enter(p, 'chase', 5.5);
            if (p.role === 'chaser' && q.state === 'call') this.enter(q, 'chase', 5.5);
          }
          break;
        }

        case 'chase': {
          const q = p.partner;
          if (!q) { this.enter(p, 'idle', 1); break; }
          if (p.role === 'chaser') {
            this.moveToward(p, q.x, 125, dt);
            const gap = Math.abs(p.x - q.x);
            if (gap < 48 || p.t >= p.dur || q.state !== 'chase') { this.endChase(p, q); }
          } else {
            const dir = q.x < p.x ? 1 : -1;
            p.facing = dir;
            const nx = p.x + dir * 135 * this.speedK(p) * dt;
            const h = this.half(p);
            p.x = Math.max(h, Math.min(this.width - h, nx));
            if (p.x <= h + 1 || p.x >= this.width - h - 1) {
              // 被逼到墙角:直接被抓住
              p.facing = -dir;
            }
          }
          break;
        }

        case 'photo_walk':
          p.facing = Math.sign(p.slot - p.x) || p.facing;
          if (this.moveToward(p, p.slot, 110, dt)) { p.facing = 1; this.enter(p, 'photo_wait', 30); }
          break;
        case 'photo_wait': case 'photo_pose': break;
      }

      p.y = p.state === 'fall' || p.state === 'drag' ? p.y : this.floor;
    }

    decideIdle(p) {
      const r = this.rng();
      if (this.time >= p.nextSleepAt && r < 0.7) {
        p.nextSleepAt = this.time + this.rand(60, 150);
        this.enter(p, 'sleepy', 1.8); this.say(p, 'yawn', 0, 1800); return;
      }
      p.alt = -1;
      if (r < 0.50) {
        p.target = this.chooseWalkTarget(p);
        if (Math.abs(p.target - p.x) < 24) { this.enter(p, 'idle', this.rand(1, 3)); return; }
        this.enter(p, 'walk', 30);
      } else if (r < 0.64) {
        const alts = (p.manifest.anim.idle_alt || []).length;
        p.alt = alts ? Math.floor(this.rng() * alts) : -1;
        this.enter(p, 'idle', this.rand(2.5, 4.5));
      } else if (r < 0.76) {
        this.react(p, 'greet', 2.2); this.say(p, 'greet', 0, 1800);
      } else if (r < 0.88) {
        this.enter(p, 'idle', this.rand(3, 5));
        const tk = TIME_KEY(this.clock());
        const L = p.manifest.lines || {};
        this.say(p, tk && L[tk] && this.rng() < 0.4 ? tk : 'idle', 0, 2600);
      } else {
        this.enter(p, 'idle', this.rand(2, 5));
      }
    }

    // ---------- 渲染信息 ----------
    frameOf(p) {
      const A = p.manifest.anim;
      const cyc = (arr, period) => arr[Math.floor(p.animT / period) % arr.length];
      switch (p.state) {
        case 'walk': case 'photo_walk': return cyc(A.walk, 0.22);
        case 'chase': return cyc(A.walk, 0.14);
        case 'idle': case 'photo_wait':
          return p.alt >= 0 && A.idle_alt && A.idle_alt.length ? A.idle_alt[p.alt % A.idle_alt.length] : A.idle[0];
        case 'sleepy': return cyc(A.yawn, 1);
        case 'sleep': return cyc(A.sleep, 1);
        case 'drag': return cyc(A.drag, 1);
        case 'fall': return cyc(A.fall, 1);
        case 'greet': return cyc((p.talkAnim && A[p.talkAnim]) || A.greet, 0.5);
        case 'call': return p.role === 'chaser' ? cyc(A.chase_chaser || A.call, 1) : cyc(A.chase_runner || A.fall, 1);
        case 'react': { const arr = A[p.reactAnim] || A.cheer; return cyc(arr, 0.45); }
        case 'photo_pose': return cyc(A.photo, 1);
        default: return A.idle[0];
      }
    }

    rectOf(p) {
      const s = this.sizeOf(p);
      const fs = p.manifest.frameSize, bl = p.manifest.baseline;
      return { x: p.x - s / 2, y: p.y - s * bl / fs, w: s, h: s };
    }

    sprites() {
      const out = this.pets.map(p => {
        let bob = 0, sy = 1;
        if (p.state === 'walk' || p.state === 'photo_walk') bob = Math.abs(Math.sin(p.animT * 14.3)) * 4 * this.speedK(p);
        else if (p.state === 'chase') bob = Math.abs(Math.sin(p.animT * 22)) * 6 * this.speedK(p);
        else if (p.state === 'sleep') sy = 1 + 0.018 * Math.sin(this.time * 1.6 + p.phase);
        else sy = 1 + 0.012 * Math.sin(this.time * 2.4 + p.phase);
        return {
          id: p.id, kind: p.kind, frame: this.frameOf(p), facing: p.facing, bob, sy,
          rect: this.rectOf(p), state: p.state,
          bubble: p.bubble ? p.bubble.text : null,
          z: p.state === 'drag' ? 1e6 : p.y * 1000 + p.x * 0.01
        };
      });
      out.sort((a, b) => a.z - b.z);
      return out;
    }
  }

  return { World, mulberry32 };
});
