import os
import shutil
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

def prepare_lambda_upload(uploaded_file_name: str) -> Dict[str, Any]:
    """
    Prepares for a Lambda deployment by generating the agent prompt.

    Args:
        uploaded_file_name: The name of the .zip file provided by the user.

    Returns:
        A dictionary containing the prompt addition.
    """
    logger.info("Preparing Lambda upload...")
    
    prompt_addition = (
        f"\\n\\n**CRITICAL INSTRUCTION FOR `aws_lambda_function` CODE GENERATION:**\\n"
        f"The user has uploaded a code artifact named '{uploaded_file_name}'. You will be generating the `aws_lambda_function` resource.\\n"
        f"1.  The `filename` argument MUST be the exact relative path: `./{uploaded_file_name}`.\\n"
        f"2.  The `source_code_hash` argument MUST be `filebase64sha256(\"./{uploaded_file_name}\")`.\\n"
        f"3.  The `role` argument for this function is critical. The plan includes a corresponding `aws_iam_role` for this function. You MUST reference its ARN correctly. For example: `role = aws_iam_role.lambda_exec_role.arn` (the exact role name may vary based on the plan)."
    )
    
    return {
        "prompt_addition": prompt_addition
    }

def copy_lambda_artifact(source_zip_path: str, destination_dir: str):
    """
    Copies the Lambda function's .zip artifact to the final destination directory.

    Args:
        source_zip_path: The absolute path to the source .zip file.
        destination_dir: The path to the directory where the artifact should be saved.
    """
    logger.info("Lambda artifact helper triggered.")
    logger.info(f"  - Source: {source_zip_path}")
    logger.info(f"  - Destination: {destination_dir}")

    if not source_zip_path or not os.path.exists(source_zip_path):
        logger.warning(f"Lambda artifact source path '{source_zip_path}' does not exist. Skipping copy.")
        return

    try:
        destination_path = os.path.join(destination_dir, os.path.basename(source_zip_path))
        shutil.copy(source_zip_path, destination_path)
        logger.info(f"✅ Successfully copied Lambda artifact '{os.path.basename(source_zip_path)}' to '{destination_dir}'.")
    except Exception as e:
        logger.error(f"❌ Failed to copy Lambda artifact from '{source_zip_path}': {e}", exc_info=True)
        # Depending on requirements, you might want to raise the exception
        raise
