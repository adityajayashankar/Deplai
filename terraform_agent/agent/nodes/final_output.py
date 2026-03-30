from __future__ import annotations

from datetime import datetime
from pathlib import Path

from state import AgentState
from tools.file_writer import write_files


def run_final_output(state: AgentState) -> AgentState:
    out_dir = Path(__file__).resolve().parents[1] / "output" / datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    output_path = write_files(str(out_dir), state.get("terraform_files", {}))

    # Persist a warning file when max refinement attempts were reached.
    if int(state.get("retry_count", 0)) >= 3 and not state.get("validation_result", False):
        warning_path = Path(output_path) / "WARNING.txt"
        warning_path.write_text(
            "Best-effort output emitted after 3 refinement attempts. Review validation_errors in runtime logs.\n",
            encoding="utf-8",
        )

    state["output_path"] = output_path
    return state
