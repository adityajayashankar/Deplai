import pika
import json
import os
import sys
import time
import base64
import shutil
import zipfile
from pathlib import Path

# Add project directories to Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../terraform_rag_agent/src')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from logger import setup_logger
from agent.orchestrator import AgentOrchestrator
from agent.tools.code_generator import TerraformCodeGeneratorTool
from agent.tools.documentation_generator import DocumentationGeneratorTool
from agent.tools.terraform_validator import TerraformValidationTool
from agent.tools.terraform_corrector import TerraformCodeCorrectorTool
from agent.tools.web_search_tool import WebSearchTool
from agent.tools.terraform_documentation_rag_tool import TerraformDocumentationRAGTool
from agent.tools.other_tf_generator import VariableGeneratorTool, OutputGeneratorTool
from agent.tools.code_splitter import CodeSplitterTool
from config import MQ_HOST, MQ_PORT, MQ_USERNAME, MQ_PASSWORD, OPENAI_API_KEY, TAVILY_API_KEY, HUGGING_FACE_HUB_TOKEN
from agent.helper import s3_website_helper, lambda_fun_helper

# Setup verbose logger
logger = setup_logger(name="TerraformGeneratorWorker", log_to_console=True, level="INFO")

# Define the temporary directory path at the module level
base_temp_upload_dir = Path(__file__).parent / "temp_uploads"

def initialize_agent(provider: str):
    """Initializes a request-specific AgentOrchestrator based on the specified provider."""
    logger.info(f"Initializing Agent Orchestrator for provider: '{provider}'...")
    
    collection_map = {
        "aws": "aws_provider_docs",
        "azure": "azure_provider_docs",
        "gcp": "google_provider_docs", # Corrected key for GCP
        "kubernetes": "kubernetes_provider_docs"
    }
    # Default to 'aws_provider_docs' if the provider is unknown
    collection_name = collection_map.get(provider.lower(), "aws_provider_docs")
    logger.info(f"RAG Tool configured with DB path and collection: '{collection_name}'")

    try:
        db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'terraform_rag_agent', 'data', 'vector_db'))
        
        rag_tool = TerraformDocumentationRAGTool(
            db_path=db_path,
            collection_name=collection_name,
            hf_token=HUGGING_FACE_HUB_TOKEN
        )

        web_search_tool = None
        if TAVILY_API_KEY:
            logger.info("TAVILY_API_KEY found, enabling WebSearchTool.")
            web_search_tool = WebSearchTool(api_key=TAVILY_API_KEY)
        else:
            logger.warning("TAVILY_API_KEY not found in environment. WebSearchTool will be disabled for the corrector.")
        
        # The corrector now requires both tools.
        corrector_tool = TerraformCodeCorrectorTool(rag_tool=rag_tool, web_search_tool=web_search_tool)

        tools = [
            rag_tool,
            TerraformCodeGeneratorTool(),
            VariableGeneratorTool(),
            OutputGeneratorTool(),
            TerraformValidationTool(),
            corrector_tool, # Add the pre-configured corrector tool
            DocumentationGeneratorTool(),
            CodeSplitterTool()
        ]

        # Add WebSearchTool to the main tool list only if it was initialized
        if web_search_tool:
            tools.append(web_search_tool)

        agent = AgentOrchestrator(tools=tools, llm_model_name="gpt-4.1")
        logger.info("✅ Agent Orchestrator initialized successfully for this request.")
        return agent
    except Exception as e:
        logger.error(f"❌ Failed to initialize Agent Orchestrator: {e}", exc_info=True)
        return None

def get_rabbitmq_connection():
    """Establishes a connection to RabbitMQ."""
    credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
    return pika.BlockingConnection(pika.ConnectionParameters(
        host=MQ_HOST, port=MQ_PORT, credentials=credentials, heartbeat=3600))

