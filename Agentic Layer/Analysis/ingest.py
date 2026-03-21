#!/usr/bin/env python
import sys
import json
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from Analysis.dataingestor import get_scan_results
from dotenv import load_dotenv

load_dotenv()

def main():
    project_id = os.getenv("PROJECT_ID")
    if not project_id:
        print("PROJECT_ID not set in .env", file=sys.stderr)
        sys.exit(1)

    success, result = get_scan_results(project_id)
    if not success:
        print(f"Error: {result}", file=sys.stderr)
        sys.exit(1)

    output_path = os.getenv("FINDINGS_OUTPUT", "findings.json")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"Findings written to {output_path}")

if __name__ == "__main__":
    main()