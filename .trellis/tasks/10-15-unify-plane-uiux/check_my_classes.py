import re, glob, io

used = set()
for f in glob.glob('src/renderer/src/**/*.tsx', recursive=True):
    s = io.open(f, encoding='utf-8').read()
    for m in re.finditer(r'className="([^"]+)"|className=\{?`([^`]+)`', s):
        for cls in re.findall(r'[a-zA-Z0-9_:/\[\]\.\-\(\)%]+', m.group(1) or m.group(2) or ''):
            used.add(cls)

mycls = {c for c in used if c.startswith(('my-', 'bg-my-', 'text-my-', 'border-my-', 'ring-my-', 'divide-my-'))}

css = ''
for f in glob.glob('out/renderer/assets/*.css'):
    css += io.open(f, encoding='utf-8').read()
defined = set(re.findall(r'\.([a-zA-Z0-9_\\:/\[\]\.\-\(\)%]+)', css))
defined = {d.replace(chr(92), '') for d in defined}

static_ok = {'my-root', 'my-pop', 'my-fade', 'my-peek-in', 'my-kbd', 'my-chip',
             'my-control', 'my-control-sm', 'my-control-lg', 'my-scrollbar',
             'my-row', 'my-row-handle', 'my-card', 'my-input'}
missing = sorted(c for c in mycls if c not in defined and c not in static_ok)
print('used my-* classes:', len(mycls))
print('MISSING from built CSS:', len(missing))
for c in missing:
    print('  -', c)
