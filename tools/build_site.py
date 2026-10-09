#!/usr/bin/env python3
"""Assemble the GitHub Pages site: docs/ plus one config panel per release channel.

    python3 tools/build_site.py OUT_DIR [--stable-ref REF]

    index.html    the stable panel: docs/index.html as of REF (the newest non-prerelease release's tag). Without
                  --stable-ref (no release yet) it is the working tree's panel, unmodified.
    nightly.html  the bleeding-edge panel: the working tree's docs/index.html (main), under a banner naming the
                  commit it was built from and linking back to the stable panel.

Every other file in docs/ is copied from the working tree. Pages replaces the whole site on each deploy, so the
caller (pages.yml) runs this for both pages every time rather than patching one of them.
"""
import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
TITLE = "<title>OpenPuck Config</title>"
BANNER_CSS = (
    "<style>\n"
    "  #channelBanner{padding:6px 18px;background:#2a2412;border-bottom:1px solid #4a3f1a;color:var(--warn);"
    "font-size:12px}\n"
    "  #channelBanner a{color:var(--acc2)}\n"
    "</style>\n"
)


def fail(msg):
    sys.exit(f"build_site: {msg}")


def git(*args):
    r = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)
    if r.returncode:
        fail(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def nightly_page(html, build):
    # Plain string edits rather than parsing: the stamp only needs the title and the opening <body>, and fails
    # loudly if the page ever stops having them
    if TITLE not in html or "<body>\n" not in html or "</head>" not in html:
        fail("docs/index.html has no <title>OpenPuck Config</title>, </head> or <body> to stamp")
    banner = (
        '<div id="channelBanner"><b>NIGHTLY</b> panel built from <code>' + build + "</code> (main). It can "
        'expect firmware newer than the last release; for a promoted build use the <a href="index.html">stable '
        "panel</a>.</div>\n"
    )
    html = html.replace(TITLE, "<title>OpenPuck Config (nightly)</title>", 1)
    html = html.replace("</head>", BANNER_CSS + "</head>", 1)
    return html.replace("<body>\n", "<body>\n" + banner, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--stable-ref", help="git ref whose docs/index.html becomes index.html")
    args = ap.parse_args()

    if args.out.exists():
        shutil.rmtree(args.out)
    shutil.copytree(DOCS, args.out)

    head = (DOCS / "index.html").read_text()
    build = "ripps-" + git("rev-parse", "--short=8", "HEAD").strip()
    (args.out / "nightly.html").write_text(nightly_page(head, build))

    if args.stable_ref:
        (args.out / "index.html").write_text(git("show", f"{args.stable_ref}:docs/index.html"))
        print(f"index.html: {args.stable_ref}; nightly.html: {build}")
    else:
        print(f"index.html: working tree (no stable ref); nightly.html: {build}")


if __name__ == "__main__":
    main()
