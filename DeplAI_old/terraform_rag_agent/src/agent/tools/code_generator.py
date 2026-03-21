"""
This tool is responsible for generating Terraform HCL code for a single resource
based on a detailed description of its configuration.
"""
import os
import json
from openai import OpenAI
from pydantic.v1 import BaseModel, Field
from typing import Any
from langchain.chains import LLMChain

from .base import BaseTool
from utils.rag_logger import get_rag_logger
from agent.prompts import get_code_generation_prompt

logger = get_rag_logger(__name__)

class CodeGeneratorToolInput(BaseModel):
    resource_type: str = Field(description="The full Terraform resource type (e.g., 'aws_s3_bucket').")
    resource_name: str = Field(description="The name of the resource to be used in the HCL code (e.g., 'main_vpc').")
    config_description: str = Field(description="A detailed natural language description of the desired configuration, including properties, settings, and relationships.")
    context: str = Field(description="Context from previously generated resources that might be needed, like resource IDs or ARNs.")

class TerraformCodeGeneratorTool(BaseTool):
    name: str = "terraform_code_generator"
    description: str = "Generates HCL code for a single Terraform resource based on a detailed configuration description. Use this AFTER you have gathered all necessary information."
    args_schema = CodeGeneratorToolInput
    
    # Declare all instance attributes for Pydantic
    client: Any = None
    model: str = None
    system_prompt: str = None

    def __init__(self, llm_model_name: str = "gpt-4.1"):
        super().__init__() # Initialize the Pydantic model correctly
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = llm_model_name
        self.system_prompt = get_code_generation_prompt()

    def _run(self, resource_type: str, resource_name: str, config_description: str, context: str) -> str:
        logger.info(f"🤖 Generating HCL code for resource '{resource_name}' of type '{resource_type}'...")
        
        user_prompt = f"""
        **Resource Type:** {resource_type}
        **Resource Name:** {resource_name}
        **Configuration Description:** {config_description}
        **Context from previous steps (use for dependencies):**
        {context}
        """

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.0,
            )
            
            generated_code = response.choices[0].message.content
            if not generated_code:
                raise ValueError("LLM returned empty content for code generation.")

            logger.info(f"✅ Successfully generated code for '{resource_name}'.")
            logger.debug(f"Generated HCL:\n{generated_code}")
            
            # The tool should return just the code itself for the observation
            return generated_code

        except Exception as e:
            error_msg = f"Failed to generate Terraform code for '{resource_name}': {e}"
            logger.error(f"❌ {error_msg}", exc_info=True)
            return f"Error: {error_msg}" 