"""
This tool is responsible for correcting invalid Terraform HCL code
based on a validation error message. It uses RAG on the first attempt
and falls back to web search on subsequent attempts.
"""
from typing import Any, Type
from langchain_openai import ChatOpenAI
from langchain.chains import LLMChain
from pydantic.v1 import BaseModel, Field
from openai import OpenAI
import os
import json
import re # Import re module for regular expression operations used in parsing and validating Terraform code

from .base import BaseTool
from utils.rag_logger import get_rag_logger
from agent.prompts import get_code_correction_system_prompt
from .terraform_documentation_rag_tool import TerraformDocumentationRAGTool
from .web_search_tool import WebSearchTool

logger = get_rag_logger(__name__)

class TerraformCodeCorrectorToolInput(BaseModel):
    invalid_hcl_code: str = Field(description="The complete, invalid Terraform HCL code that needs to be corrected.")
    error_message: str = Field(description="The error message from `terraform validate`.")
    original_goal: str = Field(description="The original high-level goal for the infrastructure.")
    fix_plan: str = Field(description="A high-level, step-by-step plan on how to fix the code.")

class TerraformCodeCorrectorTool(BaseTool):
    name: str = "terraform_code_corrector"
    description: str = (
        "Corrects a block of invalid Terraform HCL code based on a validation error and a high-level strategic plan. "
        "The input MUST include the invalid code, the error message, and the fix_plan."
    )
    args_schema = TerraformCodeCorrectorToolInput
    llm_model_name: str = "gpt-4.1"
    client: Any
    rag_tool: TerraformDocumentationRAGTool
    web_search_tool: WebSearchTool

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        try:
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            logger.info("OpenAI client initialized for TerraformCodeCorrectorTool.")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI client for corrector: {e}")
            raise

    def _run(self, invalid_hcl_code: str, error_message: str, original_goal: str, fix_plan: str) -> str:
        logger.info("🛠️ Running Terraform Code Corrector Tool...")
        logger.debug(f"Received fix plan:\n---\n{fix_plan}\n---")

        try:
            # --- Step 1: Get user-provided context (RAG or Web Search) ---
            # This part is now handled by the planner creating the fix_plan.
            # The context is implicitly part of the fix_plan's instructions.
            context_source = "the provided fix plan"

            # --- Step 2: Build a prompt with the new context and plan ---
            system_prompt = get_code_correction_system_prompt()
            user_prompt = self._create_correction_prompt(
                invalid_hcl_code,
                error_message,
                original_goal,
                "N/A - Following generated plan", # Context is now the plan
                context_source,
                fix_plan
            )
            
            logger.info("Constructed final prompt for code correction. Sending to LLM.")
            logger.debug(f"Full prompt for LLM:\nSYSTEM: {system_prompt}\nUSER: {user_prompt}")

            # --- Step 3: Call the LLM to get the corrected code ---
            response = self.client.chat.completions.create(
                model=self.llm_model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
            )
            corrected_code = response.choices[0].message.content
            logger.info("✅ Successfully generated corrected code based on the provided fix plan.")
            cleaned_code = self._clean_hcl_from_llm_output(corrected_code)
            return cleaned_code

        except Exception as e:
            error_msg = f"❌ An unexpected error occurred while generating corrected code: {e}"
            logger.error(error_msg, exc_info=True)
            return f"Error: Could not correct code. {error_msg}"

    def _create_correction_prompt(self, invalid_hcl_code: str, error_message: str, original_goal: str, context: str, context_source: str, fix_plan: str) -> str:
        """Constructs the full user prompt for the LLM."""
        return f"""The following Terraform code failed validation. Your task is to fix it by following the provided plan.

**Original Goal:**
---
{original_goal}
---

**Invalid Code:**
---
{invalid_hcl_code}
---

**Validation Error:**
---
{error_message}
---

**Expert's High-Level Plan to Fix the Code:**
---
{fix_plan}
---

Please execute the plan and provide the full, corrected HCL code.
Your response MUST only contain the complete and corrected HCL code block.
**CRITICAL RULE: Do not add any new resources that were not in the original code. Do not add, invent, or hallucinate any new attributes or blocks within existing resources.** Your ONLY task is to fix the existing code according to the plan.
Do not include any other text, markdown, or explanations.
"""

    def _create_rag_query_from_error(self, error_message: str, hcl_code: str) -> str:
        """Heuristically creates a search query for the RAG tool from the error."""
        logger.debug(f"Creating RAG query from error message: {error_message}")

        # More specific regex to find resource type and name from error messages
        # Handles errors like "on main.tf line X, in resource "aws_instance" "foo":"
        resource_match = re.search(r'in resource "([^"]+)" "([^"]+)"', error_message)
        if resource_match:
            resource_type = resource_match.group(1)
            logger.info(f"Found resource type '{resource_type}' in error message.")
            return f"Terraform {resource_type} configuration syntax"

        # Check for errors in output blocks
        if 'in output' in error_message:
            output_match = re.search(r'in output "([^"]+)"', error_message)
            if output_match:
                output_name = output_match.group(1)
                logger.info(f"Found output block '{output_name}' in error message.")
                return f"Terraform output block syntax for '{output_name}'"
            logger.info("Error is in an output block.")
            return "Terraform output block syntax"

        # Check for errors in variable blocks
        if 'in variable' in error_message:
            variable_match = re.search(r'in variable "([^"]+)"', error_message)
            if variable_match:
                variable_name = variable_match.group(1)
                logger.info(f"Found variable block '{variable_name}' in error message.")
                return f"Terraform variable block syntax for '{variable_name}'"
            logger.info("Error is in a variable block.")
            return "Terraform variable block syntax"
            
        # Fallback to the original, less specific regex if the above fail
        fallback_match = re.search(r'resource "(\w+)"', hcl_code)
        if fallback_match:
            resource_type = fallback_match.group(1)
            logger.warning(f"Using fallback to find resource type '{resource_type}' from HCL code.")
            return f"{resource_type} configuration syntax"

        # Generic fallback
        logger.warning("Could not determine specific context from error. Using generic query.")
        return "Terraform syntax best practices"

    def _extract_concise_error(self, full_error_message: str) -> str:
        """Extracts the primary 'Error:' line from a verbose Terraform output."""
        match = re.search(r"Error: .*", full_error_message)
        if match:
            return match.group(0)
        # Fallback to a snippet if the main error line isn't found
        return (full_error_message[:200] + '...') if len(full_error_message) > 200 else full_error_message

    def _clean_hcl_from_llm_output(self, llm_output: str) -> str:
        """
        Cleans the HCL code block from the LLM's output.
        Handles markdown code blocks and other potential wrapping.
        """
        logger.debug(f"Cleaning LLM output: {llm_output}")
        if "```hcl" in llm_output:
            # Extracts content between ```hcl and ```
            try:
                return llm_output.split("```hcl")[1].split("```")[0].strip()
            except IndexError:
                # Fallback for malformed markdown
                return llm_output.replace("```hcl", "").replace("```", "").strip()
        # Fallback for outputs that might not use markdown
        return llm_output.strip()

    def _programmatic_syntax_fix(self, hcl_code: str) -> str:
        """
        A simple, rule-based fix for common, known syntax errors that the LLM may produce.
        This acts as a safeguard.
        """
        # Fix for: value = "${aws_instance.example.id}" -> value = aws_instance.example.id
        # This regex finds `value = ` followed by an optional quoted `${...}` block
        pattern = re.compile(r'(\s*value\s*=\s*)("?)\$\{(.+?)\}\2', re.MULTILINE)
        
        # The replacement function removes the quotes and the ${} wrapper
        fixed_code = pattern.sub(r'\1\3', hcl_code)
        
        if hcl_code != fixed_code:
            logger.info("🤖 Applied programmatic syntax fix for deprecated output values.")
            
        return fixed_code 