"""Dry-run/apply all remaining exact-product records from official JSON batches."""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from app.db import SessionLocal
from load_official_category_properties import main as loader_main, prepare


SOURCE_DIR = Path("/tmp/property-evidence")
PENDING_DIR = Path("/tmp/property-evidence-pending")
APPLY = "--apply" in sys.argv[1:]


records = defaultdict(list)
for path in sorted(SOURCE_DIR.glob("official-*.json")):
    document = json.loads(path.read_text(encoding="utf-8"))
    for item in document.get("products", []):
        if isinstance(item, dict) and item.get("product_id") is not None:
            records[int(item["product_id"])].append((item.get("checked_at", ""), path.name, item))

groups = defaultdict(list)
skipped = Counter()
duplicate_conflicts = 0
with SessionLocal() as db:
    for product_id, entries in records.items():
        newest_date = max(date for date, _, _ in entries)
        newest = [(name, item) for date, name, item in entries if date == newest_date]
        signatures = {(json.dumps(item.get("values", {}), sort_keys=True, ensure_ascii=False),
                       item.get("source_url")) for _, item in newest}
        if len(signatures) > 1:
            duplicate_conflicts += 1
            skipped["same-date conflicting evidence"] += 1
            continue
        source_name, item = newest[-1]
        try:
            prepare(db, {"products": [item]})
        except Exception as exc:
            message = str(exc).splitlines()[0][:120]
            skipped[message] += 1
            continue
        groups[source_name].append(item)

PENDING_DIR.mkdir(parents=True, exist_ok=True)
for old in PENDING_DIR.glob("*.json"):
    old.unlink()

total_products = 0
category_counts = Counter()
for source_name, items in sorted(groups.items()):
    if not items:
        continue
    (PENDING_DIR / source_name).write_text(
        json.dumps({"products": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_products += len(items)
    for item in items:
        category_counts[item["category_id"]] += 1
    print(f"PENDING source={source_name} products={len(items)}")

print(f"DRY_RUN products={total_products} files={sum(bool(v) for v in groups.values())} "
      f"categories={dict(sorted(category_counts.items()))} duplicates={sum(len(v)-1 for v in records.values())} "
      f"conflicts={duplicate_conflicts}")
print(f"SKIPPED {dict(skipped)}")

if APPLY:
    for path in sorted(PENDING_DIR.glob("*.json")):
        print(f"APPLY source={path.name}")
        sys.argv = ["load_official_category_properties.py", "--apply", "--evidence", str(path)]
        loader_main()
