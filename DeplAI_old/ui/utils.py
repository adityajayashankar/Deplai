import os
import re
from logger import setup_logger
from datetime import datetime
from typing import Optional

logger = setup_logger(name="Utils")

def clean_filename(name: str, for_directory: bool = False) -> str:
    """Cleans a string to be a safe filename or directory name."""
    name = str(name)  # Ensure name is a string
    if not name.strip(): # Handle empty or whitespace-only names early
        return "untitled"

    if for_directory:
        # For directories, allow spaces initially, then replace with underscore.
        # Remove most other special chars but keep it more readable.
        name = re.sub(r'[^\w\s.-]', '', name)  # Allow word chars, whitespace, dot, hyphen
        name = re.sub(r'\s+', '_', name.strip())  # Replace whitespace sequences with a single underscore
    else:
        # For filenames, be more restrictive
        name = name.lower()
        name = re.sub(r'[^a-z0-9_.-]', '', name)  # Allow lowercase alphanum, underscore, dot, hyphen
        name = re.sub(r'\s+', '_', name)  # Replace spaces with underscores
    
    return name if name else "untitled" # Final fallback if cleaning results in empty string

def get_unique_project_directory(base_projects_dir: str, project_title: str) -> str:
    """Determines a unique directory name by appending (1), (2), etc. if necessary, and creates it."""
    # Ensure the main Projects directory exists
    os.makedirs(base_projects_dir, exist_ok=True)

    clean_title_for_dir = clean_filename(project_title, for_directory=True)
    project_dir_base = os.path.join(base_projects_dir, clean_title_for_dir)
    
    counter = 1
    final_project_dir = project_dir_base
    # Check if the base name itself is available first
    if not os.path.exists(final_project_dir):
        os.makedirs(final_project_dir)
        logger.info(f"Created project directory: {final_project_dir}")
        return final_project_dir

    # If base name is taken, start appending counters
    while os.path.exists(final_project_dir):
        final_project_dir = f"{project_dir_base} ({counter})"
        counter += 1
    
    os.makedirs(final_project_dir)
    logger.info(f"Created unique project directory: {final_project_dir}")
    return final_project_dir

def save_project_file(project_output_dir: str, file_content: str, file_base_name: str, file_extension: str) -> Optional[str]:
    """
    Saves a file into the provided project-specific output directory.
    e.g., <project_output_dir>/architecture_details_20230101_120000.json
    """
    if not project_output_dir: 
        logger.error("save_project_file called with no project_output_dir.")
        return None
    
    try:
        os.makedirs(project_output_dir, exist_ok=True) 

        cleaned_base_name = clean_filename(file_base_name, for_directory=False)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        if not file_extension.startswith('.'):
            file_extension = '.' + file_extension
        
        final_filename = f"{cleaned_base_name}_{timestamp}{file_extension}"
        filepath = os.path.join(project_output_dir, final_filename)

        with open(filepath, "w", encoding='utf-8') as f:
            f.write(file_content)
        logger.info(f"Successfully saved project file: {filepath}")
        return filepath
    except Exception as e: 
        logger.error(f"Failed to save project file in dir '{project_output_dir}' (file: {file_base_name}): {e}", exc_info=True)
        return None

if __name__ == '__main__':
    # Test cases for the utility functions
    logger.info("Testing utility functions...")
    
    test_projects_dir = os.path.join(os.path.dirname(__file__), "Test_Projects_Output")
    if not os.path.exists(test_projects_dir):
        os.makedirs(test_projects_dir)
    logger.info(f"Test projects will be created in: {test_projects_dir}")

    titles_to_test = [
        "My Awesome Project",
        "My Awesome Project", # Duplicate
        "Another Project!@#$",
        "  Leading and Trailing Spaces  ",
        "Project with /slashes\\ and:colons",
        "", # Empty title
        "Multi Space   Project Title",
        "My Awesome Project" # Third duplicate
    ]

    for title in titles_to_test:
        unique_dir = get_unique_project_directory(test_projects_dir, title)
        logger.info(f"Input title: '{title}' -> Created dir: '{unique_dir}'")
        # Create a dummy file to simulate usage
        if unique_dir and os.path.exists(unique_dir):
            with open(os.path.join(unique_dir, "test_file.txt"), "w") as f:
                f.write(f"This is a test file for project: {title}\nDirectory: {unique_dir}")
        elif not unique_dir:
            logger.error(f"Failed to get or create a unique directory for title: '{title}'")

    logger.info("Utility function tests complete. Check the Test_Projects_Output directory.")
    # You might want to add shutil.rmtree(test_projects_dir) here if you want to clean up after tests, 
    # but be careful with automated deletion. 
