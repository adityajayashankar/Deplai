from __future__ import annotations

from llm_interpreter import LLMInterpreter


def run_manifest_agent(state: dict) -> dict:
    interpreter = LLMInterpreter()
    byok_config = state.get("byok_config")
    interpretation = interpreter.interpret(
        message=str(state.get("message") or ""),
        current_manifest=state.get("manifest", {}),
        byok_config=byok_config,
    )

    response = interpretation.get("response")
    manifest_patch = interpretation.get("manifest_patch")
    questions = interpretation.get("questions", [])

    if not isinstance(response, str):
        response = "I could not interpret the request safely."
    if not isinstance(manifest_patch, dict):
        manifest_patch = {}
    if not isinstance(questions, list):
        questions = []

    normalized_questions = [question for question in questions if isinstance(question, str)]
    if normalized_questions and all(question not in response for question in normalized_questions):
        question_lines = "\n".join(
            f"{index}. {question}" for index, question in enumerate(normalized_questions, start=1)
        )
        response = f"{response}\n\nI need a few more details:\n{question_lines}"

    state["response"] = response
    state["questions"] = normalized_questions
    state["manifest_patch"] = manifest_patch
    state["terminated"] = False
    return state