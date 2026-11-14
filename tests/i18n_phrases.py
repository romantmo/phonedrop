"""Достаёт из интерфейса все фразы, которым нужен перевод (их же проверяет тест)."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "app" / "static"
CYR = re.compile("[А-Яа-яЁё]")
TX = re.compile(r"""\btx\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
ATTRS = {"placeholder", "title", "aria-label", "alt"}


class _Texts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found, self.skip, self.in_body, self.in_title = set(), 0, False, False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "body":
            self.in_body = True
        self.in_title = tag == "title"
        for k, v in attrs:
            if k in ATTRS and v and CYR.search(v):
                self.found.add(v.strip())

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1
        self.in_title = False

    def handle_data(self, data):
        if (self.in_body or self.in_title) and not self.skip and CYR.search(data):
            self.found.add(data.strip())


def js_phrases() -> set[str]:
    found = set()
    for f in STATIC.glob("*.js"):
        if f.name.startswith("i18n"):
            continue
        for lit in TX.findall(f.read_text("utf-8")):
            if lit.startswith("'"):
                lit = '"' + lit[1:-1].replace('\\\'', "'").replace('"', '\\"') + '"'
            found.add(json.loads(lit))
    found.add("🌐 Язык")
    found.add("Как на устройстве")
    return found


def html_phrases() -> set[str]:
    found = set()
    for f in STATIC.glob("*.html"):
        p = _Texts()
        p.feed(f.read_text("utf-8"))
        found |= p.found
    return found


def words() -> dict:
    src = (STATIC / "i18n-words.js").read_text("utf-8")
    body = src[src.index("{"): src.rindex("}") + 1]
    return json.loads(body)


if __name__ == "__main__":
    for s in sorted(js_phrases() | html_phrases()):
        print(json.dumps(s, ensure_ascii=False))
