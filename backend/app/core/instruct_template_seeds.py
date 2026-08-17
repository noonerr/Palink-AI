"""Built-in instruct template seed definitions.

Mirrors the common instruct-mode templates shipped with SillyTavern 1.18.0:
  * Llama 2  — [INST] <<SYS>>\\n{system}\\n<</SYS>>\\n\\n{input} [/INST]
  * Llama 3   — <|begin_of_text|><|start_header_id|>system<|end_header_id|>\\n\\n{system}<|eot_id|>
  * Mistral   — [INST] {system}\\n\\n{input} [/INST]
  * ChatML    — <|im_start|>system\\n{system}<|im_end|>\\n<|im_start|>user\\n{input}<|im_end|>
  * Alpaca    — ### Instruction:\\n{system}\\n\\n{input}\\n\\n### Response:\\n

System-preset rows are created with user_id=NULL (shared across users) and
cannot be deleted, only updated. The prefix/suffix fields are applied to
each assembled message by the roleplay prompt assembly when instruct mode
is enabled on the user's settings.
"""
from __future__ import annotations

from typing import Any


BUILTIN_INSTRUCT_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Llama 2",
        "user_id": None,
        "system_prompt": "",
        "input_prefix": "[INST] ",
        "input_suffix": " [/INST]",
        "output_prefix": " ",
        "output_suffix": "</s>",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "[INST] <<SYS>>\n",
        "system_sequence_suffix": "\n<</SYS>>\n\n",
        "stop_sequence": "</s>",
        "separator_sequence": "\n",
        "wrap_sequences": False,
        "is_default": False,
    },
    {
        "name": "Llama 3",
        "user_id": None,
        "system_prompt": "",
        "input_prefix": "<|start_header_id|>user<|end_header_id|>\n\n",
        "input_suffix": "<|eot_id|>",
        "output_prefix": "<|start_header_id|>assistant<|end_header_id|>\n\n",
        "output_suffix": "<|eot_id|>",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n",
        "system_sequence_suffix": "<|eot_id|>",
        "stop_sequence": "<|eot_id|>",
        "separator_sequence": "",
        "wrap_sequences": False,
        "is_default": False,
    },
    {
        "name": "Mistral",
        "user_id": None,
        "system_prompt": "",
        "input_prefix": "[INST] ",
        "input_suffix": " [/INST]",
        "output_prefix": " ",
        "output_suffix": "</s>",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "[INST] ",
        "system_sequence_suffix": "\n\n",
        "stop_sequence": "</s>",
        "separator_sequence": "\n",
        "wrap_sequences": False,
        "is_default": False,
    },
    {
        "name": "ChatML",
        "user_id": None,
        "system_prompt": "",
        "input_prefix": "<|im_start|>user\n",
        "input_suffix": "<|im_end|>\n",
        "output_prefix": "<|im_start|>assistant\n",
        "output_suffix": "<|im_end|>\n",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "<|im_start|>system\n",
        "system_sequence_suffix": "<|im_end|>\n",
        "stop_sequence": "<|im_end|>",
        "separator_sequence": "",
        "wrap_sequences": False,
        "is_default": True,
    },
    {
        "name": "Alpaca",
        "user_id": None,
        "system_prompt": "",
        "input_prefix": "### Instruction:\n",
        "input_suffix": "\n\n",
        "output_prefix": "### Response:\n",
        "output_suffix": "\n",
        "first_output_prefix": "",
        "last_output_prefix": "",
        "system_sequence_prefix": "### System:\n",
        "system_sequence_suffix": "\n\n",
        "stop_sequence": "</s>",
        "separator_sequence": "\n",
        "wrap_sequences": False,
        "is_default": False,
    },
]


def get_builtin_template_names() -> list[str]:
    return [t["name"] for t in BUILTIN_INSTRUCT_TEMPLATES]


def get_builtin_template(name: str) -> dict[str, Any] | None:
    for t in BUILTIN_INSTRUCT_TEMPLATES:
        if t["name"] == name:
            return dict(t)
    return None
