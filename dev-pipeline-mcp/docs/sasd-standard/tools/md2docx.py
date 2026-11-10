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


def build(md_path, out_path, img_roots, title):
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
        m = re.match(r'^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$', ln)
        if m:
            rel = m.group(2)
            path = None
            for root in img_roots:
                cand = os.path.join(root, rel)
                if os.path.exists(cand):
                    path = cand
                    break
            if path:
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.add_run().add_picture(path, width=Cm(14.5))
                img_count += 1
            else:
                p = doc.add_paragraph()
                add_inline(p, '（找不到圖片：%s）' % rel)
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
    return img_count


if __name__ == '__main__':
    md, out, title = sys.argv[1], sys.argv[2], sys.argv[3]
    roots = sys.argv[4:] or [os.path.dirname(os.path.abspath(md))]
    n = build(md, out, roots, title)
    print('ok', out, 'images=%d' % n)
