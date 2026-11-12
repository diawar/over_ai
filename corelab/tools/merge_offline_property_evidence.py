"""Merge checked-in offline evidence without changing its source attribution.

Rows are merged only when product/category identity and source URL match.
For conflicting values from the same URL, the newest checked_at row wins.
"""
import json
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUTPUT = DATA / "official-properties-merged-current.json"
CONFIGURATOR_CATEGORIES = {17, 44, 146, 246, 253, 256, 359, 432, 437, 442, 458}


def main():
    grouped = defaultdict(list)
    files = sorted(DATA.glob("official*.json"))
    for path in files:
        if path == OUTPUT:
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        for row in document.get("products", []):
            if row.get("category_id") not in CONFIGURATOR_CATEGORIES:
                continue
            key = (row.get("category_id"), row.get("product_id"), row.get("source_url"))
            grouped[key].append((row, path.name))

    merged = []
    conflicts = 0
    for (category_id, product_id, source_url), candidates in grouped.items():
        candidates.sort(key=lambda pair: pair[0].get("checked_at", ""))
        newest, _ = candidates[-1]
        result = dict(newest)
        values = {}
        value_dates = {}
        for row, _filename in candidates:
            for code, value in row.get("values", {}).items():
                checked = row.get("checked_at", "")
                if code in values and values[code] != value:
                    conflicts += 1
                if code not in values or checked >= value_dates[code]:
                    values[code] = value
                    value_dates[code] = checked
        result["values"] = values
        merged.append(result)

    merged.sort(key=lambda row: (row["category_id"], row["product_id"], row["source_url"]))
    OUTPUT.write_text(json.dumps({"products": merged}, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")
    print(f"files={len(files)-1} evidence_rows={sum(len(v) for v in grouped.values())} "
          f"merged_rows={len(merged)} value_conflicts_resolved_by_checked_at={conflicts}")
    print(f"output={OUTPUT}")


if __name__ == "__main__":
    main()
