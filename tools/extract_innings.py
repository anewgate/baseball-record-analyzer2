#!/usr/bin/env python3
"""스캔본의 볼카운트(타석 다이아몬드) 영역을 이닝별 이미지로 잘라낸다.

동작
  1. 인쇄된 파란 괘선만 색으로 분리해 9행 x 14열 격자를 검출한다.
     한 열은 '볼카운트 스트립(약 47px) + 다이아몬드(약 173px)' 로 나뉜다.
  2. 칸마다 연필 잉크량을 세어 타석이 기록된 칸인지 판정한다.
  3. 타순 1->9->1 연속성을 따라 걸으며 이닝을 끊는다.
       - 빈 칸을 만나면 그 이닝의 끝. 다음 이닝은 '다음 열의 같은 타순 행' 에서 시작.
       - 한 열 9칸을 다 쓰면(타순 한 바퀴) 같은 이닝이 다음 열로 이어진다.
  4. 이닝별 이미지 / 타석순 스트립 / 칸 단위 이미지 / manifest.json 을 쓴다.

data/parsed/<시트>.json 이 있으면 투수표 타자수·라인스코어와 대조해 검증 결과를 찍는다.

사용:
    python3 tools/extract_innings.py                # data/records/*.jpg 전부
    python3 tools/extract_innings.py 20230402-A     # 시트 하나만
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RECORDS = ROOT / "data" / "records"
PARSED = ROOT / "data" / "parsed"
OUT_ROOT = ROOT / "data" / "innings"

NROWS = 9            # 타순 1~9 (교대란은 다이아몬드가 없어 제외)
NCOLS = 14           # 기록지의 이닝 칸 수
STRIP_W = 47         # 각 이닝 칸 왼쪽의 볼/스트라이크 스트립 너비(원본 px 기준)

FONTS = [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
]


# --------------------------------------------------------------------------- 색 분리

def masks(img: Image.Image):
    """(파란 괘선, 빨간 펜, 연필) 세 가지 마스크."""
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    blue = ((b - r) > 28) & (b > 80) & (r < 215)
    red = ((r - b) > 45) & ((r - g) > 35) & (r > 90)
    pencil = ((r + g + b) < 430) & ~red & ~blue
    return blue, red, pencil


# --------------------------------------------------------------------------- 격자 검출

def _runs(idx: np.ndarray, gap: int) -> list[list[int]]:
    out: list[list[int]] = []
    for i in idx:
        if not out or i - out[-1][-1] > gap:
            out.append([int(i)])
        else:
            out[-1].append(int(i))
    return out


def _regular(cands: list[int], lo: float, hi: float, what: str):
    """간격이 일정한 최장 사슬을 찾아 (사슬, 원점, 피치) 를 돌려준다.

    필기에 가려 몇 개가 안 잡혀도 되도록 피치의 정수배(최대 3배)까지 이어붙인다.
    """
    diffs = [b - a for a, b in zip(cands, cands[1:]) if lo <= b - a <= hi]
    if not diffs:
        raise SystemExit(f"{what} 괘선을 찾지 못했습니다 (스캔 상태 확인 필요)")
    pitch = float(np.median(diffs))
    best: list[int] = []
    for i in range(len(cands)):
        chain = [cands[i]]
        for x in cands[i + 1:]:
            m = (x - chain[-1]) / pitch
            if abs(m - round(m)) <= 0.06 and 1 <= round(m) <= 3:
                chain.append(x)
        if len(chain) > len(best):
            best = chain
    ks = [round((x - best[0]) / pitch) for x in best]
    slope, origin = np.polyfit(np.asarray(ks, float), np.asarray(best, float), 1)
    return best, float(origin), float(slope)


def find_grid(blue: np.ndarray) -> tuple[list[float], list[float]]:
    """다이아몬드 영역의 세로 경계 15개, 가로 경계 10개를 돌려준다."""
    h, w = blue.shape

    # 세로선: 손글씨가 덜한 y 구간에서 투영
    y0b, y1b = int(h * 0.15), int(h * 0.57)
    vp = blue[y0b:y1b, :].sum(axis=0)
    cand = [int(np.mean(g)) for g in _runs(np.where(vp > (y1b - y0b) * 0.45)[0], 6)]
    # '경계선 + STRIP_W 뒤 보조선' 쌍을 이루는 것만이 이닝 칸 경계다
    majors = [x for x in cand if any(abs(x + STRIP_W - o) <= 8 for o in cand)]
    chain, x0, dx = _regular(majors, 180, 260, "세로")
    xs = [x0 + dx * k for k in range(NCOLS + 1)]          # 첫 칸 왼쪽 경계가 기준
    if not any(abs(xs[NCOLS] - o) <= 15 for o in cand):
        print(f"  경고: {NCOLS}번째 열 오른쪽 경계({xs[NCOLS]:.0f})에 괘선이 없습니다")

    # 가로선: 다이아몬드 x 범위 안에서만 투영.
    # 이닝번호 헤더 행도 본문 행과 높이가 같아 사슬에 끼므로 '아래에서 9행' 으로 앵커한다.
    xa, xb = int(xs[0]), int(xs[-1])
    hp = blue[:, xa:xb].sum(axis=1)
    cand_y = [int(np.mean(g)) for g in _runs(np.where(hp > (xb - xa) * 0.55)[0], 8)]
    chain_y, _, dy = _regular(cand_y, 150, 240, "가로")
    if len(chain_y) < NROWS + 1:
        raise SystemExit(f"가로 괘선이 {len(chain_y)}개뿐입니다 (타순 {NROWS}행을 잡을 수 없음)")
    bottom = chain_y[-1]
    ys = [bottom - dy * (NROWS - k) for k in range(NROWS + 1)]
    return xs, ys


# --------------------------------------------------------------------------- 칸 판정

def cell_counts(mask: np.ndarray, xs, ys, pad: int = 5) -> np.ndarray:
    out = np.zeros((NROWS, NCOLS), dtype=int)
    for r in range(NROWS):
        ya, yb = int(ys[r]) + pad, int(ys[r + 1]) - pad
        for c in range(NCOLS):
            xa, xb = int(xs[c]) + pad, int(xs[c + 1]) - pad
            out[r, c] = int(mask[ya:yb, xa:xb].sum())
    return out


def split_threshold(vals: np.ndarray) -> tuple[float, float]:
    """빈 칸 / 쓴 칸을 가르는 임계값과 분리도(쓴칸 최소 / 빈칸 최대)."""
    v = np.sort(vals.ravel().astype(float))
    i = int(np.argmax(np.diff(v)))
    thr = (v[i] + v[i + 1]) / 2
    sep = (v[i + 1] / v[i]) if v[i] > 0 else float("inf")
    return float(thr), float(sep)


# --------------------------------------------------------------------------- 이닝 분할

def walk_innings(occ: np.ndarray) -> list[list[tuple[int, int]]]:
    """타순 연속성을 따라 걸으며 이닝별 (행, 열) 목록을 만든다."""
    used = np.zeros_like(occ, dtype=bool)
    innings: list[list[tuple[int, int]]] = []
    cur: list[tuple[int, int]] = []
    r, c = 0, 0
    while c < NCOLS:
        if occ[r, c] and not used[r, c]:
            used[r, c] = True
            cur.append((r, c))
            r = (r + 1) % NROWS
            continue
        if not occ[r, c] and cur:
            innings.append(cur)          # 빈 칸 = 이닝 종료
            cur = []
        c += 1                            # 이미 쓴 칸이면 같은 이닝이 다음 열로 이어짐
    if cur:
        innings.append(cur)
    return innings


# --------------------------------------------------------------------------- 그리기

def load_font(size: int):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def dim(img: Image.Image, box, amount: float = 0.82) -> None:
    """상자 안을 흰색 쪽으로 옅게 만든다(해당 이닝이 아닌 칸)."""
    region = np.asarray(img.crop(box)).astype(np.float32)
    region = 255 - (255 - region) * (1 - amount)
    img.paste(Image.fromarray(region.astype(np.uint8)), box[:2])


def render_inning(page: Image.Image, xs, ys, cells, inning: int, out: Path) -> None:
    """해당 이닝이 걸친 열 전체를 자르고, 이 이닝이 아닌 칸은 흐리게."""
    cols = sorted({c for _, c in cells})
    left = max(0, int(xs[0]) - 690)                 # 수비위치·선수명 칸까지 함께
    box = (left, int(ys[0]) - 66, int(xs[cols[-1] + 1]) + 16, int(ys[NROWS]) + 8)
    img = page.crop(box).convert("RGB")
    ox, oy = box[0], box[1]
    keep = set(cells)
    for r in range(NROWS):
        for c in cols:
            if (r, c) not in keep:
                dim(img, (int(xs[c]) - ox, int(ys[r]) - oy,
                          int(xs[c + 1]) - ox, int(ys[r + 1]) - oy))
    d = ImageDraw.Draw(img)
    font = load_font(34)
    for i, (r, c) in enumerate(cells, 1):
        x0, y0 = int(xs[c]) - ox, int(ys[r]) - oy
        x1, y1 = int(xs[c + 1]) - ox, int(ys[r + 1]) - oy
        d.rectangle([x0, y0, x1, y1], outline=(0, 140, 0), width=5)
        d.rectangle([x0 + 6, y0 + 6, x0 + 52, y0 + 44], fill=(0, 140, 0))
        d.text((x0 + 14, y0 + 8), str(i), fill=(255, 255, 255), font=font)
    title = f"{inning}회  ({len(cells)}타석)"
    tf = load_font(46)
    d.rectangle([0, 0, d.textlength(title, font=tf) + 20, 60], fill=(255, 255, 255))
    d.text((10, 4), title, fill=(0, 110, 0), font=tf)
    img.save(out)


def render_sequence(page: Image.Image, xs, ys, cells, names, out: Path) -> None:
    """타석 순서대로 칸을 가로로 이어 붙인다 (읽기용)."""
    cw, ch, lab = int(xs[1] - xs[0]), int(ys[1] - ys[0]), 46
    strip = Image.new("RGB", (cw * len(cells), ch + lab), (255, 255, 255))
    d = ImageDraw.Draw(strip)
    font = load_font(28)
    for i, (r, c) in enumerate(cells):
        cell = page.crop((int(xs[c]), int(ys[r]), int(xs[c]) + cw, int(ys[r]) + ch))
        strip.paste(cell, (cw * i, lab))
        d.rectangle([cw * i, lab, cw * i + cw - 1, lab + ch - 1], outline=(150, 150, 150))
        name = names[r] if r < len(names) and names[r] else ""
        d.text((cw * i + 6, 10), f"{i + 1}. {r + 1}번 {name}", fill=(0, 0, 0), font=font)
    strip.save(out)


# --------------------------------------------------------------------------- 검증

def verify(sheet: str, innings) -> list[str]:
    path = PARSED / f"{sheet}.json"
    if not path.exists():
        return [f"  (data/parsed/{sheet}.json 없음 - 대조 생략)"]
    data = json.loads(path.read_text(encoding="utf-8"))
    line = data["linescore"][0 if data.get("form") == "top" else 1]["innings"]
    faced = sum(int(p["batters"]) for p in data.get("pitchers", [])
                if str(p.get("batters", "")).strip())
    pa = sum(len(c) for c in innings)

    lines = [f"  총 타석  판독 {pa}  vs 투수표 타자수 {faced}   "
             f"{'일치' if pa == faced else '*** 불일치 ***'}",
             "  이닝  타석  득점  잔루(=타석-득점-3아웃)  사용 칸"]
    for i, cells in enumerate(innings):
        runs = int(line[i]) if i < len(line) and str(line[i]).strip() else 0
        cols = sorted({c + 1 for _, c in cells})
        rows = "".join(str(r + 1) for r, _ in cells)
        lines.append(f"   {i + 1}회   {len(cells):>2}    {runs:>2}      "
                     f"{len(cells) - runs - 3:>2}            열{cols} 타순 {rows}")
    return lines


# --------------------------------------------------------------------------- 실행

def process(sheet: str) -> None:
    page = Image.open(RECORDS / f"{sheet}.jpg")
    blue, red, pencil = masks(page)
    xs, ys = find_grid(blue)

    ink = cell_counts(pencil, xs, ys)
    redink = cell_counts(red, xs, ys)
    thr, sep = split_threshold(ink)
    occ = ink > thr

    innings = walk_innings(occ)

    names: list[str] = []
    parsed = PARSED / f"{sheet}.json"
    if parsed.exists():
        slots = json.loads(parsed.read_text(encoding="utf-8"))["slots"]
        names = [(s["rows"][0] or {}).get("name", "") for s in slots[:NROWS]]

    out = OUT_ROOT / sheet
    if out.exists():
        shutil.rmtree(out)          # 이전 실행 결과가 섞이지 않게 비우고 시작
    (out / "cells").mkdir(parents=True)

    for i, cells in enumerate(innings, 1):
        render_inning(page, xs, ys, cells, i, out / f"inning-{i}.png")
        render_sequence(page, xs, ys, cells, names, out / f"inning-{i}-seq.png")
        for n, (r, c) in enumerate(cells, 1):
            page.crop((int(xs[c]), int(ys[r]), int(xs[c + 1]), int(ys[r + 1]))).save(
                out / "cells" / f"i{i}-pa{n}-slot{r + 1}.png")

    manifest = {
        "sheet": sheet,
        "grid": {"x": [round(v, 1) for v in xs], "y": [round(v, 1) for v in ys],
                 "cols": NCOLS, "rows": NROWS, "stripWidth": STRIP_W},
        "occupancyThreshold": round(thr, 1),
        "separation": round(sep, 1),
        "innings": [
            {"inning": i,
             "pa": len(cells),
             "cells": [{"pa": n, "slot": r + 1, "col": c + 1,
                        "name": names[r] if r < len(names) else "",
                        "box": [int(xs[c]), int(ys[r]), int(xs[c + 1]), int(ys[r + 1])],
                        "pencil": int(ink[r, c]), "red": int(redink[r, c])}
                       for n, (r, c) in enumerate(cells, 1)]}
            for i, cells in enumerate(innings, 1)],
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[{sheet}] 격자 x0={xs[0]:.0f} 열간격={xs[1] - xs[0]:.1f} "
          f"y0={ys[0]:.0f} 행간격={ys[1] - ys[0]:.1f}")
    print(f"          칸 사용 판정 임계 {thr:.0f} (분리도 {sep:.1f}배), "
          f"{int(occ.sum())}칸 사용, {len(innings)}이닝")
    for ln in verify(sheet, innings):
        print(ln)
    print(f"          -> {out.relative_to(ROOT)}/")


def main() -> None:
    want = sys.argv[1:]
    sheets = want or sorted(p.stem for p in RECORDS.glob("*.jpg"))
    for s in sheets:
        process(s)


if __name__ == "__main__":
    main()
