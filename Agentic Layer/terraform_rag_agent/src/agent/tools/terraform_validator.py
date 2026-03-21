"""
This tool is responsible for validating a complete Terraform configuration
by running `terraform init` and `terraform validate`.
"""
import os
import subprocess
import tempfile
import shutil
from pydantic.v1 import BaseModel, Field
from typing import Optional, List, Dict, Union

from .base import BaseTool
from utils.rag_logger import get_rag_logger

logger = get_rag_logger(__name__)

class TerraformValidatorToolInput(BaseModel):
    """Input for the Terraform Validator Tool."""
    code: Union[str, Dict[str, str]] = Field(description="Either a single string of HCL code or a dictionary where keys are filenames and values are the code content.")
    user_code_path: Optional[str] = Field(default=None, description="The local path to a user-provided code artifact (e.g., a .zip file for a Lambda function).")

class TerraformValidationTool(BaseTool):
    """
    A tool to validate Terraform HCL code by running `terraform init`, `validate`, and `plan`.
    It can operate in two modes:
    1.  Single String Mode: Validates a complete block of HCL code.
    2.  Split File Mode: Validates a set of HCL files provided as a dictionary.
    """
    name: str = "terraform_validator"
    description: str = "Validates Terraform HCL code by running `terraform init`, `validate`, and `plan`."
    args_schema = TerraformValidatorToolInput

    def _run(self, code: Union[str, Dict[str, str]], user_code_path: Optional[str] = None) -> dict:
        """
        Runs `terraform init`, `validate`, and `plan` on the given code.
        Returns a dictionary with keys 'valid' (bool) and 'error_message' (str or None).
        """
        temp_dir = ""
        try:
            temp_dir = self._create_temp_dir_and_write_files(code)
            
            # If user code is provided, copy it to the temporary directory
            if user_code_path and os.path.exists(user_code_path):
                if os.path.isdir(user_code_path):
                    # It's a directory (e.g., unzipped website). Copy its contents.
                    for item_name in os.listdir(user_code_path):
                        source_item = os.path.join(user_code_path, item_name)
                        dest_item = os.path.join(temp_dir, item_name)
                        if os.path.isdir(source_item):
                            shutil.copytree(source_item, dest_item)
                        else:
                            shutil.copy2(source_item, dest_item) # copy2 preserves metadata
                    logger.info(f"📦 Copied contents of user code directory '{user_code_path}' to temporary directory for validation.")
                else:
                    # It's a single file (e.g., a .zip for Lambda). Copy it directly.
                    shutil.copy2(user_code_path, temp_dir)
                    logger.info(f"📦 Copied user code file '{user_code_path}' to temporary directory for validation.")

            # --- Step 1: Run `terraform init` ---
            logger.info("🚀 Running `terraform init`...")
            init_result = self._run_command(["terraform", "init", "-no-color"], temp_dir)
            if init_result.returncode != 0:
                error_message = f"❌ `terraform init` failed.\nStdout:\n{init_result.stdout}\nStderr:\n{init_result.stderr}"
                logger.error(error_message)
                return {"valid": False, "error_message": error_message}
            logger.info("✅ `terraform init` successful.")

            # --- Step 2: Run `terraform validate` ---
            logger.info("🚀 Running `terraform validate`...")
            validate_result = self._run_command(["terraform", "validate", "-no-color"], temp_dir)
            if validate_result.returncode != 0:
                error_message = f"❌ Terraform validation failed.\nStdout:\n{validate_result.stdout}\nStderr:\n{validate_result.stderr}"
                logger.error(error_message)
                return {"valid": False, "error_message": error_message}
            logger.info("✅ `terraform validate` successful.")

            # --- Step 3: Run `terraform plan` for a more comprehensive check ---
            logger.info("🚀 Running `terraform plan`...")
            plan_result = self._run_command(["terraform", "plan", "-no-color", "-out=tfplan"], temp_dir)
            if plan_result.returncode != 0:
                error_message = f"❌ Terraform plan failed.\nStdout:\n{plan_result.stdout}\nStderr:\n{plan_result.stderr}"
                logger.error(error_message)
                return {"valid": False, "error_message": error_message}
            
            logger.info("✅ `terraform plan` successful.")
            logger.info("✅ Terraform code is valid.")
            return {"valid": True, "error_message": None}

        except Exception as e:
            error_msg = f"❌ An unexpected error occurred during validation: {e}"
            logger.error(error_msg, exc_info=True)
            return {"valid": False, "error_message": error_msg}
        finally:
            if temp_dir:
                self._cleanup(directory_to_clean=temp_dir)

    def _create_temp_dir_and_write_files(self, code: Union[str, Dict[str, str]]) -> str:
        """Creates a temporary directory and writes the HCL code to file(s)."""
        temp_dir = tempfile.mkdtemp()
        logger.info(f"📁 Created temporary directory for validation: {temp_dir}")

        if isinstance(code, str):
            # Single string mode
            with open(os.path.join(temp_dir, "main.tf"), "w", encoding='utf-8') as f:
                f.write(code)
            logger.info("  - Wrote HCL code to main.tf")
        elif isinstance(code, dict):
            # Split file mode
            for filename, content in code.items():
                if content: # Only write files that have content
                    with open(os.path.join(temp_dir, filename), "w", encoding='utf-8') as f:
                        f.write(content)
                    logger.info(f"  - Wrote HCL code to {filename}")
        else:
            raise TypeError("`code` argument must be a string or a dictionary.")
            
        return temp_dir

    def _run_command(self, command: List[str], temp_dir: str) -> subprocess.CompletedProcess:
        """
        Runs a given command in the specified temporary directory and returns the result.
        """
        return subprocess.run(
            command,
            cwd=temp_dir,
            capture_output=True,
            text=True,
            check=False
        )

    def _cleanup(self, directory_to_clean: str):
        """
        Cleans up the temporary directory.
        """
        try:
            if directory_to_clean and os.path.exists(directory_to_clean):
                logger.info(f"🧹 Cleaning up temporary directory: {directory_to_clean}")
                shutil.rmtree(directory_to_clean)
        except Exception as e:
            logger.error(f"Failed to clean up temporary directory {directory_to_clean}: {e}") 