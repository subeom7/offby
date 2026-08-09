"""링크 공유용 og:image(1200x630)를 만든다.

    python tools/build_og.py

카카오톡·슬랙·트위터·디스코드에 링크를 붙이면 이 이미지가 뜬다. 게임 화면을
그대로 캡처하지 않고 다시 그리는 이유: OG 이미지는 보통 500px 안팎으로
축소돼 표시된다. 실제 화면을 줄이면 큰 숫자 말고는 아무것도 안 읽힌다.
그래서 큰 요소만 남기고 재구성했다.

색과 폰트는 게임과 같은 것을 쓴다(build_fonts.py가 받아 둔 원본 TTF).
기본 언어가 영어라 이미지도 영어다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fonts import CACHE, SOURCES, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "og.png"

W, H = 1200, 630

DESK, DESK2 = (0x19, 0x1A, 0x1E), (0x23, 0x24, 0x29)
PAPER = (0xFC, 0xF8, 0xF5)
GRID_FINE, GRID_BOLD = (0xF4, 0xD2, 0xC8), (0xE5, 0xA0, 0x91)
INK, INK_SOFT = (0x17, 0x12, 0x0F), (0x7C, 0x71, 0x6B)
PEN_GOOD, PEN_BAD = (0x0F, 0x7A, 0x6B), (0xBE, 0x3A, 0x29)
EDGE = (0xE4, 0xD8, 0xD1)

_BY_NAME = {name: url for name, url, _ in SOURCES}


def font(name: str, size: int, weight: int | None = None) -> ImageFont.FreeTypeFont:
    """캐시된 원본 TTF에서 폰트를 만든다. 가변 폰트는 웨이트를 지정한다."""
    src = fetch(_BY_NAME[name], CACHE / name)
    f = ImageFont.truetype(str(src), size)
    if weight is not None:
        # 축 순서는 폰트마다 다르다(Plex Sans는 wdth, wght). 이름으로 찾는다.
        axes = f.get_variation_axes()
        values = []
        for axis in axes:
            tag = axis["name"]
            tag = tag.decode() if isinstance(tag, bytes) else str(tag)
            values.append(weight if "eight" in tag or tag == "wght" else axis["default"])
        f.set_variation_by_axes(values)
    return f


MONO = "AzeretMono[wght].ttf"
SANS = "IBMPlexSans[wdth,wght].ttf"


def desk_background() -> Image.Image:
    """게임 body의 radial-gradient를 그대로 재현한다."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((x - W / 2) / (W * 0.60)) ** 2 + (y / (H * 0.90)) ** 2)
    t = np.clip(d / 0.62, 0, 1)[..., None]
    rgb = np.array(DESK2, np.float32) * (1 - t) + np.array(DESK, np.float32) * t
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def grid(draw: ImageDraw.ImageDraw, box, fine=14, bold=70) -> None:
    x0, y0, x1, y1 = box
    for step, color in ((fine, GRID_FINE), (bold, GRID_BOLD)):
        for x in range(x0, x1, step):
            draw.line([(x, y0), (x, y1)], fill=color, width=1)
        for y in range(y0, y1, step):
            draw.line([(x0, y), (x1, y)], fill=color, width=1)


