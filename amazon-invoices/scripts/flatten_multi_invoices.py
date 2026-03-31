#!/usr/bin/env python3
"""
Flatten multi-invoice bundles in all_invoices.json.

Each PDF that was parsed as a bundle of the form:
  { "invoices": [ {...invoice A...}, {...invoice B...} ] }

gets expanded into individual flat invoice entries, e.g.:
  "20221121_Tax Invoice_408-0259394-6874726_1.pdf::0": { ...invoice A... }
  "20221121_Tax Invoice_408-0259394-6874726_1.pdf::1": { ...invoice B... }

The original bundle key is removed.
"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "extracted"
ALL_INVOICES = DATA_DIR / "all_invoices.json"
BACKUP_DIR = DATA_DIR / "backups"


def backup(src: Path) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = BACKUP_DIR / f"{src.stem}.pre_flatten.{stamp}{src.suffix}"
    shutil.copy2(src, dst)
    return dst


def flatten(data: dict, dry_run: bool = False) -> tuple[dict, list[dict]]:
    bundles_found = []
    new_data = {}

    for key, value in data.items():
        if isinstance(value, dict) and "invoices" in value and isinstance(value["invoices"], list):
            sub_invoices = value["invoices"]
            bundles_found.append({
                "source_key": key,
                "count": len(sub_invoices),
                "sub_invoices": sub_invoices,
            })
            # Expand each sub-invoice into its own flat entry
            for i, inv in enumerate(sub_invoices):
                new_key = f"{key}::{i}"
                flat = dict(inv)
                flat["_source_file"] = key  # preserve original PDF filename
                flat["_bundle_index"] = i
                new_data[new_key] = flat
        else:
            new_data[key] = value

    return new_data, bundles_found


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv

    with open(ALL_INVOICES, encoding="utf-8") as f:
        data = json.load(f)

    print(f"Input: {ALL_INVOICES}")
    print(f"Total entries before: {len(data)}")

    new_data, bundles = flatten(data, dry_run=dry_run)

    total_sub = sum(b["count"] for b in bundles)
    net_gain = total_sub - len(bundles)  # each bundle (1 entry) replaced by N entries

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Bundles flattened: {len(bundles)}")
    for b in bundles:
        print(f"  📦 {b['source_key']}")
        for i, inv in enumerate(b["sub_invoices"]):
            print(f"     [{i}] order={inv.get('order_id')} invoice={inv.get('invoice_number')} "
                  f"date={inv.get('invoice_date')} total={inv.get('total_gross')}")

    print(f"\nNet change in entries: +{net_gain} (was {len(data)}, now {len(new_data)})")

    if dry_run:
        print("\n[DRY RUN] No files modified.")
        return 0

    bak = backup(ALL_INVOICES)
    print(f"\nBackup: {bak}")

    with open(ALL_INVOICES, "w", encoding="utf-8") as f:
        json.dump(new_data, f, ensure_ascii=False, indent=2)

    print(f"Written: {ALL_INVOICES}")
    print("Done ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
