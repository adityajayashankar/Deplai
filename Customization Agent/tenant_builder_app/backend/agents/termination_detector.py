from __future__ import annotations


STOP_PHRASES = [
    "no more changes",
    "done",
    "that's all",
    "looks good",
    "no changes",
    "finished",
    "stop editing",
]


def detect_termination(state: dict) -> dict:
    message = str(state.get("message") or "").lower()
    state["terminate"] = any(phrase in message for phrase in STOP_PHRASES)
    return state


def end_node(state: dict) -> dict:
    state["response"] = "Okay. The manifest will remain unchanged."
    state["questions"] = []
    state["manifest_patch"] = {}
    state["manifest"] = state.get("manifest", {})
    state["terminated"] = True
    return state