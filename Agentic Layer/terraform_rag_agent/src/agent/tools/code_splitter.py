"""
This tool is responsible for splitting a single block of HCL code
into a structured set of files (main.tf, variables.tf, outputs.tf).
"""
import os
import json
from typing import Any, Type, Dict
from pydantic.v1 import BaseModel, Field
from openai import OpenAI
import logging

from .base import BaseTool
from agent.prompts import get_code_splitting_system_prompt

logger = logging.getLogger(__name__)

class CodeSplitterToolInput(BaseModel):
    hcl_code: str = Field(description="The full, unified block of HCL code to be split.")

class CodeSplitterTool(BaseTool):
    name: str = "code_splitter"
    description: str = (
        "Splits a single block of HCL code into a structured dictionary of files "
        "where keys are filenames (e.g., 'main.tf') and values are the file content."
    )
    args_schema: type[BaseModel] = CodeSplitterToolInput
    llm_model_name: str = "gpt-4.1"
    client: Any

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        try:
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            logger.info("OpenAI client initialized for CodeSplitterTool.")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI client for splitter: {e}")
            raise

    def _run(self, hcl_code: str) -> Dict[str, str]:
        """
        Executes the code splitting logic.

        Returns:
            A dictionary where keys are filenames and values are the code content.
            Returns an empty dictionary on failure.
        """
        logger.info("🤖 Engaging Code Splitter Tool...")
        system_prompt = get_code_splitting_system_prompt()
        user_prompt = hcl_code

        try:
            response = self.client.chat.completions.create(
                model=self.llm_model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
                response_format={"type": "json_object"}
            )
            
            response_content = response.choices[0].message.content
            if not response_content:
                raise ValueError("LLM returned an empty response.")

            structured_files = json.loads(response_content)
            
            # Basic validation of the output structure
            if not isinstance(structured_files, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in structured_files.items()):
                raise ValueError("LLM did not return a valid dictionary of strings.")

            logger.info(f"✅ Successfully split code into {len(structured_files)} files: {', '.join(structured_files.keys())}")
            return structured_files

        except json.JSONDecodeError as e:
            logger.error(f"❌ Failed to decode JSON from LLM output: {e}\nRaw output: {response_content}")
            return {}
        except Exception as e:
            logger.error(f"❌ An unexpected error occurred in CodeSplitterTool: {e}", exc_info=True)
            return {}

    async def _arun(self, *args, **kwargs):
        raise NotImplementedError("Asynchronous execution is not implemented for CodeSplitterTool.") 