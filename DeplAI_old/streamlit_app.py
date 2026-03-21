"""Deprecated Streamlit entrypoint.

Legacy Streamlit UI has been retired in favor of the React Connector UI.
Use the main app at:
  - /dashboard
  - /dashboard/pipeline
"""

import sys


def main() -> None:
    msg = (
        "Streamlit UI is removed.\n"
        "Use React UI instead:\n"
        "  1) Connector dashboard: /dashboard\n"
        "  2) Pipeline flow page: /dashboard/pipeline\n"
    )
    print(msg)
    raise SystemExit(1)


if __name__ == "__main__":
    main()

