"""Rebuild the sliced Chinese, Japanese, and Korean glyph data with fonttools==4.59.2.

Run from the repository root:  python scripts/cjk-fonts.py
Set FONT_CACHE to a folder to reuse earlier downloads.

The four regional Noto Sans CJK variable fonts are instanced at regular (400) and bold (700)
weights, as TrueType: the current PDF writer corrupts CID-keyed CFF subsets. Glyphs that are
identical across regions are stored once. The glyphs are then ordered by how common their
characters are and cut into slices of about 32 KB, so a paragraph downloads a few hundred
kilobytes instead of a whole 10 MB face. Glyphs are grouped by the first region that uses them,
in the order of SOURCES, so a slice rarely carries another region's variants of a character. src/core/cjk-fonts.js reads this layout and builds a small
TrueType font from the glyphs a document uses.

public/fonts/cjk/
  meta.json            format, regions, slice count, and per-weight head/hhea/maxp/OS/2/post
  <region>.bin         which slice holds each character the region covers
  <weight>/<n>.bin     the glyphs of slice n, and which characters of each region use them

<region>.bin, all integers unsigned LEB128 unless noted:
  rangeCount, then rangeCount x (gap from the previous range end, length)
  then a big-endian u16 per covered character, in code point order: its slice number
<weight>/<n>.bin, big-endian:
  u16 glyphCount, then glyphCount x (u16 advance, i16 left side bearing, u16 byte length)
  the glyph outlines, each padded to four bytes
  per region, in meta.json order: u16 count, then count x (u32 code point, u16 glyph index)
"""

import json
import os
import re
import zipfile
from base64 import b64encode
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from struct import pack
from urllib.request import urlopen

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

BASE = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/Variable/TTF/Subset/'
SOURCES = {
    'sc': ('NotoSansSC-VF.ttf', 'd68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964'),
    'tc': ('NotoSansTC-VF.ttf', 'ac091cc8cd19e848202afc8fe6d3809b4526c8fdbdb4be82da20c4f785949591'),
    'jp': ('NotoSansJP-VF.ttf', 'f4b373b226668ee33a6e54b02823dcd2d1209f17159f777421ae8c2275160369'),
    'kr': ('NotoSansKR-VF.ttf', '9e1d729e7e2b36f9ef439da102f8c134c10aabe46f1c843bf0aca5c043b86f76'),
}
UNIHAN = (
    'https://www.unicode.org/Public/16.0.0/ucd/Unihan.zip',
    'b8f000df69de7828d21326a2ffea462b04bc7560022989f7cc704f10521ef3e0',
)
WEIGHTS = {'regular': 400, 'bold': 700}
SLICE_BYTES = 32_000
OUT = Path('public/fonts/cjk')


def download(url, digest):
    cache = os.environ.get('FONT_CACHE')
    path = Path(cache) / url.rsplit('/', 1)[1] if cache else None
    if path and path.exists():
        data = path.read_bytes()
    else:
        with urlopen(url) as response:
            data = response.read()
        if path:
            path.write_bytes(data)
    if sha256(data).hexdigest() != digest:
        raise ValueError(f'Unexpected checksum for {url}')
    return data


def leb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


# How common each character is: mainland word-frequency counts, borrowed by traditional
# forms from their simplified variants, then the first and second levels of the national
# character sets. Within a level, characters keep code point order.
with zipfile.ZipFile(BytesIO(download(*UNIHAN))) as archive:
    readings = archive.read('Unihan_Readings.txt').decode()
    variants = archive.read('Unihan_Variants.txt').decode()
    mappings = archive.read('Unihan_OtherMappings.txt').decode()
pinlu = {}
for line in readings.splitlines():
    if '\tkHanyuPinlu\t' in line:
        cp, _, value = line.split('\t')
        pinlu[int(cp[2:], 16)] = sum(int(n) for n in re.findall(r'\((\d+)\)', value))
simplified = {}
for line in variants.splitlines():
    if '\tkSimplifiedVariant\t' in line:
        cp, _, value = line.split('\t')
        simplified[int(cp[2:], 16)] = [int(v[2:], 16) for v in value.split()]
joyo = {
    int(line.split('\t')[0][2:], 16)
    for line in mappings.splitlines()
    if '\tkJoyoKanji\t' in line and not line.split('\t')[2].startswith('U+')
}


