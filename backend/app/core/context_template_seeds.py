"""Built-in context template seed definitions.

Mirrors the four context templates shipped with SillyTavern 1.18.0:
  * Default         — standard ST format using {{description}}/{{personality}}/...
  * Classic         — legacy format with explicit Description:/Personality:/... labels
  * ChatCompletion  — OpenAI ChatCompletion system-role compatible
  * Instruct        — ChatML-style <|im_start|>{{role}}\\n{{content}}\\n<|im_end|> markers

The `story_string` placeholders are replaced at prompt-assembly time with the
character's description/personality/scenario fields. Built-in templates are
marked `is_builtin=True` and cannot be deleted by users.
"""
from __future__ import annotations

from typing import Any


BUILTIN_CONTEXT_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Default",
        "display_name": "Default (ST 1.18)",
        "is_builtin": True,
        # Standard ST story string — placeholders replaced at assembly time.
        "story_string": "{{description}}\n{{personality}}\n{{scenario}}",
        "chat_start": "",
        "system_prompt": "",
        "jailbreak": "",
        "normal_prompt": "",
        "group_prompt": "",
    },
    {
        "name": "Classic",
        "display_name": "Classic (legacy ST)",
        "is_builtin": True,
        # Legacy format with explicit labeled sections.
        "story_string": (
            "Description: {{description}}\n"
            "Personality: {{personality}}\n"
            "Scenario: {{scenario}}"
        ),
        "chat_start": "",
        "system_prompt": "",
        "jailbreak": "",
        "normal_prompt": "",
        "group_prompt": "",
    },
    {
        "name": "ChatCompletion",
        "display_name": "ChatCompletion (OpenAI)",
        "is_builtin": True,
        # OpenAI ChatCompletion — system role carries the story string verbatim.
        "story_string": "{{description}}\n{{personality}}\n{{scenario}}",
        "chat_start": "",
        "system_prompt": "You are {{char}}. Stay in character at all times.",
        "jailbreak": "",
        "normal_prompt": "",
        "group_prompt": "",
    },
    {
        "name": "Instruct",
        "display_name": "Instruct (ChatML)",
        "is_builtin": True,
        # Instruct/ChatML — story string wrapped with ChatML-style markers.
        "story_string": (
            "<|im_start|>system\n"
            "{{description}}\n{{personality}}\n{{scenario}}\n"
            "<|im_end|>"
        ),
        "chat_start": "<|im_start|>",
        "system_prompt": "<|im_start|>system\nYou are {{char}}.\n<|im_end|>",
        "jailbreak": "",
        "normal_prompt": "<|im_start|>user\n{{user}}\n<|im_end|>",
        "group_prompt": "",
    },
]


def get_builtin_template_names() -> list[str]:
    return [t["name"] for t in BUILTIN_CONTEXT_TEMPLATES]


def get_builtin_template(name: str) -> dict[str, Any] | None:
    for t in BUILTIN_CONTEXT_TEMPLATES:
        if t["name"] == name:
            return dict(t)
    return None
