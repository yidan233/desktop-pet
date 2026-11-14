import sys, os, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

src, outdir = sys.argv[1], sys.argv[2]
names = ["yawn","sleep","wave","point","wave_high",
         "signature","wave_happy","surprise","think","peace",
         "walk_a","laugh","pose13","pose14","walk_b"]
if len(sys.argv) > 3: names = sys.argv[3].split(",")
COLS, ROWS, CELL = 5, 3, 256

im = Image.open(src).convert("RGB")
a = np.array(im).astype(int)
H, W = a.shape[:2]
near_white = (255 - a).max(axis=2) < 16
lab, n = ndi.label(near_white)
border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:,0], lab[:,-1]]))) - {0}
bg = np.isin(lab, list(border))
fg = ~bg
fg = ndi.binary_opening(fg, iterations=1)            # remove specks
fg_er = ndi.binary_erosion(fg, iterations=1)         # trim white halo
alpha = ndi.gaussian_filter(fg_er.astype(float), 0.7)
alpha = np.clip((alpha - 0.15) / 0.7, 0, 1)
rgba = np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)])

# group parts: dilate to merge nearby pieces of the same pose
MERGE = int(os.environ.get('SLICE_MERGE', '3'))   # 合并相邻碎片的像素距离;格子贴得很近时调小
merged = ndi.binary_dilation(fg_er, iterations=MERGE)
glab, gn = ndi.label(merged)
cw, ch = W / COLS, H / ROWS
cells = {}
areas = {}
for g in range(1, gn + 1):
    ys, xs = np.where((glab == g) & fg_er)
    if len(ys) < 30: continue
    cx, cy = xs.mean(), ys.mean()
    c = min(int(cx // cw), COLS - 1) + COLS * min(int(cy // ch), ROWS - 1)
    cells.setdefault(c, []).append(g)
    areas.setdefault(c, {})[g] = len(ys)

os.makedirs(outdir, exist_ok=True)
frames = []
for c in range(COLS * ROWS):
    mask = np.isin(glab, cells[c]) & ndi.binary_dilation(fg_er, iterations=2)
    ys, xs = np.where(mask)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    sub = rgba[y0:y1, x0:x1].copy()
    sub[..., 3] = np.where(mask[y0:y1, x0:x1], sub[..., 3], 0)
    # anchor: main group's bbox bottom & x-center
    big = max(areas[c].values())
    mains = [g for g, ar in areas[c].items() if ar >= 0.3 * big]
    my, mx = np.where(np.isin(glab, mains) & fg_er)
    anchor_x = (mx.min() + mx.max()) / 2 - x0
    anchor_y = my.max() + 1 - y0
    frames.append((sub, anchor_x, anchor_y))

# uniform scale so the biggest frame fits
maxw = max(max(f[1], f[0].shape[1] - f[1]) * 2 for f in frames)
maxabove = max(f[2] for f in frames)
maxbelow = max(f[0].shape[0] - f[2] for f in frames)
scale = min((CELL - 24) / maxw, (CELL - 24) / (maxabove + maxbelow))
base_y = int(CELL - 14 - maxbelow * scale)
meta = {"cell": CELL, "baseline": base_y, "scale": round(scale, 4), "frames": []}
for c, (sub, ax, ay) in enumerate(frames):
    im2 = Image.fromarray(sub, "RGBA")
    nw, nh = max(1, round(im2.width * scale)), max(1, round(im2.height * scale))
    im2 = im2.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    px = round(CELL / 2 - ax * scale)
    py = round(base_y - ay * scale)
    canvas.alpha_composite(im2, (max(px, 0), max(py, 0)) if px >= 0 and py >= 0 else (0, 0)) if False else canvas.paste(im2, (px, py), im2)
    fn = f"{c+1:02d}_{names[c]}.png"
    canvas.save(os.path.join(outdir, fn))
    meta["frames"].append({"index": c + 1, "name": names[c], "file": fn})
json.dump(meta, open(os.path.join(outdir, "meta.json"), "w"), indent=1, ensure_ascii=False)

# contact sheet on mid-tone + checker backgrounds
sheet = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (70, 90, 120, 255))
for i, f in enumerate(meta["frames"]):
    fr = Image.open(os.path.join(outdir, f["file"]))
    sheet.alpha_composite(fr, ((i % COLS) * CELL, (i // COLS) * CELL))
sheet.convert("RGB").save(os.path.join(outdir, "_preview_dark.png"))
print("ok", scale, base_y, {c: len(v) for c, v in cells.items()})