def on_message(ch, method, props, body):
    """Callback to process a message using the AgentOrchestrator."""
    cid = props.correlation_id
    reply_to = props.reply_to
    logger.info(f"▶️ [CID: {cid[:8]}] Received message. Processing...")

    response_payload = {}
    uploaded_file_path = None
    request_temp_dir = None
    unzipped_website_dir = None
    website_cleanup_dir = None
    
    try:
        payload = json.loads(body.decode())
        architecture_json = payload.get("architecture_json")
        provider = payload.get("provider")
        deployment_type = payload.get("deployment_type", "Infrastructure-Only")
        upload_type = payload.get("upload_type")
        project_name = payload.get("project_name")
        uploaded_file_data = payload.get("uploaded_file_data")
        uploaded_file_name = payload.get("uploaded_file_name")

        if not all([architecture_json, provider, project_name]):
            raise ValueError("Payload is missing 'architecture_json', 'provider', or 'project_name'")
        
        # --- Stage 1: Preparation (Delegate to Helpers) ---
        user_code_prompt_addition = ""
        code_path_for_agent = None
        
        if deployment_type == "Full Deployment (with my code)":
            if not all([uploaded_file_data, uploaded_file_name, upload_type]) or upload_type == "Select Upload Type":
                raise ValueError("Full deployment requires file data, name, and a valid upload type.")

            logger.info(f"[CID: {cid[:8]}] Full deployment detected for type '{upload_type}'.")
            
            request_temp_dir = base_temp_upload_dir / cid
            request_temp_dir.mkdir(exist_ok=True)
            uploaded_file_path = request_temp_dir / uploaded_file_name
            with open(uploaded_file_path, "wb") as f:
                f.write(base64.b64decode(uploaded_file_data))
            logger.info(f"[CID: {cid[:8]}] Saved uploaded file to: {uploaded_file_path}")

            if upload_type and 'Static Website' in upload_type:
                prep_data = s3_website_helper.prepare_s3_upload(str(uploaded_file_path), project_name)
                user_code_prompt_addition = prep_data.get("prompt_addition", "")
                code_path_for_agent = prep_data.get("code_path_for_agent")
                unzipped_website_dir = prep_data.get("unzipped_website_dir")
                website_cleanup_dir = prep_data.get("cleanup_path")
            else: # Assume Lambda or other single-file deployments
                prep_data = lambda_fun_helper.prepare_lambda_upload(uploaded_file_name)
                user_code_prompt_addition = prep_data.get("prompt_addition", "")
                code_path_for_agent = str(uploaded_file_path)

        # --- Stage 2: Execution (Generic Agent Run) ---
        agent = initialize_agent(provider)
        if not agent:
            raise RuntimeError(f"Failed to initialize agent for provider '{provider}'.")

        query = (
            f"Generate a complete Terraform project for the following architecture. "
            f"The deployment type is '{deployment_type}'. "
            f"The project name is '{project_name}'. "
            f"The final output should be a full set of valid and deployable HCL files and a README. "
            f"Architecture: {json.dumps(architecture_json, indent=2)}"
            f"{user_code_prompt_addition}" # Append the helper-generated prompt
        )

        result = agent.run(
            query=query,
            user_code_path=code_path_for_agent,
            upload_type=upload_type,
            project_name=project_name
        )
        
        final_answer = result.get("final_answer", {})
        status = final_answer.get("status")

        if status == "SUCCESS":
            logger.info(f"✅ [CID: {cid[:8]}] Orchestrator run successful.")
            output_path = final_answer.get("output_path")
            if not output_path or not os.path.isdir(output_path):
                raise ValueError(f"Orchestrator succeeded but returned an invalid output path: {output_path}")

            uploaded_file_payload_data = None
            uploaded_file_payload_name = None

            # --- Stage 3: Finalization (Delegate to Helpers) ---
            if upload_type and 'Static Website' in upload_type:
                logger.info("S3 deployment: Copying unzipped website artifacts to the final output directory...")
                s3_website_helper.copy_s3_website_artifacts(
                    source_unzipped_dir=unzipped_website_dir,
                    destination_dir=output_path
                )
                
                logger.info("S3 deployment: Packaging the complete project folder for the UI.")
                final_zip_path = s3_website_helper.package_s3_project_for_ui(output_path)
                uploaded_file_payload_name = os.path.basename(final_zip_path)
                with open(final_zip_path, "rb") as f:
                    uploaded_file_payload_data = base64.b64encode(f.read()).decode('utf-8')
                os.remove(final_zip_path)

            elif uploaded_file_name: # Handle Lambda and other single-file deployments
                logger.info("Non-S3 full deployment detected. Calling artifact helper...")
                lambda_fun_helper.copy_lambda_artifact(
                    source_zip_path=str(uploaded_file_path),
                    destination_dir=output_path
                )
                
                artifact_file_path = os.path.join(output_path, uploaded_file_name)
                if os.path.exists(artifact_file_path):
                    logger.info(f"Found user artifact '{uploaded_file_name}' in output. Encoding for response.")
                    with open(artifact_file_path, "rb") as f:
                        uploaded_file_payload_data = base64.b64encode(f.read()).decode('utf-8')
                        uploaded_file_payload_name = uploaded_file_name
                else:
                    logger.warning(f"Expected user artifact '{uploaded_file_name}' not found in output directory '{output_path}'.")

            # --- Generic Response Packaging (For all deployment types) ---
            terraform_files = {}
            for filename in os.listdir(output_path):
                if filename.endswith((".tf", ".tfvars")):
                    with open(os.path.join(output_path, filename), "r", encoding="utf-8") as f:
                        terraform_files[filename] = f.read()
            
            readme_content = ""
            readme_path = os.path.join(output_path, "README.md")
            if os.path.exists(readme_path):
                with open(readme_path, "r", encoding="utf-8") as f:
                    readme_content = f.read()

            response_payload = {
                "terraform_files": terraform_files,
                "readme": readme_content or "# README not generated.",
                "uploaded_file_data": uploaded_file_payload_data,
                "uploaded_file_name": uploaded_file_payload_name
            }
        else:
            error_message = final_answer.get("message", "Agent run failed without a specific message.")
            logger.error(f"❌ [CID: {cid[:8]}] Orchestrator run failed: {error_message}")
            response_payload = {"error": error_message}

    except Exception as e:
        logger.error(f"💥 [CID: {cid[:8]}] Unhandled exception in worker: {e}", exc_info=True)
        response_payload = {"error": f"An unexpected error occurred in the backend worker: {str(e)}"}
    
    finally:
        ch.basic_publish(
            exchange='',
            routing_key=reply_to,
            properties=pika.BasicProperties(correlation_id=cid),
            body=json.dumps(response_payload)
        )
        ch.basic_ack(delivery_tag=method.delivery_tag)
        logger.info(f"🏁 [CID: {cid[:8]}] Acknowledged and replied to message.")

        # Clean up the temporary directory for the UPLOADED file
        if request_temp_dir and os.path.exists(request_temp_dir):
            try:
                shutil.rmtree(request_temp_dir)
                logger.info(f"[CID: {cid[:8]}] Cleaned up temporary upload directory: {request_temp_dir}")
            except Exception as e:
                logger.error(f"[CID: {cid[:8]}] Failed to clean up temporary upload directory {request_temp_dir}: {e}")
        
        # Clean up the temporary directory for the UNZIPPED files
        if website_cleanup_dir and os.path.exists(website_cleanup_dir):
            try:
                shutil.rmtree(website_cleanup_dir)
                logger.info(f"[CID: {cid[:8]}] Cleaned up temporary website directory: {website_cleanup_dir}")
            except Exception as e:
                logger.error(f"[CID: {cid[:8]}] Failed to clean up temporary website directory {website_cleanup_dir}: {e}")

