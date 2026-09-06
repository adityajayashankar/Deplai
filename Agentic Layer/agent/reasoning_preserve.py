"""Preserve reasoning_details across agent/subagent turns for openrouter/free."""

def inject_reasoning(messages: list) -> list:
    """Keep reasoning_details in the conversation history so reasoning continues."""
    preserved = []
    for msg in messages or []:
        preserved.append(dict(msg))
        if "reasoning_details" in msg:
            preserved[-1]["reasoning_details"] = msg["reasoning_details"]
    return preserved


def extract_reasoning_details(content: str) -> list:
    # Minimal helper: reasoning details come back in response; agent passes them through.
    # For now we rely on inject_reasoning above.
    return []
