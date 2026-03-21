import os
import re
import shutil
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import logging

# Assuming Plan is defined in a way accessible here, or we pass what's needed.
# from ...src.agent.planner import Plan -> This would create a circular dependency.
# Instead, we'll pass primitive types from the plan.

logger = logging.getLogger(__name__)

def save_artifacts(
    plan, 
    split_hcl_code: Dict[str, str], 
    readme_content: str, 
    user_code_path: Optional[str] = None
) -> str:
    """
    Saves generated artifacts to a timestamped directory.
    - Creates a unique directory for the project run.
    - Saves the files provided in the `split_hcl_code` dictionary.
    - Saves README.md and .gitignore.
    
    Args:
        plan: The execution plan object, used for naming the directory.
        split_hcl_code: A dictionary where keys are filenames and values are the file contents.
        readme_content: A string containing the content for the README file.
        user_code_path: Optional path to the user's uploaded code file.

    Returns:
        The path to the output directory as a string.
    """
    try:
        # --- 1. Create Output Directory ---
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        sanitized_query = re.sub(r'[^\w\s-]', '', plan.summary).strip().replace(' ', '_')[:50]
        output_dir_name = f"{timestamp}_{sanitized_query}"
        
        project_root = Path(__file__).resolve().parent.parent.parent.parent
        output_path = project_root / "output" / output_dir_name
        output_path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Created artifact directory: {output_path}")

        # --- 2. Write HCL Files from Dictionary ---
        for filename, content in split_hcl_code.items():
            if content: # Only write files that have content
                (output_path / filename).write_text(content, encoding='utf-8')
                logger.info(f"  - Wrote {filename}")

        # --- 3. Write README.md ---
        if readme_content:
            (output_path / "README.md").write_text(readme_content, encoding='utf-8')
            logger.info("  - Wrote README.md")

        # --- 4. Create .gitignore from template ---
        try:
            gitignore_template_path = project_root / "cicd_templates" / ".gitignore"
            if gitignore_template_path.exists():
                gitignore_content = gitignore_template_path.read_text(encoding='utf-8')
                (output_path / ".gitignore").write_text(gitignore_content, encoding='utf-8')
                logger.info("  - Wrote .gitignore from template")
            else:
                logger.warning(f"Could not find .gitignore template at: {gitignore_template_path}")
        except Exception as e:
            logger.error(f"❌ Failed to create .gitignore file: {e}")

        # --- 5. Copy User-Uploaded Code if it exists ---
        logger.info(f"Attempting to copy user code. Provided path: {user_code_path}. Path exists: {os.path.exists(user_code_path) if user_code_path else False}")
        if user_code_path and os.path.exists(user_code_path):
            try:
                if os.path.isdir(user_code_path):
                    # It's a directory (e.g., unzipped website). Copy the entire directory.
                    # The `dirs_exist_ok=True` argument will make it behave like `cp -R` or `robocopy`,
                    # merging the source directory into the destination.
                    shutil.copytree(user_code_path, output_path, dirs_exist_ok=True)
                    logger.info(f"✅ Copied contents of user code directory '{user_code_path}' to artifacts directory.")
                else:
                    # It's a single file (e.g., a .zip for Lambda). Copy it directly.
                    destination_path = output_path / os.path.basename(user_code_path)
                    shutil.copy(user_code_path, destination_path)
                    logger.info(f"✅ Copied user code file '{os.path.basename(user_code_path)}' to artifacts directory.")
            except Exception as e:
                logger.error(f"❌ Failed to copy user code from '{user_code_path}': {e}", exc_info=True)
        
        logger.info(f"✅ Successfully saved all artifacts to: {output_path}")
        return str(output_path)
        
    except Exception as e:
        logger.error(f"❌ Failed to save artifacts: {e}", exc_info=True)
        return "" 