def main():
    logger.info("🚀 Starting Terraform Generation Worker...")
    
    # Create the base temp directory on startup and clean up old directories
    base_temp_upload_dir.mkdir(exist_ok=True)
    for temp_dir in base_temp_upload_dir.glob('*'):
        if temp_dir.is_dir():
            try:
                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned up old temporary directory: {temp_dir}")
            except Exception as e:
                logger.error(f"Failed to clean up old temporary directory {temp_dir}: {e}")
    while True:
        try:
            # Connect to RabbitMQ
            connection = get_rabbitmq_connection()
            channel = connection.channel()
            channel.exchange_declare(exchange='direct_exchange', exchange_type='direct', durable=True)
            queue_name = 'terraformGenerationRequestQueue'
            channel.queue_declare(queue=queue_name, durable=True)
            channel.queue_bind(exchange='direct_exchange', queue=queue_name, routing_key='terraformGenerationRequestKey')
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(
                queue=queue_name, 
                on_message_callback=on_message
            )
            logger.info(f"[*] Waiting for messages on queue '{queue_name}'. To exit press CTRL+C")
            channel.start_consuming()
        except (pika.exceptions.AMQPConnectionError, ConnectionRefusedError) as e:
            logger.error(f"❌ Could not connect to RabbitMQ: {e}")
            logger.info("Retrying in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            logger.info("🛑 Worker stopped by user.")
            break
        except Exception as e:
            logger.critical(f"💥 An unexpected error occurred in the main loop: {e}")
            logger.info("Retrying in 10 seconds...")
            time.sleep(10)

if __name__ == "__main__":
    main() 