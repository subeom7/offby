"""폰트를 페이지에서 실제로 쓰는 글자만 남기고 잘라 self-host용 woff2로 만든다.

    python tools/build_fonts.py

왜 필요한가. 원본은 Google Fonts CDN을 참조했다. 그러면 (1) 첫 렌더가 외부
서버 왕복만큼 늦고, (2) 방문자 IP가 구글로 넘어가고, (3) 그쪽이 죽으면 같이
영향을 받는다. 정적 사이트라 폰트를 같이 배포해도 비용이 0이다.

한글 폰트는 통째로 넣으면 웨이트당 수 MB다. 이 페이지가 쓰는 한글은 100자
남짓이라 서브셋하면 수십 KB로 줄어든다. 필요한 글자 목록은 손으로 적지 않고
index.html에서 직접 뽑는다 — 문구를 고치고 다시 돌리면 알아서 맞춰진다.

두 폰트 모두 SIL Open Font License다. 재배포가 허용되며 라이선스 파일을
같이 넣는다(public/fonts/OFL-*.txt).
"""

from __future__ import annotations

import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "public" / "index.html"
OUT = ROOT / "public" / "fonts"
CACHE = ROOT / "tools" / ".fontcache"

GF = "https://raw.githubusercontent.com/google/fonts/main"

# Azeret Mono는 가변 폰트라 파일 하나로 400/500/700을 모두 커버한다.
# IBM Plex Sans KR은 가변 버전이 없어 웨이트별로 받는다.
SOURCES = [
    ("AzeretMono[wght].ttf", f"{GF}/ofl/azeretmono/AzeretMono%5Bwght%5D.ttf"),
    ("IBMPlexSansKR-Regular.ttf", f"{GF}/ofl/ibmplexsanskr/IBMPlexSansKR-Regular.ttf"),
    ("IBMPlexSansKR-Medium.ttf", f"{GF}/ofl/ibmplexsanskr/IBMPlexSansKR-Medium.ttf"),
    ("IBMPlexSansKR-SemiBold.ttf", f"{GF}/ofl/ibmplexsanskr/IBMPlexSansKR-SemiBold.ttf"),
]

LICENSES = [
    ("OFL-AzeretMono.txt", f"{GF}/ofl/azeretmono/OFL.txt"),
    ("OFL-IBMPlexSansKR.txt", f"{GF}/ofl/ibmplexsanskr/OFL.txt"),
]


def fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  받는 중 {dest.name}")
    with urllib.request.urlopen(url) as response:
        dest.write_bytes(response.read())
    return dest


def charset() -> str:
    """index.html에 등장하는 모든 문자.

    JS 문자열 안의 문구까지 빠짐없이 잡으려면 파일 전체에서 뽑는 게 가장
    안전하다. 코드에 쓰인 라틴 문자까지 딸려 오지만 그쪽은 어차피 가볍다.
    """
    text = HTML.read_text(encoding="utf-8")
    chars = {c for c in text if c.isprintable() and not c.isspace()}
    # 폰트가 바뀌어도 깨지면 안 되는 것들을 명시적으로 더한다
    chars |= set("0123456789.,+-−±%초 ")
    return "".join(sorted(chars))


def subset(src: Path, dest: Path, text: str, variable: bool) -> None:
    args = [
        sys.executable, "-m", "fontTools.subset", str(src),
        f"--text={text}",
        "--flavor=woff2",
        f"--output-file={dest}",
        "--layout-features=kern,liga,tnum,calt",
        "--desubroutinize",
        "--name-IDs=1,2,3,4,5,6",
    ]
    if variable:
        # 가변 축을 유지해야 파일 하나로 여러 웨이트를 쓸 수 있다
        args.append("--recalc-bounds")
    subprocess.run(args, check=True)


def main() -> int:
    if not HTML.exists():
        print(f"index.html이 없습니다: {HTML}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    text = charset()
    hangul = sum(1 for c in text if "가" <= c <= "힣")
    print(f"글자 {len(text)}자 (한글 {hangul}자)")

    for name, url in LICENSES:
        fetch(url, OUT / name)

    print("\n서브셋:")
    total_before = total_after = 0
    for name, url in SOURCES:
        src = fetch(url, CACHE / name)
        dest = OUT / (src.stem.replace("[wght]", "-var") + ".woff2")
        subset(src, dest, text, variable="[wght]" in name)
        before, after = src.stat().st_size, dest.stat().st_size
        total_before += before
        total_after += after
        print(f"  {dest.name:<34} {before/1024:>8,.0f}KB -> {after/1024:>6,.1f}KB"
              f"  ({after/before*100:.1f}%)")

    print(f"\n  합계  {total_before/1024/1024:.1f}MB -> {total_after/1024:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
