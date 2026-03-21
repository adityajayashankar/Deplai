import os
import zipfile
import tempfile
import shutil
import json
from typing import List, Tuple, Dict, Any

from logger import setup_logger

logger = setup_logger(name="S3WebsiteHelpers")

def prepare_s3_upload(zip_file_path: str, project_name: str) -> Dict[str, Any]:
    """
    Prepares for an S3 static website deployment by unzipping files and generating the agent prompt.

    Args:
        zip_file_path: The absolute path to the .zip file.
        project_name: The name of the project.

    Returns:
        A dictionary containing the prompt addition, the path for the agent, and a cleanup path.
    """
    logger.info("Preparing S3 upload...")
    try:
        unzipped_dir, file_list = unzip_website_files(zip_file_path, project_name)
        
        prompt_addition = (
            f"\\n\\n**CRITICAL INSTRUCTION FOR S3 WEBSITE:** The user has provided a .zip file for a static website which has been unzipped. "
            f"You MUST generate an 'aws_s3_object' resource for EACH of the following files: {json.dumps(file_list)}. "
            f"For each 'aws_s3_object', the 'key' argument should be the filename (e.g., 'index.html') and the 'source' argument must be a relative path "
            f"pointing to the file within the application's code directory (e.g., './index.html').\\n"
            f"**NEGATIVE CONSTRAINT:** You are absolutely forbidden from using the 'acl' argument in any 'aws_s3_object' resource. "
            f"The use of 'acl' is deprecated and will cause the deployment to fail. Public access is handled by the bucket policy. "
            f"Do NOT use a 'local-exec' provisioner to upload files."
        )
        
        # The path for the agent is the directory containing the unzipped files.
        # The cleanup path is the parent directory created by mkdtemp.
        return {
            "prompt_addition": prompt_addition,
            "code_path_for_agent": unzipped_dir,
            "unzipped_website_dir": unzipped_dir, # Pass this along for the finalization step
            "cleanup_path": os.path.dirname(unzipped_dir)
        }
    except Exception as e:
        logger.error(f"Failed during S3 preparation: {e}", exc_info=True)
        raise

def unzip_website_files(zip_file_path: str, project_name: str) -> Tuple[str, List[str]]:
    """
    Copies and unzips a .zip file to a temporary directory for an S3 website.

    Args:
        zip_file_path: The absolute path to the .zip file.
        project_name: The name of the project to create a unique sub-directory.

    Returns:
        A tuple containing:
        - The path to the directory with the unzipped files.
        - A list of the relative paths of the unzipped files.
    """
    # Create a unique temporary directory for this operation
    operation_temp_dir = tempfile.mkdtemp(prefix=f"{project_name}_")
    logger.info(f"Created temporary directory for website files operation: {operation_temp_dir}")

    # The destination for the unzipped files
    unzip_dir = os.path.join(operation_temp_dir, "unzipped_website")
    os.makedirs(unzip_dir, exist_ok=True)
    
    extracted_files = []
    try:
        # Unzip the file directly into the target directory
        with zipfile.ZipFile(zip_file_path, 'r') as zip_ref:
            zip_ref.extractall(unzip_dir)
            # List the extracted files (relative to the unzip_dir)
            for item in zip_ref.infolist():
                if not item.is_dir():
                    extracted_files.append(item.filename)

        logger.info(f"Successfully unzipped {len(extracted_files)} files from '{zip_file_path}' to: {unzip_dir}")
    except Exception as e:
        logger.error(f"Failed to unzip file at {zip_file_path}: {e}", exc_info=True)
        # Clean up the created directory on failure
        shutil.rmtree(operation_temp_dir)
        raise # Re-raise the exception to be handled by the caller

    # The calling function is now responsible for this directory.
    # It should be cleaned up after all operations are complete.
    return unzip_dir, extracted_files 

def copy_s3_website_artifacts(source_unzipped_dir: str, destination_dir: str):
    """
    Copies the contents of the unzipped S3 website directory to the final destination directory.

    Args:
        source_unzipped_dir: The absolute path to the directory containing the unzipped website files.
        destination_dir: The path to the directory where the artifacts should be saved.
    """
    if not source_unzipped_dir or not os.path.isdir(source_unzipped_dir):
        logger.warning(f"S3 website artifact source path '{source_unzipped_dir}' is not a valid directory. Skipping copy.")
        return

    try:
        # The `dirs_exist_ok=True` argument will merge the source directory's contents
        # into the destination, which is exactly what we need.
        shutil.copytree(source_unzipped_dir, destination_dir, dirs_exist_ok=True)
        logger.info(f"✅ Successfully copied S3 website artifacts from '{source_unzipped_dir}' to '{destination_dir}'.")
    except Exception as e:
        logger.error(f"❌ Failed to copy S3 website artifacts: {e}", exc_info=True)
        # Depending on requirements, you might want to raise the exception
        raise

def package_s3_project_for_ui(source_dir: str) -> str:
    """
    Packages the complete S3 project directory into a single .zip file for the UI.
    The zip file is named '__________.zip' and placed inside the source directory.

    Args:
        source_dir: The path to the final project directory containing all artifacts.

    Returns:
        The path to the created .zip file.
    """
    logger.info(f"Packaging final S3 project directory '{source_dir}' into a standardized zip for deployment...")
    try:
        # The zip file will be created inside the directory it's archiving.
        output_filename = os.path.join(source_dir, "s3_website_package.zip")
        
        with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, files in os.walk(source_dir):
                for file in files:
                    # Don't add the zip file to itself
                    if file == "s3_website_package.zip":
                        continue
                    file_path = os.path.join(root, file)
                    # The arcname is the path inside the zip. We want it relative to the source_dir.
                    arcname = os.path.relpath(file_path, source_dir)
                    zipf.write(file_path, arcname)
        
        logger.info(f"✅ Successfully packaged project into: {output_filename}")
        return output_filename
    except Exception as e:
        logger.error(f"❌ Failed to package S3 project directory: {e}", exc_info=True)
        raise 