def frequency(cp):
    return max([pinlu.get(cp, 0)] + [pinlu.get(s, 0) for s in simplified.get(cp, [])])


def level(cp):
    """1 for the common level of a national character set, 2 for the next, else 0."""
    char = chr(cp)
    best = 0
    for codec, first, second in [
        ('gb2312', (0xB0, 0xD7), (0xD8, 0xF7)),
        ('euc_jp', (0xB0, 0xCF), (0xD0, 0xF4)),
        ('euc_kr', (0xB0, 0xC8), (0xCA, 0xFD)),
    ]:
        try:
            lead = char.encode(codec)[0]
        except UnicodeEncodeError:
            continue
        if first[0] <= lead <= first[1]:
            return 1
        if second[0] <= lead <= second[1]:
            best = 2
    try:
        code = int.from_bytes(char.encode('big5'), 'big')
        if 0xA440 <= code <= 0xC67E:
            return 1
        if 0xC940 <= code <= 0xF9D5:
            best = 2
    except UnicodeEncodeError:
        pass
    return 1 if cp in joyo else best


def rank(cp):
    if cp <= 0xFF or 0x2000 <= cp <= 0x206F or 0x3000 <= cp <= 0x30FF or 0xFF00 <= cp <= 0xFFEF:
        return (0, 0, cp)
    count = frequency(cp)
    if count:
        return (1, -count, cp)
    tier = level(cp)
    return (1 + tier if tier else 4, 0, cp)


# Instance every region at both weights and record each mapped glyph.
faces = {}
for region, (file, digest) in SOURCES.items():
    data = download(BASE + file, digest)
    for weight, value in WEIGHTS.items():
        font = instantiateVariableFont(
            TTFont(BytesIO(data), recalcTimestamp=False, recalcBBoxes=False),
            {'wght': value},
            inplace=True,
        )
        glyf, hmtx = font['glyf'], font['hmtx']
        glyphs = {}
        for cp, name in font.getBestCmap().items():
            glyph = glyf[name]
            program = getattr(glyph, 'program', None)
            if glyph.isComposite() or (program and program.getBytecode()):
                raise ValueError(f'{file} {name}: expected simple outlines without hinting')
            outline = glyph.compile(glyf) if glyph.numberOfContours else b''
            outline += b'\0' * (-len(outline) % 4)
            glyphs[cp] = (outline, *hmtx[name])
        # Keep only the header tables; the outlines are copied into `glyphs`.
        for tag in list(font.keys()):
            if tag not in ('GlyphOrder', 'head', 'hhea', 'maxp', 'OS/2', 'post'):
                del font[tag]
        faces[region, weight] = (font, glyphs)
        print(region, weight, len(glyphs), 'characters')

# One pool entry per distinct glyph, at both weights.
pool, keys, use = [], {}, {}
for region in SOURCES:
    for cp, regular in sorted(faces[region, 'regular'][1].items()):
        bold = faces[region, 'bold'][1][cp]
        key = regular + bold
        if key not in keys:
            keys[key] = len(pool)
            pool.append({'regular': regular, 'bold': bold, 'rank': rank(cp), 'uses': []})
        entry = pool[keys[key]]
        entry['rank'] = min(entry['rank'], rank(cp))
        entry['uses'].append((region, cp))
lane = {region: n for n, region in enumerate(SOURCES)}
order = sorted(
    range(len(pool)),
    key=lambda i: (min(lane[r] for r, _ in pool[i]['uses']), pool[i]['rank'], i),
)

slices, size = [[]], 0
for i in order:
    if size >= SLICE_BYTES:
        slices.append([])
        size = 0
    slices[-1].append(i)
    size += len(pool[i]['regular'][0]) + 6
if len(slices) > 0xFFFF:
    raise ValueError('Too many slices for two-byte slice numbers')

