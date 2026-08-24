import sys
import json
import os
from docx import Document


def read_docx(path, **_):
    doc = Document(path)
    paragraphs = [
        {"text": p.text, "style": p.style.name if p.style else None}
        for p in doc.paragraphs
    ]
    tables = []
    for table in doc.tables:
        tables.append([[cell.text for cell in row.cells] for row in table.rows])
    return {"paragraphs": paragraphs, "tables": tables}


def create_docx(path, paragraphs=None, overwrite=False, **_):
    if os.path.exists(path) and not overwrite:
        raise RuntimeError(f"檔案已存在，未帶 overwrite:true 不會覆蓋: {path}")
    doc = Document()
    for item in paragraphs or []:
        text = item.get("text", "")
        heading_level = item.get("heading_level")
        if heading_level is not None:
            doc.add_heading(text, level=heading_level)
        else:
            p = doc.add_paragraph(text)
            style = item.get("style")
            if style:
                p.style = doc.styles[style]
    doc.save(path)
    return {"path": path}


def append_paragraph(path, paragraphs=None, **_):
    if not os.path.exists(path):
        raise RuntimeError(f"檔案不存在，請先用 create_docx 建立: {path}")
    doc = Document(path)
    for item in paragraphs or []:
        text = item.get("text", "")
        heading_level = item.get("heading_level")
        if heading_level is not None:
            doc.add_heading(text, level=heading_level)
        else:
            p = doc.add_paragraph(text)
            style = item.get("style")
            if style:
                p.style = doc.styles[style]
    doc.save(path)
    return {"path": path, "appended": len(paragraphs or [])}


def replace_text(path, find, replace, **_):
    if not os.path.exists(path):
        raise RuntimeError(f"檔案不存在: {path}")
    doc = Document(path)
    count = 0

    def replace_in_paragraph(p):
        nonlocal count
        full_text = "".join(run.text for run in p.runs)
        if find not in full_text:
            return
        new_text = full_text.replace(find, replace)
        count += full_text.count(find)
        # 找出的取代結果整段塞回第一個 run、清空其餘 run——docx 的文字常被拆成多個 run（不同格式片段），
        # 逐個 run 比對容易漏掉跨 run 的字串，這裡犧牲原有的 run 級格式（保留段落層級格式）換取比對正確性。
        if p.runs:
            p.runs[0].text = new_text
            for run in p.runs[1:]:
                run.text = ""

    for p in doc.paragraphs:
        replace_in_paragraph(p)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    replace_in_paragraph(p)

    doc.save(path)
    return {"path": path, "replacements": count}


def insert_table(path, rows, style=None, **_):
    if not os.path.exists(path):
        raise RuntimeError(f"檔案不存在，請先用 create_docx 建立: {path}")
    doc = Document(path)
    if not rows:
        raise RuntimeError("rows 不能是空陣列")
    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    if style:
        table.style = style
    for r, row_values in enumerate(rows):
        for c, value in enumerate(row_values):
            table.cell(r, c).text = str(value)
    doc.save(path)
    return {"path": path, "rows": len(rows), "cols": len(rows[0])}


ACTIONS = {
    "read": read_docx,
    "create": create_docx,
    "append_paragraph": append_paragraph,
    "replace_text": replace_text,
    "insert_table": insert_table,
}


def main():
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    action = payload.get("action")
    if action not in ACTIONS:
        raise RuntimeError(f"未知的 action: {action}（可用: {', '.join(ACTIONS)}）")
    result = ACTIONS[action](**{k: v for k, v in payload.items() if k != "action"})
    print(json.dumps({"success": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "message": str(e)}, ensure_ascii=False))
        sys.exit(1)
