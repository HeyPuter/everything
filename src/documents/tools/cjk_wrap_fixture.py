"""Original manual OOXML controls for line breaks beside Chinese and Japanese characters."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from html import escape
import json
root=Path(__file__).resolve().parents[1]
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
with ZipFile(root/'public/fixtures/table-shading-scope.docx') as z:parts={n:z.read(n) for n in z.namelist()}
# Each case lists its source runs and its writing width in points.
cases=[
 ('latin-then-chinese',200,['Here are some English words and then ','这是一段很长的中文句子，用来检查汉字之间的换行，而不是把整段中文移到下一行。']),
 ('japanese',150,['日本語の文章です。「括弧」や、句読点。が行頭に来ないことを確認します。ひらがなとカタカナ、そしてチョコレートも。']),
 ('chinese-punctuation',140,['他说：“我们明天见。”然后走了——没有回头……《红楼梦》是一部小说，（括号）也一样。']),
 ('chinese-runs',120,['汉字可以','在任何','两个字之间换行，','即使它们来自不同的文字段。']),
 ('korean',140,['한국어는 띄어쓰기를 하므로 단어 사이에서만 줄을 바꿉니다 그래서 단어가 나뉘지 않습니다']),
]
body=[]
for i,(name,width,runs) in enumerate(cases):
    body.append(f'<w:p><w:pPr>{"<w:pageBreakBefore/>" if i else ""}</w:pPr><w:r><w:t>CASE {name}</w:t></w:r></w:p>')
    text=''.join(f'<w:r><w:t xml:space="preserve">{escape(s)}</w:t></w:r>' for s in runs)
    body.append(f'<w:p><w:pPr><w:ind w:right="{(504-width)*20}"/></w:pPr>{text}</w:p>')
body.append('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')
parts['word/document.xml']=f'<w:document xmlns:w="{W}"><w:body>{"".join(body)}</w:body></w:document>'.encode()
with ZipFile(root/'public/fixtures/cjk-wrap.docx','w',ZIP_DEFLATED) as z:
    for n,d in parts.items():z.writestr(n,d)
folder=root/'tests/fixtures/cjk-wrap';folder.mkdir(exist_ok=True)
(folder/'cases.json').write_text(json.dumps([dict(name=n,width=w,runs=r) for n,w,r in cases],ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
