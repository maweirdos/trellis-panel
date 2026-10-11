"""Check local proposal links and static prototype assets; no network or product writes."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
errors = []
link_count = 0

for document in sorted(ROOT.glob('*.md')):
    body = re.sub(r'```.*?```', '', document.read_text(encoding='utf-8'), flags=re.S)
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', body):
        target = target.strip().strip('<>')
        if urlparse(target).scheme or target.startswith('#'):
            continue
        local = unquote(target.split('#', 1)[0])
        link_count += 1
        if not (document.parent / local).exists():
            errors.append(f'{document.name}: missing target {target}')


class StaticHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        element_id = attrs.get('id')
        if element_id:
            if element_id in self.ids:
                errors.append(f'duplicate HTML id: {element_id}')
            self.ids.add(element_id)
        if tag == 'script' and attrs.get('src'):
            self.assets.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.assets.append(attrs.get('href', ''))


parser = StaticHTML()
parser.feed((ROOT / 'prototype/index.html').read_text(encoding='utf-8'))
for asset in parser.assets:
    if urlparse(asset).scheme:
        errors.append(f'prototype unexpectedly requires a remote asset: {asset}')
    elif not (ROOT / 'prototype' / urlparse(asset).path).is_file():
        errors.append(f'missing prototype asset: {asset}')

syntax = subprocess.run(['node', '--check', str(ROOT / 'prototype/app.js')], capture_output=True, text=True)
if syntax.returncode:
    errors.append(syntax.stderr.strip())

result = {
    'scope': 'local artifact links, static HTML IDs/assets, JavaScript syntax',
    'markdown_files': len(list(ROOT.glob('*.md'))),
    'local_links_checked': link_count,
    'static_assets_checked': len(parser.assets),
    'javascript_syntax_passed': syntax.returncode == 0,
    'errors': errors,
    'not_tested': ['live Jira', 'actual Agent/ACP', 'MCP', 'production authorization', 'production device sync'],
}
(ROOT / 'checks/results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
sys.exit(1 if errors else 0)
