import sys
import json
import os
import csv


def read_csv(path, delimiter=",", **_):
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        rows = [row for row in csv.reader(f, delimiter=delimiter)]
    return {"rows": rows}


def create_csv(path, rows=None, delimiter=",", overwrite=False, **_):
    if os.path.exists(path) and not overwrite:
        raise RuntimeError(f"檔案已存在，未帶 overwrite:true 不會覆蓋: {path}")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, delimiter=delimiter)
        for row in rows or []:
            writer.writerow(row)
    return {"path": path, "rowCount": len(rows or [])}


def append_row(path, values, delimiter=",", **_):
    if not os.path.exists(path):
        raise RuntimeError(f"檔案不存在，請先用 create_csv 建立: {path}")
    with open(path, "a", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, delimiter=delimiter)
        writer.writerow(values)
    return {"path": path}


ACTIONS = {
    "read": read_csv,
    "create": create_csv,
    "append_row": append_row,
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