def main() -> int:
    img = desk_background()

    # ── 종이 카드 (그림자 먼저) ──────────────────
    card = (110, 50, 1090, 530)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (card[0] + 6, card[1] + 24, card[2] + 6, card[3] + 28), 10, fill=(0, 0, 0, 160))
    img = Image.alpha_composite(
        img.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(26))).convert("RGB")

    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(card, 8, fill=PAPER)
    cx = (card[0] + card[2]) // 2

    # 앵커를 쓴다. 좌표를 눈대중으로 맞추면 폰트가 바뀔 때마다 어긋난다.
    #   "ls" = 왼쪽/베이스라인, "ms" = 가운데/베이스라인, "mm" = 정중앙

    # ── 머리 (계측기 라벨 + REC) ─────────────────
    label = font(MONO, 20, 500)
    draw.text((card[0] + 40, 90), "PRECISION TIMER", font=label, fill=INK_SOFT, anchor="ls")
    rw = draw.textlength("REC", font=label)
    draw.text((card[2] - 40, 90), "REC", font=label, fill=PEN_BAD, anchor="rs")
    draw.ellipse((card[2] - 63 - rw, 78, card[2] - 50 - rw, 91), fill=PEN_BAD)
    draw.line([(card[0] + 40, 114), (card[2] - 40, 114)], fill=EDGE, width=2)

    # ── 히어로: 목표 시간 ────────────────────────
    draw.text((cx, 158), "TARGET TIME", font=font(MONO, 22, 500), fill=INK_SOFT, anchor="ms")

    big, unit_f = font(MONO, 190, 700), font(SANS, 52, 500)
    num, unit = "5", "s"
    nw = draw.textlength(num, font=big)
    uw = draw.textlength(unit, font=unit_f)
    baseline = 310                      # 숫자와 단위가 같은 베이스라인에 선다
    left = cx - (nw + 18 + uw) / 2
    draw.text((left, baseline), num, font=big, fill=INK, anchor="ls")
    draw.text((left + nw + 18, baseline), unit, font=unit_f, fill=INK_SOFT, anchor="ls")

    # ── 판정 (게임의 보상 순간) ──────────────────
    draw.text((cx, 366), "+0.008s late", font=font(MONO, 40, 500), fill=PEN_GOOD, anchor="ms")
    badge_f = font(SANS, 24, 500)
    bw = draw.textlength("PERFECT", font=badge_f)
    draw.rounded_rectangle((cx - bw / 2 - 22, 392, cx + bw / 2 + 22, 438), 23,
                           outline=PEN_GOOD, width=2)
    draw.text((cx, 415), "PERFECT", font=badge_f, fill=PEN_GOOD, anchor="mm")

    # ── 기록계 스트립 (카드 안) ──────────────────
    strip = (card[0] + 40, 458, card[2] - 40, 512)
    draw.rectangle(strip, fill=(0xFF, 0xFB, 0xF9))
    grid(draw, strip)
    draw.rectangle(strip, outline=GRID_BOLD, width=2)
    mid = (strip[1] + strip[3]) // 2
    for x in range(strip[0] + 4, strip[2] - 4, 14):
        draw.line([(x, mid), (x + 7, mid)], fill=(120, 108, 100), width=2)

    errs = [.22, -.09, .14, -.04, .31, .02, -.18, .06, -.02, .11,
            -.25, .03, .08, -.06, .01, .17, -.12, .04, -.01, .09]
    span = (strip[3] - strip[1]) / 2 - 7
    for i, e in enumerate(errs):
        x = strip[0] + int((i + 0.5) / len(errs) * (strip[2] - strip[0]))
        y = mid + int(max(-0.6, min(0.6, e)) / 0.6 * span)
        color = PEN_GOOD if abs(e) <= 0.03 else INK
        draw.line([(x, mid), (x, y)], fill=color, width=3)
        draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color)

    # ── 브랜드 (어두운 바닥, 카드와 충분히 떨어뜨린다) ──
    brand_f, site_f = font(SANS, 44, 600), font(MONO, 22, 400)
    bwid = draw.textlength("offby", font=brand_f)
    swid = draw.textlength("offby.dev", font=site_f)
    left = cx - (bwid + 26 + swid) / 2
    draw.text((left, 592), "offby", font=brand_f, fill=PAPER, anchor="ls")
    draw.text((left + bwid + 26, 592), "offby.dev", font=site_f,
              fill=(0x8A, 0x80, 0x7A), anchor="ls")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"  {OUT.relative_to(ROOT)}  {W}x{H}  {OUT.stat().st_size/1024:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
