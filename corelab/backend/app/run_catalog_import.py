"""Run an explicitly staged p1 snapshot import; performs no source API calls."""
import argparse

from .db import SessionLocal
from .catalog_import import import_snapshot_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="Path to a complete validated p1 snapshot")
    args = parser.parse_args()
    with SessionLocal.begin() as session:
        result = import_snapshot_file(session, args.snapshot)
    print("Import completed: "
          f"products={result['products']} categories={result['categories']} "
          f"source=p1 downloaded_at={result['downloaded_at'].isoformat() if result['downloaded_at'] else 'unknown'}")


if __name__ == "__main__":
    main()
