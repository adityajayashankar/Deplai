from manifest_state import ManifestState
from graph.conversation_graph import build_conversation_graph


class ChatAgent:
    def __init__(self, state: ManifestState) -> None:
        self.state = state
        self.graph = build_conversation_graph()

    def handle_message(self, tenant_id: str, message: str) -> dict:
        normalized_tenant_id = self.state.ensure_tenant(tenant_id)
        graph_state = self.graph.invoke(
            {
                "message": message,
                "manifest": self.state.get_manifest(normalized_tenant_id),
            }
        )
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

        return {
            "response": response,
            "questions": questions if isinstance(questions, list) else [],
            "manifest": updated_manifest,
            "terminated": terminated,
        }