if OUT.exists():
    for path in sorted(OUT.rglob('*'), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
regions = list(SOURCES)
slice_of = {region: {} for region in regions}
for weight in WEIGHTS:
    (OUT / weight).mkdir(parents=True)
for number, members in enumerate(slices):
    usage = {region: [] for region in regions}
    for index, i in enumerate(members):
        for region, cp in pool[i]['uses']:
            usage[region].append((cp, index))
            slice_of[region][cp] = number
    for weight in WEIGHTS:
        head, body = [pack('>H', len(members))], []
        for i in members:
            outline, advance, bearing = pool[i][weight]
            head.append(pack('>HhH', advance, bearing, len(outline)))
            body.append(outline)
        tail = []
        for region in regions:
            tail.append(pack('>H', len(usage[region])))
            tail += [pack('>IH', cp, index) for cp, index in sorted(usage[region])]
        (OUT / weight / f'{number}.bin').write_bytes(b''.join(head + body + tail))

for region in regions:
    cps = sorted(slice_of[region])
    ranges, end = [], 0
    for cp in cps:
        if ranges and cp == ranges[-1][0] + ranges[-1][1]:
            ranges[-1][1] += 1
        else:
            ranges.append([cp, 1])
    out = bytearray(leb(len(ranges)))
    for start, length in ranges:
        out += leb(start - end) + leb(length)
        end = start + length
    out += b''.join(pack('>H', slice_of[region][cp]) for cp in cps)
    (OUT / f'{region}.bin').write_bytes(out)


def tables(weight):
    """The shared header tables, from Simplified Chinese with bounds covering every region."""
    fonts = [faces[region, weight][0] for region in regions]
    font = fonts[0]
    head, hhea, maxp, post = font['head'], font['hhea'], font['maxp'], font['post']
    head.xMin = min(f['head'].xMin for f in fonts)
    head.yMin = min(f['head'].yMin for f in fonts)
    head.xMax = max(f['head'].xMax for f in fonts)
    head.yMax = max(f['head'].yMax for f in fonts)
    head.indexToLocFormat = 1
    for field in ['advanceWidthMax', 'xMaxExtent']:
        setattr(hhea, field, max(getattr(f['hhea'], field) for f in fonts))
    for field in ['minLeftSideBearing', 'minRightSideBearing']:
        setattr(hhea, field, min(getattr(f['hhea'], field) for f in fonts))
    for field in ['maxPoints', 'maxContours', 'maxZones', 'maxStorage', 'maxStackElements']:
        setattr(maxp, field, max(getattr(f['maxp'], field) for f in fonts))
    post.formatType = 3.0
    font.recalcBBoxes = False
    return {
        tag: b64encode(font[tag].compile(font)).decode()
        for tag in ['head', 'hhea', 'maxp', 'OS/2', 'post']
    }


meta = {
    'format': 1,
    'regions': regions,
    'slices': len(slices),
    'weights': {weight: tables(weight) for weight in WEIGHTS},
}
(OUT / 'meta.json').write_text(json.dumps(meta, indent=1) + '\n')
files = sorted(p for p in OUT.rglob('*') if p.is_file())
digest = sha256()
for path in files:
    digest.update(path.relative_to(OUT).as_posix().encode() + b'\0' + path.read_bytes())
sources = '\n'.join(f'{d}  upstream {f}' for f, d in SOURCES.values())
Path('public/fonts/NotoSansCJK-SOURCE.txt').write_text(f'''Noto Sans CJK SC, TC, JP, and KR Regular and Bold, version 2.004

Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.

Glyph slices (public/fonts/cjk/) of static TrueType instances (wght=400 and wght=700) of the
regional variable fonts from the Noto CJK project, generated with fonttools 4.59.2:
{BASE}

Character frequency order from the Unicode Han Database (Unihan) 16.0.0:
{UNIHAN[0]}

Reproduce from the repository root with: python scripts/cjk-fonts.py
The app builds a TrueType font from the slices a document's text needs and embeds only the
used glyphs. TrueType is used because the current PDF writer corrupts CID-keyed CFF subsets.
Glyph data is padded to four bytes for fontkit's short loca subset offsets.

License: SIL Open Font License 1.1 (NotoSansCJK-OFL.txt).
Upstream license: https://github.com/notofonts/noto-cjk/blob/Sans2.004/LICENSE

SHA-256:
{sources}
{UNIHAN[1]}  upstream Unihan.zip
{digest.hexdigest()}  public/fonts/cjk/ (each file's relative path, a NUL byte, then its bytes)
''')
total = sum(p.stat().st_size for p in files)
print(len(pool), 'glyphs in', len(slices), 'slices,', round(total / 1e6, 1), 'MB')
