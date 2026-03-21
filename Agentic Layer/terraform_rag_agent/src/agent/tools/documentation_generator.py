from openai import OpenAI
import os
from pydantic.v1 import BaseModel, Field
from typing import Any, Type
from langchain.chains import LLMChain

from .base import BaseTool
from utils.rag_logger import get_rag_logger
from agent.prompts import get_documentation_generation_system_prompt

logger = get_rag_logger(__name__)

class DocumentationGeneratorToolInput(BaseModel):
    hcl_code: str = Field(description="The final, validated Terraform HCL code.")
    plan_summary: str = Field(description="The summary of the plan that generated the code.")
    original_goal: str = Field(description="The original high-level user request.")

class DocumentationGeneratorTool(BaseTool):
    name: str = "documentation_generator"
    description: str = (
        "Generates a README.md file for a given Terraform project. "
        "Use this tool after the HCL code has been successfully validated."
    )
    args_schema: Type[BaseModel] = DocumentationGeneratorToolInput
    llm_model_name: str
    client: Any

    def __init__(self, llm_model_name: str = "gpt-4.1"):
        super().__init__(llm_model_name=llm_model_name, client=None)
        try:
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            logger.info("OpenAI client initialized for DocumentationGeneratorTool.")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI client: {e}")
            self.client = None

    def _run(self, hcl_code: str, plan_summary: str, original_goal: str) -> str:
        logger.info("🤖 Engaging Documentation Generator Tool...")
        if not self.client:
            return "Error: OpenAI client not initialized for DocumentationGeneratorTool."

        system_prompt = get_documentation_generation_system_prompt()
        user_prompt = (
            f"Original Goal: {original_goal}\n\n"
            f"Plan Summary: {plan_summary}\n\n"
            f"Final Terraform Code:\n```hcl\n{hcl_code}\n```"
        )

        try:
            response = self.client.chat.completions.create(
                model=self.llm_model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.1,
            )
            readme_content = response.choices[0].message.content
            logger.info("✅ Successfully generated README.md content.")
            return readme_content.strip()
        except Exception as e:
            logger.error(f"❌ An error occurred during documentation generation: {e}")
            return f"Error: Failed to generate documentation. Details: {e}" 