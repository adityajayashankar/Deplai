import json
import os
import traceback
import sys
import re
from io import BytesIO
from custom_diagrams import Diagram # Assuming this is a custom class for diagram generation
from diagrams import Cluster, Edge
from diagrams.custom import Custom
from AWS.constants.maps import mapper
import AWS.constants.diagram_imports as diagram_imports
from logger import setup_logger # Import the logger
from ui.utils import clean_filename, get_unique_project_directory # Import from utils
from AWS.aws_diagram_helper import generate_aws_diagram
from Azure.azure_diagram_helper import generate_azure_diagram
from GCP.gcp_diagram_helper import generate_gcp_diagram

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../")))

logger = setup_logger(name="DiagramGenService") # Initialize logger for this module

class DiagramGen:
    def __init__(self):
        # Initialization can be empty or for other non-MQ setup if needed
        pass 

    def generate_diagram_from_json_direct(self, provider: str, architecture_json: dict, output_directory: str, project_title_for_filename: str) -> str | dict:
        """
        Orchestrates the generation of an architecture diagram based on the cloud provider.

        Args:
            provider (str): The cloud provider ('aws' or 'azure').
            architecture_json (dict): The architecture definition.
            output_directory (str): The directory to save the diagram in.
            project_title_for_filename (str): The title of the project.
        
        Returns:
            str: The path to the generated diagram or a dict with an error.
        """
        cloud_provider = provider.lower()

        if not os.path.exists(output_directory):
            try:
                os.makedirs(output_directory)
                logger.info(f"Created output directory: {output_directory}")
            except OSError as e:
                error_msg = f"Failed to create output directory {output_directory}: {e}"
                logger.error(error_msg)
                return {"error": error_msg}

        try:
            if cloud_provider == "azure":
                logger.info(f"Delegating to Azure diagram generator for project: {project_title_for_filename}")
                return generate_azure_diagram(architecture_json, output_directory, project_title_for_filename)
            elif cloud_provider == "gcp" or cloud_provider == "google cloud":
                logger.info(f"Delegating to GCP diagram generator for project: {project_title_for_filename}")
                return generate_gcp_diagram(architecture_json, output_directory, project_title_for_filename)
            # Default to AWS if provider is not specified or is different from azure
            logger.info(f"Delegating to AWS diagram generator for project: {project_title_for_filename}")
            return generate_aws_diagram(architecture_json, output_directory, project_title_for_filename)
        except Exception as e:
            error_msg = f"An error occurred during diagram generation: {e}"
            logger.error(error_msg, exc_info=True)
            return {"error": error_msg, "traceback": traceback.format_exc()}

