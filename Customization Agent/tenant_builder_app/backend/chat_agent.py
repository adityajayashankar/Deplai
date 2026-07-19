from collections import defaultdict

from manifest_state import ManifestState
from graph.conversation_graph import build_conversation_graph


# Maximum number of recent messages to include as context for the LLM.
MAX_HISTORY_TURNS = 6


class ChatAgent:
    def __init__(self, state: ManifestState) -> None:
        self.state = state
        self.graph = build_conversation_graph()
        # Per-tenant conversation history: list of {"role": "user"|"agent", "content": str}
        self._history: dict[str, list[dict[str, str]]] = defaultdict(list)

    def handle_message(self, tenant_id: str, message: str, byok_config: object | None = None) -> dict:
        normalized_tenant_id = self.state.ensure_tenant(tenant_id)

        # Record the user message in history
        self._history[normalized_tenant_id].append({"role": "user", "content": message})

        # Build a condensed conversation context string from recent turns
        recent = self._history[normalized_tenant_id][-(MAX_HISTORY_TURNS * 2):]
        history_lines: list[str] = []
        for turn in recent[:-1]:  # exclude the current message (already in "message")
            prefix = "User" if turn["role"] == "user" else "Agent"
            history_lines.append(f"{prefix}: {turn['content']}")
        conversation_context = "\n".join(history_lines) if history_lines else ""

        invoke_input: dict = {
            "message": message,
            "manifest": self.state.get_manifest(normalized_tenant_id),
            "conversation_context": conversation_context,
        }
        if byok_config is not None:
            invoke_input["byok_config"] = byok_config
        graph_state = self.graph.invoke(invoke_input)
        response = graph_state.get("response")
        manifest_patch = graph_state.get("manifest_patch")
        questions = graph_state.get("questions", [])
        terminated = bool(graph_state.get("terminated", False))

        if terminated:
            updated_manifest = self.state.get_manifest(normalized_tenant_id)
        else:
            updated_manifest = self.state.apply_patch(
                normalized_tenant_id,
                manifest_patch if isinstance(manifest_patch, dict) else {},
            )

        # Record the agent response in history
        if isinstance(response, str) and response.strip():
            self._history[normalized_tenant_id].append({"role": "agent", "content": response})

        return {
            "response": response,
            "questions": questions if isinstance(questions, list) else [],
            "manifest": updated_manifest,
            "terminated": terminated,
        }