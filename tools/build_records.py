#!/usr/bin/env python3
"""data/parsed/*.json 을 web/records.js 로 묶는다.

file:// 로 열어도 동작하도록 fetch 대신 전역 변수로 주입한다.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "parsed"
OUT = ROOT / "web" / "records.js"


def main() -> None:
    sheets = {}
    for path in sorted(SRC.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        sheets[data.get("id", path.stem)] = data

    body = json.dumps(sheets, ensure_ascii=False, indent=2)
    OUT.write_text(
        "/* 자동 생성 파일 - 직접 고치지 말 것.\n"
        "   원본: data/parsed/*.json,  생성: python3 tools/build_records.py */\n"
        f"window.SCORESHEETS = {body};\n",
        encoding="utf-8",
    )
    print(f"{OUT.relative_to(ROOT)} <- {len(sheets)} sheet(s): {', '.join(sheets)}")


if __name__ == "__main__":
    main()
