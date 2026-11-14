const fs = require('fs'), path = require('path'), assert = require('assert');
const { World } = require('../renderer/brain.js');

const PETS = path.join(__dirname, '../assets/pets');
const all = {};
for (const d of fs.readdirSync(PETS)) {
  const f = path.join(PETS, d, 'pet.json'); if (!fs.existsSync(f)) continue;
  const m = JSON.parse(fs.readFileSync(f, 'utf8')); all[m.id] = m;
  // 0. 校验每个角色配置:帧文件存在,动画引用的帧存在,必需动画齐全
  for (const [n, file] of Object.entries(m.frames)) assert(fs.existsSync(path.join(PETS, d, file)), `${m.id}: 缺少帧文件 ${file}`);
  for (const k of ['idle', 'walk', 'yawn', 'sleep', 'drag', 'fall', 'greet', 'call', 'cheer', 'photo', 'click']) assert(m.anim[k] && m.anim[k].length, `${m.id}: 缺少动画 ${k}`);
  for (const [k, arr] of Object.entries(m.anim)) for (const fr of arr) assert(m.frames[fr], `${m.id}: 动画 ${k} 引用了不存在的帧 ${fr}`);
  console.log('OK 配置校验:', m.id, Object.keys(m.frames).length, '帧');
}
const manifest = all.sunny;
const frames = new Set(Object.keys(manifest.frames));
const mk = (seed, n = 3, w = 1280, h = 720) => {
  const world = new World({ width: w, height: h, kinds: all, seed });
  const ks = Object.keys(all);
  for (let i = 0; i < n; i++) world.addPet(ks[i % ks.length]);
  return world;
};
const check = (w) => {
  for (const p of w.pets) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'NaN pos ' + p.state);
    const h = w.half(p);
    assert(p.x >= h - 0.01 && p.x <= w.width - h + 0.01, `x out of bounds ${p.x} state=${p.state}`);
    assert(p.y <= w.floor + 0.01 && p.y >= 0, 'y out of bounds ' + p.y);
    assert(p.manifest.frames[w.frameOf(p)], `bad frame for state ${p.state}: ${w.frameOf(p)}`);
  }
};

// 1. 长时间自治运行(多种子):不越界、不卡死,且各类行为都出现
const seen = new Set(), evTypes = new Set();
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const w = mk(seed, seed % 2 ? 3 : 5);
  const stuck = new Map();
  for (let i = 0; i < 30 * 600; i++) {
    w.step(1 / 30); check(w);
    for (const p of w.pets) {
      seen.add(p.state);
      if (p.state === 'sleep') continue;
      const k = p.id + p.state;
      const first = stuck.get(p.id);
      if (!first || first.state !== p.state) stuck.set(p.id, { state: p.state, at: w.time });
      else assert(w.time - first.at < 70, `pet ${p.id} stuck in ${p.state} for 70s (seed ${seed})`);
    }
  }
  w.events.forEach(e => evTypes.add(e.type));
}
for (const s of ['idle', 'walk', 'sleep', 'sleepy', 'greet', 'chase', 'react']) assert(seen.has(s), 'never saw state ' + s);
for (const t of ['greet', 'chase', 'chase_end', 'chat', 'admire', 'comfort']) assert(evTypes.has(t), 'never saw event ' + t);
console.log('OK 自治运行:', [...seen].join(','), '| 事件:', [...evTypes].join(','));

// 2. 拖拽 → 掉落 → 回到待机;旁边有别人时触发联动
{
  const w = mk(11, 2);
  const [a, b] = w.pets;
  w.enter(a, 'idle', 99); w.enter(b, 'idle', 99); a.x = 400; b.x = 520;
  w.startDrag(a.id, 400, w.floor - 60, 0);
  assert.strictEqual(a.state, 'drag');
  w.moveDrag(a.id, 700, 300, 0.1); w.moveDrag(a.id, 520, 250, 0.2);
  assert(a.y < w.floor, 'dragged pet should be lifted');
  w.pairCooldown.clear();
  w.endDrag(a.id);
  assert.strictEqual(a.state, 'fall');
  let landed = false;
  for (let i = 0; i < 300; i++) { w.step(1 / 30); check(w); if (w.events.some(e => e.type === 'drop_interact')) { landed = true; break; } }
  assert(landed, '落在另一只旁边应触发联动');
  for (let i = 0; i < 300; i++) w.step(1 / 30);
  assert(['idle', 'walk', 'react', 'greet'].includes(a.state), 'state after drop interaction: ' + a.state);
  console.log('OK 拖拽/掉落/联动');
}

// 3. 合影:全员聚集 → 摆姿势 → 闪光 → 解散
{
  const w = mk(21, 5);
  assert(w.startPhoto());
  let flashed = false, posed = false;
  for (let i = 0; i < 30 * 40 && w.photo; i++) {
    w.step(1 / 30); check(w);
    if (w.effects.flash >= 0) flashed = true;
    if (w.pets.every(p => p.state === 'photo_pose')) posed = true;
  }
  assert(posed && flashed && !w.photo, '合影流程应完整结束 ' + JSON.stringify({ posed, flashed, photo: !!w.photo }));
  const xs = w.pets.map(p => p.x).sort((x, y) => x - y);
  console.log('OK 合影, 站位间距', xs.slice(1).map((x, i) => Math.round(x - xs[i])).join(','));
}

// 4. 合影中途拖走一只不会卡住
{
  const w = mk(31, 3);
  w.startPhoto();
  for (let i = 0; i < 20; i++) w.step(1 / 30);
  w.startDrag(w.pets[0].id, 100, 100, 0); w.endDrag(w.pets[0].id);
  for (let i = 0; i < 30 * 40 && w.photo; i++) w.step(1 / 30);
  assert(!w.photo, '被拖走后合影也应结束');
  console.log('OK 合影中途拖走');
}

