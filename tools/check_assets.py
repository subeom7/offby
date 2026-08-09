"""배포 산출물이 index.html과 어긋나지 않았는지 검사한다.

    python tools/check_assets.py

잡으려는 버그는 하나다. **문구를 고치고 `npm run fonts`를 잊는 것.**
서브셋에 없는 글자는 브라우저에서 두부(□)로 뜨는데, 눈으로 보기 전까지
아무도 모른다.

처음에는 CI에서 폰트를 다시 만들어 커밋된 것과 바이트 비교했다. 폰트(woff2)는
그게 통했지만 og.png는 실패했다 — Pillow/FreeType 빌드가 다르면 래스터화
결과가 미세하게 달라져서 리눅스 CI와 윈도우 로컬의 PNG가 절대 같아지지
않는다. 바이트 동일성은 애초에 검사 대상이 아니었다.

그래서 바이트 대신 **불변식**을 본다. 재생성이 필요 없어 네트워크도 안 쓴다.

  1. index.html이 그리는 모든 글자가 해당 폰트 파일에 들어 있는가
  2. @font-face가 가리키는 파일이 실제로 있는가
  3. og:image가 선언한 크기와 실제 PNG 크기가 같은가
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
HTML = PUBLIC / "index.html"

HANGUL_RANGES = ((0xAC00, 0xD7A3), (0x1100, 0x11FF), (0x3130, 0x318F))


def is_hangul(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in HANGUL_RANGES)


def rendered_chars(html: str) -> set[str]:
    """화면에 실제로 그려질 수 있는 문자.

    태그 사이의 텍스트와 JS 문자열 리터럴을 모은다. 코드 식별자까지 딸려
    오지만 그쪽은 어차피 라틴이라 무해하다. 놓치는 것보다 넉넉한 게 낫다.
    """
    body = html.split("<body>", 1)[1]
    chars: set[str] = set()
    for text in re.findall(r">([^<>]+)<", body):
        chars |= set(text)
    for lit in re.findall(r"'([^'\\\n]*)'", body) + re.findall(r'"([^"\\\n]*)"', body):
        chars |= set(lit)
    return {c for c in chars if c.isprintable() and not c.isspace()}


def coverage(path: Path) -> set[str]:
    font = TTFont(path)
    try:
        codes: set[int] = set()
        for table in font["cmap"].tables:
            codes |= set(table.cmap)
        return {chr(c) for c in codes}
    finally:
        font.close()


def main() -> int:
    html = HTML.read_text(encoding="utf-8")
    chars = rendered_chars(html)
    hangul = {c for c in chars if is_hangul(c)}
    latin = {c for c in chars if c.isascii()}
    print(f"index.html이 그리는 문자: {len(chars)}자 (한글 {len(hangul)}, ASCII {len(latin)})\n")

    failures: list[str] = []

    # 1 + 2. @font-face가 가리키는 파일이 있는가, 필요한 글자를 담고 있는가
    refs = re.findall(r'src:url\("(fonts/[^"]+\.woff2)"\)', html)
    if not refs:
        failures.append("@font-face 참조를 하나도 찾지 못했습니다")

    for ref in refs:
        path = PUBLIC / ref
        if not path.exists():
            failures.append(f"{ref} — 파일이 없습니다 (npm run fonts 를 돌리세요)")
            print(f"  [X] {ref}  파일 없음")
            continue

        have = coverage(path)
        need = hangul if "KR" in path.name else latin
        missing = sorted(need - have)
        size = path.stat().st_size / 1024
        if missing:
            failures.append(f"{ref} — 글자 {len(missing)}개 누락: {''.join(missing[:20])}")
            print(f"  [X] {path.name:<44} {size:>6.1f}KB  누락 {len(missing)}자:"
                  f" {''.join(missing[:20])}")
        else:
            print(f"  [o] {path.name:<44} {size:>6.1f}KB  글리프 {len(have)}")

    # 3. og:image 선언과 실제 파일이 맞는가
    print()
    og = PUBLIC / "og.png"
    if not og.exists():
        failures.append("public/og.png 가 없습니다 (npm run og 를 돌리세요)")
        print("  [X] og.png  파일 없음")
    else:
        # PNG IHDR: 8바이트 시그니처 + 4길이 + 4타입 다음에 width/height
        raw = og.read_bytes()[16:24]
        width, height = int.from_bytes(raw[:4], "big"), int.from_bytes(raw[4:], "big")
        declared = (
            int(re.search(r'og:image:width" content="(\d+)"', html).group(1)),
            int(re.search(r'og:image:height" content="(\d+)"', html).group(1)),
        )
        if (width, height) != declared:
            failures.append(f"og.png 크기 {width}x{height} != 선언 {declared[0]}x{declared[1]}")
            print(f"  [X] og.png  {width}x{height} (선언은 {declared[0]}x{declared[1]})")
        else:
            print(f"  [o] og.png  {width}x{height}  {og.stat().st_size/1024:.0f}KB")

    print()
    if failures:
        print("실패:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("모두 통과")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
