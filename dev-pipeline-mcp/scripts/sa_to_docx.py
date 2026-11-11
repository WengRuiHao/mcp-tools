"""SA 的 Markdown 轉 Word（隨 dev-pipeline-mcp 發佈，由 src/export/sa-docx.ts 呼叫）。

用法：python sa_to_docx.py <md 路徑> <輸出 docx 路徑> <文件標題>
圖片路徑一律以 md 所在目錄為根，必須是 md 目錄內存在的檔案；找不到、超出目錄或不是獨立一行的圖片都會報錯（結束碼 3），不會在文件裡寫「找不到圖片」。
成功時最後一行輸出：ok <輸出路徑> images=<圖片引用數> tables=<表格數>
需要 Python 3 與 python-docx。
"""
import re, sys, os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FONT = '微軟正黑體'


def set_font(run, size=None, bold=None, color=None):
    run.font.name = FONT
    run._element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def shade(cell, fill):
    tcPr = cell._element.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill)
    tcPr.append(shd)


def add_inline(par, text, size=11):
    # **粗體**、`行內程式碼` 轉成純文字格式（SA 客戶版不應有程式碼，保險起見只處理粗體並去掉反引號）
    text = text.replace('`', '')
    parts = re.split(r'(\*\*[^*]+\*\*)', text)
    for part in parts:
        if not part:
            continue
        if part.startswith('**') and part.endswith('**'):
            r = par.add_run(part[2:-2])
            set_font(r, size, True)
        else:
            r = par.add_run(part)
            set_font(r, size)


class ConvertError(Exception):
    pass


IMG_ANY = re.compile(r'!\[[^\]]*\]\([^)]*\)')
IMG_LINE = re.compile(r'^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$')


def resolve_image(root, rel, line_no):
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', rel) or os.path.isabs(rel):
        raise ConvertError('第 %d 行圖片 %s 必須是相對於文件的路徑' % (line_no, rel))
    base = os.path.realpath(root)
    path = os.path.realpath(os.path.join(base, rel))
    if os.path.commonpath([base, path]) != base:
        raise ConvertError('第 %d 行圖片 %s 超出文件所在目錄' % (line_no, rel))
    if not os.path.isfile(path):
        raise ConvertError('第 %d 行找不到圖片：%s' % (line_no, rel))
    return path


def build(md_path, out_path, root, title):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)
    st = doc.styles['Normal']
    st.font.name = FONT
    st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    st.font.size = Pt(11)

    lines = open(md_path, encoding='utf-8').read().splitlines()
    i = 0
    first_table_done = False
    img_count = 0
    table_count = 0
    for n, text in enumerate(lines, 1):
        if IMG_ANY.search(text) and not IMG_LINE.match(text):
            raise ConvertError('第 %d 行的圖片必須獨立成一行' % n)
    while i < len(lines):
        ln = lines[i]
        if re.match(r'^\s*\|.*\|\s*$', ln):
            rows = []
            while i < len(lines) and re.match(r'^\s*\|.*\|\s*$', lines[i]):
                rows.append(lines[i])
                i += 1
            cells = lambda r: [c.strip() for c in r.strip().strip('|').split('|')]
            header = cells(rows[0])
            body = [cells(r) for r in rows[2:]] if len(rows) > 1 and re.match(r'^[\s|:\-]+$', rows[1]) else [cells(r) for r in rows[1:]]
            table_count += 1
            tbl = doc.add_table(rows=1 + len(body), cols=len(header))
            tbl.style = 'Table Grid'
            tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
            for c, h in enumerate(header):
                cell = tbl.rows[0].cells[c]
                cell.text = ''
                add_inline(cell.paragraphs[0], h, 10.5)
                for r in cell.paragraphs[0].runs:
                    r.bold = True
                shade(cell, 'E8EEF9')
            for r_i, row in enumerate(body, 1):
                for c, val in enumerate(row):
                    cell = tbl.rows[r_i].cells[c]
                    cell.text = ''
                    add_inline(cell.paragraphs[0], val, 10.5)
            doc.add_paragraph()
            continue
        m = re.match(r'^(#{1,4})\s+(.*)$', ln)
        if m:
            level = len(m.group(1))
            text = m.group(2)
            if level == 1:
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                r = p.add_run(text)
                set_font(r, 20, True, '1F2937')
            else:
                h = doc.add_heading(level=min(level, 3))
                r = h.add_run(text)
                set_font(r, 15 if level == 2 else 12.5, True, '1F3A8A')
            i += 1
            continue
        m = IMG_LINE.match(ln)
        if m:
            path = resolve_image(root, m.group(2).strip(), i + 1)
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.add_run().add_picture(path, width=Cm(14.5))
            img_count += 1
            i += 1
            continue
        m = re.match(r'^(\s*)([-*]|\d+\.)\s+(.*)$', ln)
        if m:
            style = 'List Number' if m.group(2)[0].isdigit() else 'List Bullet'
            p = doc.add_paragraph(style=style)
            add_inline(p, m.group(3))
            i += 1
            continue
        if ln.strip() == '':
            i += 1
            continue
        p = doc.add_paragraph()
        add_inline(p, ln.strip())
        i += 1

    doc.core_properties.title = title
    doc.core_properties.author = '系統分析師'
    doc.save(out_path)
    return img_count, table_count


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.stderr.write('用法：sa_to_docx.py <md> <out.docx> <title>' + chr(10))
        sys.exit(2)
    md, out, title = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        n, t = build(md, out, os.path.dirname(os.path.abspath(md)), title)
    except ConvertError as e:
        sys.stderr.write('轉換失敗：%s' % e + chr(10))
        sys.exit(3)
    print('ok', out, 'images=%d' % n, 'tables=%d' % t)
