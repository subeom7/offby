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

import hashlib
import re
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


FONT_SRC = re.compile(r'(src:url\(")fonts/([A-Za-z\-]+)(?:\.[0-9a-f]{8})?(\.woff2"\))')


def charset(html: str) -> str:
    """index.html에 등장하는 모든 문자.

    JS 문자열 안의 문구까지 빠짐없이 잡으려면 파일 전체에서 뽑는 게 가장
    안전하다. 코드에 쓰인 라틴 문자까지 딸려 오지만 그쪽은 어차피 가볍다.

    단, 폰트 파일명은 빼고 센다. 파일명에 내용 해시가 들어가는데 그 해시
    문자가 글자 목록에 섞이면 서브셋이 바뀌고 -> 해시가 또 바뀌는 순환이
    생긴다. 빌드가 수렴하지 않으면 CI의 최신 여부 검사도 성립하지 않는다.
    """
    stripped = FONT_SRC.sub(r"\1\2\3", html)
    chars = {c for c in stripped if c.isprintable() and not c.isspace()}
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
    html = HTML.read_text(encoding="utf-8")
    text = charset(html)
    hangul = sum(1 for c in text if "가" <= c <= "힣")
    print(f"글자 {len(text)}자 (한글 {hangul}자)")

    for name, url in LICENSES:
        fetch(url, OUT / name)

    print("\n서브셋:")
    total_before = total_after = 0
    built: dict[str, str] = {}          # 기본이름 -> 해시 붙은 파일명

    for name, url in SOURCES:
        src = fetch(url, CACHE / name)
        stem = src.stem.replace("[wght]", "-var")
        tmp = OUT / f"{stem}.tmp.woff2"
        subset(src, tmp, text, variable="[wght]" in name)

        # 파일명에 내용 해시를 넣는다. 그래야 캐시를 1년으로 걸어도
        # 글자가 바뀐 순간 URL이 달라져 새 파일을 받아 간다. 해시가 없으면
        # 긴 캐시는 두부 글자를 그만큼 오래 남긴다.
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()[:8]
        dest = OUT / f"{stem}.{digest}.woff2"
        tmp.replace(dest)
        built[stem] = dest.name

        before, after = src.stat().st_size, dest.stat().st_size
        total_before += before
        total_after += after
        print(f"  {dest.name:<42} {before/1024:>8,.0f}KB -> {after/1024:>6,.1f}KB"
              f"  ({after/before*100:.1f}%)")

    # 해시가 바뀌면 예전 파일이 남는다. 배포 산출물에 쓰레기를 쌓지 않는다.
    removed = 0
    for old in OUT.glob("*.woff2"):
        if old.name not in built.values():
            old.unlink()
            removed += 1

    # index.html의 @font-face src를 새 파일명으로 갱신
    updated = FONT_SRC.sub(lambda m: f"{m.group(1)}fonts/{built[m.group(2)]}\")", html)
    if updated != html:
        HTML.write_text(updated, encoding="utf-8")
        print("\n  index.html의 폰트 경로 갱신")
    if removed:
        print(f"  이전 해시 파일 {removed}개 삭제")

    print(f"\n  합계  {total_before/1024/1024:.1f}MB -> {total_after/1024:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