# Example usage (for testing purposes)
if __name__ == '__main__':
    diagram_generator = DiagramGen()
    # Example AWS JSON
    aws_json = {
        "cloud_provider": "aws",
        "services": {
            "EC2": {
                "resources": [{"name": "My-EC2-Instance"}]
            },
            "S3": {
                "resources": [{"name": "My-S3-Bucket"}]
            }
        },
        "relationships": [
            {"source": "My-EC2-Instance", "target": "My-S3-Bucket", "action": "reads from"}
        ]
    }

    # Example Azure JSON
    azure_json = {
        "cloud_provider": "azure",
        "services": {
            "Virtual Machine": {
                "resources": [{"name": "My-VM"}]
            },
            "Blob Storage": {
                "resources": [{"name": "My-Blob-Storage"}]
            }
        },
        "relationships": [
            {"source": "My-VM", "target": "My-Blob-Storage", "action": "writes to"}
        ]
    }
    
    output_directory = "output_diagrams"
    
    print("Generating AWS diagram...")
    aws_diagram_path = diagram_generator.generate_diagram_from_json_direct("aws", aws_json, output_directory, "TestProjectAWS")
    print(f"AWS diagram saved to: {aws_diagram_path}")

    print("\nGenerating Azure diagram...")
    azure_diagram_path = diagram_generator.generate_diagram_from_json_direct("azure", azure_json, output_directory, "TestProjectAzure")
    print(f"Azure diagram saved to: {azure_diagram_path}")

    # For testing, we need a base directory for projects similar to how streamlit_app would define it.
    # This test setup will now more closely mimic how the function is called.
    script_base_dir = os.path.dirname(__file__)
    test_projects_main_dir = os.path.join(script_base_dir, "Test_Projects_Output_Single_Dir_Test")
    os.makedirs(test_projects_main_dir, exist_ok=True)

    # Sample JSON (ensure it matches what architecture_JsonGen produces, including diagram_properties)
    sample_arch_json_1 = {
        "title": "My Test Web App",
        "diagram_properties": {
            "orientation": "LR"
        },
        "nodes": [
            {"id": "user", "label": "User", "type": "user", "group": "Clients"},
            {"id": "webapp", "label": "Web Application Server", "type": "AmazonEC2", "group": "Application Tier"},
            {"id": "database", "label": "Primary SQL Database", "type": "AmazonRDS", "group": "Data Tier"},
            {"id": "cache", "label": "In-Memory Cache", "type": "AmazonElastiCache", "group": "Data Tier"},
            {"id": "lb", "label": "Load Balancer", "type": "AWSELB", "group": "Network"}
        ],
        "edges": [
            {"from": "user", "to": "lb", "label": "HTTPS"},
            {"from": "lb", "to": "webapp", "label": "HTTP"},
            {"from": "webapp", "to": "database", "label": "JDBC"},
            {"from": "webapp", "to": "cache", "label": "TCP"}
        ]
    }

    # Test 1: First Generation
    logger.info("--- Test Case 1: First Generation ---")
    # Simulate streamlit_app creating the unique directory first
    test1_proj_title = "My Test Web App for DiagramGen Test"
    test1_unique_dir = get_unique_project_directory(test_projects_main_dir, test1_proj_title)
    if not test1_unique_dir:
        logger.error("Test setup failed: Could not create unique dir for Test 1")
    else:
        logger.info(f"Test 1: Using pre-determined unique directory: {test1_unique_dir}")
        result1 = diagram_generator.generate_diagram_from_json_direct(
            "aws",
            sample_arch_json_1, 
            output_directory=test1_unique_dir, 
            project_title_for_filename=test1_proj_title # or use sample_arch_json_1.get("title")
        )
        if isinstance(result1, str):
            logger.info(f"SUCCESS: Diagram 1 generated at: {result1}")
        else:
            logger.error(f"ERROR generating diagram 1: {result1.get('error')}")

    # Test 2: Generate with a different title (will go into a new unique dir)
    logger.info("--- Test Case 2: Different Title ---")
    test2_proj_title = "Another System Design Diagram Test!@#$"
    test2_unique_dir = get_unique_project_directory(test_projects_main_dir, test2_proj_title)
    sample_arch_json_2 = {
        "title": "JSON Internal Title Differs", # This title is for the diagram content, not filename necessarily
        "nodes": [{"id": "sys_a", "label": "System A", "type": "aws.compute.ec2", "group": "Compute"}],
        "edges": []
    }
    if not test2_unique_dir:
        logger.error("Test setup failed: Could not create unique dir for Test 2")
    else:
        logger.info(f"Test 2: Using pre-determined unique directory: {test2_unique_dir}")
        result2 = diagram_generator.generate_diagram_from_json_direct(
            "aws",
            sample_arch_json_2, 
            output_directory=test2_unique_dir, 
            project_title_for_filename=test2_proj_title
        )
        if isinstance(result2, str):
            logger.info(f"SUCCESS: Diagram 2 generated at: {result2}")
        else:
            logger.error(f"ERROR generating diagram 2: {result2.get('error')}")

    # Test 3: Empty/Whitespace title for filename
    logger.info("--- Test Case 3: Empty project_title_for_filename ---")
    test3_proj_title = "Empty Filename Test Project"
    test3_unique_dir = get_unique_project_directory(test_projects_main_dir, test3_proj_title)
    sample_arch_json_empty_title_filename = {
        "title": "JSON Title Present", 
        "nodes": [{"id": "node_x", "label": "Node X", "type": "generic", "group": "Default"}],
        "edges": []
    }
    if not test3_unique_dir:
        logger.error("Test setup failed: Could not create unique dir for Test 3")
    else:
        logger.info(f"Test 3: Using pre-determined unique directory: {test3_unique_dir}")
        result3 = diagram_generator.generate_diagram_from_json_direct(
            "aws",
            sample_arch_json_empty_title_filename, 
            output_directory=test3_unique_dir, 
            project_title_for_filename="   " # Test with whitespace only
        )
        if isinstance(result3, str):
            logger.info(f"SUCCESS: Diagram 3 generated at: {result3} (should use default filename like 'architecture_diagram.png')")
        else:
            logger.error(f"ERROR generating diagram 3: {result3.get('error')}")

    # No longer testing project_title_override as the directory is now explicitly passed.
    # The `generate_diagram_from_json_direct` itself no longer creates suffixed directories.

    logger.info("Diagram generation tests complete. Check the file system for output in app-backend-cost_estimation/Test_Projects_Output_Single_Dir_Test.")