// 5. 点击/睡眠/移除/缩放
{
  const w = mk(41, 2);
  const [a] = w.pets;
  w.enter(a, 'idle', 99); w.click(a.id); assert.strictEqual(a.state, 'react');
  w.step(2); w.step(2); w.enter(a, 'idle', 99);
  w.toggleSleep(a.id); assert.strictEqual(a.state, 'sleepy');
  for (let i = 0; i < 60; i++) w.step(1 / 30);
  assert.strictEqual(a.state, 'sleep'); w.click(a.id); assert.strictEqual(a.state, 'react');
  w.setScale(1.35); check(w); w.resize(900, 500); check(w);
  w.removePet(a.id); assert.strictEqual(w.pets.length, 1);
  console.log('OK 点击/睡眠/缩放/移除');
}
// 6. 新互动:对话剧本、看脸、安慰、专属动作、时间台词
{
  // 台词数据校验:pair 里的 chat 剧本必须是偶数/奇数段字符串数组,且指向存在的角色
  for (const m of Object.values(all)) {
    assert(m.special && m.anim[m.special.anim], m.id + ': special.anim 无效');
    for (const [o, keys] of Object.entries(m.lines.pair || {})) {
      assert(all[o], m.id + ' 的 pair 指向未知角色 ' + o);
      for (const sc of keys.chat || []) assert(Array.isArray(sc) && sc.length >= 2 && sc.every(t => typeof t === 'string' && t.length < 40), m.id + '→' + o + ' chat 格式');
    }
    for (const o of Object.keys(all)) if (o !== m.id) assert((m.lines.pair[o] || {}).chat && m.lines.pair[o].chat.length >= 1, `${m.id}→${o} 缺少对话剧本`);
  }
  const mkp = (a, b, seed = 7) => {
    const w = new World({ width: 1280, height: 720, kinds: all, seed, clock: () => 3 });
    const pa = w.addPet(a, 500), pb = w.addPet(b, 560);
    w.enter(pa, 'idle', 99); w.enter(pb, 'idle', 99); return [w, pa, pb];
  };
  // 对话:双方按剧本交替冒泡
  { const [w, a, b] = mkp('mode', 'yidan'); w.startChat(a, b);
    const said = [];
    for (let i = 0; i < 30 * 12; i++) { w.step(1 / 30); for (const p of [a, b]) if (p.bubble && !said.some(x => x.t === p.bubble.text)) said.push({ who: p.kind, t: p.bubble.text }); }
    assert(said.length >= 3 && said[0].who === 'mode' && said[1].who === 'yidan', '对话应交替: ' + JSON.stringify(said));
    assert(['idle', 'walk'].includes(a.state) || a.state === 'react', '对话结束应回到待机:' + a.state); }
  // 看脸:Sunny 说"伟大",对方有反应
  { const [w, a, b] = mkp('sunny', 'mode'); w.startAdmire(a, b);
    let sunnySaid = null, otherSaid = null;
    for (let i = 0; i < 30 * 5; i++) { w.step(1 / 30); if (a.bubble) sunnySaid = a.bubble.text; if (b.bubble) otherSaid = b.bubble.text;
      assert(a.manifest.frames[w.frameOf(a)] && b.manifest.frames[w.frameOf(b)]); }
    assert(sunnySaid && sunnySaid.includes('伟大'), 'Sunny 应说伟大: ' + sunnySaid);
    assert(otherSaid, '对方应有反应'); }
  // 右键"看脸"(special):Sunny 身旁有人 → 触发 admire
  { const [w, a, b] = mkp('sunny', 'nannan'); w.special(a.id);
    assert(w.events.some(e => e.type === 'admire'), 'special 应触发看脸'); }
  // 每个角色的专属动作都能跑
  for (const k of Object.keys(all)) { const w = new World({ width: 1000, height: 600, kinds: all, seed: 3 }); const p = w.addPet(k, 500); w.enter(p, 'idle', 99); w.special(p.id);
    for (let i = 0; i < 100; i++) { w.step(1 / 30); assert(p.manifest.frames[w.frameOf(p)], k + ' special 帧无效'); } }
  // 安慰
  { const [w, a, b] = mkp('mengyu', 'nannan'); w.startComfort(a, b);
    const seenText = new Set(); for (let i = 0; i < 30 * 5; i++) { w.step(1 / 30); if (a.bubble) seenText.add(a.bubble.text); if (b.bubble) seenText.add(b.bubble.text); }
    assert(seenText.size >= 2, '安慰应双方说话'); }
  // 路过睡着的人
  { const [w, a, b] = mkp('yidan', 'sunny'); w.enter(b, 'sleep', 99); w.pairCooldown.clear(); let ok = false;
    for (let i = 0; i < 30 * 60 && !ok; i++) { w.step(1 / 30); ok = w.events.some(e => e.type === 'see_sleep'); }
    assert(ok, '路过睡着的人应触发 see_sleep'); }
  // 深夜台词
  { const w = new World({ width: 1000, height: 600, kinds: all, seed: 5, clock: () => 3 }); const p = w.addPet('mode', 500);
    const night = new Set(all.mode.lines.night); let hit = false;
    for (let i = 0; i < 30 * 900 && !hit; i++) { w.step(1 / 30); if (p.bubble && night.has(p.bubble.text)) hit = true; }
    assert(hit, '深夜应说 night 台词'); }
  console.log('OK 新互动: 对话/看脸/安慰/专属动作/路过睡着/时间台词');
}
console.log('ALL PASSED');
