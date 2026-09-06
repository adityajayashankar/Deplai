"""DeplAI platform theme tokens shared across the customization backend.

These mirror the tokens in `Connector/src/features/workspace/theme.ts` so the
modifier agents can keep generated frontend code consistent with the
authenticated dashboard styling.
"""

from __future__ import annotations

# Mirrors `Connector/src/features/workspace/theme.ts`.
DEPLAI_PLATFORM_TOKENS = {
    "palette": {
        "ink": "#000000",
        "paper": "#FFFFFF",
        "neutral_500": "#737373",
        "muted": "#7A7A7A",
    },
    "shadows": {
        "paper": "6px 6px 0 0 #000",
        "button": "4px 4px 0 0 #000",
    },
    "borders": {
        "paper": "3px solid #000",
    },
    "tailwind_classes": {
        "appPaper": "app-paper bg-white text-black border-[3px] border-black shadow-[6px_6px_0_0_#000] rounded-none",
        "appBtnInk": "inline-flex items-center justify-center gap-2 border-[3px] border-black bg-black px-4 py-2 text-[13px] font-bold text-white shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50",
        "appBtnPaper": "inline-flex items-center justify-center gap-2 border-[3px] border-black bg-white px-4 py-2 text-[13px] font-bold text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50",
        "appInput": "w-full rounded-none border-[3px] border-black bg-white px-3 py-2.5 text-[13px] text-black placeholder:text-neutral-500 outline-none disabled:opacity-50",
        "appFocusRing": "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
    },
}


def platform_theme_prompt() -> str:
    """Render the platform theme contract for LLM reviewers."""
    classes = DEPLAI_PLATFORM_TOKENS["tailwind_classes"]
    return (
        "Platform theme contract (DeplAI):\n"
        f"- Use the `appPaper` class for primary surfaces: `{classes['appPaper']}`\n"
        f"- Use `appBtnInk` for primary buttons: `{classes['appBtnInk']}`\n"
        f"- Use `appBtnPaper` for secondary buttons: `{classes['appBtnPaper']}`\n"
        f"- Use `appInput` for form inputs: `{classes['appInput']}`\n"
        f"- Use `appFocusRing` for focusable elements: `{classes['appFocusRing']}`\n"
        "- Borders are 3px solid black with hard 4px/6px shadows. No rounded corners.\n"
        "- Do not introduce new color palettes, gradients, or non-Token shadows.\n"
        "- Tailwind utility classes (e.g., `text-gray-500`, `rounded-md`) are forbidden on platform surfaces — use the tokens above instead.\n"
    )
