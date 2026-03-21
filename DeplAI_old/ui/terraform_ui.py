import streamlit as st
import json
import uuid
import os
import base64
from logger import setup_logger
from ui.github_ui import render_github_deployment_stage

logger = setup_logger(name="TerraformUI")

def render_terraform_generation_stage(st_object, publish_to_rabbitmq_func, consume_from_reply_queue_func, get_rabbitmq_channel_func):
    """
    Renders the UI for the Terraform code generation stage.
    This function manages the state of the generation process, communicates with the backend
    via RabbitMQ, and displays the generated files.
    """
    st_object.header("Phase 2: Terraform Code Generation")
    st_object.markdown("---")

    # Check for required data from the previous stage
    if not st_object.session_state.get("generated_architecture_json"):
        st_object.error("Architecture JSON not found in the session. Please return to the architecture phase to generate it.")
        if st_object.button("⬅️ Back to Architecture Review"):
            st_object.session_state.current_stage = "final_report"
            st_object.rerun()
        return

    # Initialize state for this stage if it doesn't exist
    if "terraform_generation_status" not in st_object.session_state:
        st_object.session_state.terraform_generation_status = "not_started"  # States: not_started, in_progress, completed, failed
        st_object.session_state.generated_terraform_files = None
        st_object.session_state.generated_readme = None
        st_object.session_state.terraform_error = None

    status = st_object.session_state.terraform_generation_status

    # State: Not Started
    if status == "not_started":
        st_object.info("Ready to generate Terraform code based on the approved architecture.")
        if st_object.button("🚀 Generate Terraform Code and README", use_container_width=True):
            st_object.session_state.terraform_generation_status = "in_progress"
            st_object.rerun()

    # State: In Progress
    if status == "in_progress":
        with st_object.spinner("🤖 Generating Terraform code via backend service... This may take a few minutes."):
            correlation_id = str(uuid.uuid4())
            channel = get_rabbitmq_channel_func()
            
            if not channel:
                st_object.session_state.terraform_generation_status = "failed"
                st_object.session_state.terraform_error = "Could not establish a connection with the backend service (RabbitMQ channel unavailable)."
                st_object.rerun()

            try:
                reply_q_obj = channel.queue_declare(queue='', exclusive=True, auto_delete=True)
                reply_q_name = reply_q_obj.method.queue
                
                # --- Prepare Payload ---
                payload = {
                    "architecture_json": st_object.session_state.generated_architecture_json,
                    "provider": st_object.session_state.project_details.get("provider"),
                    "project_name": st_object.session_state.project_details.get("title"),
                    "deployment_type": st_object.session_state.project_details.get("deployment_type", "Infrastructure-Only"),
                    "upload_type": st_object.session_state.project_details.get("upload_type"),
                    "uploaded_file_data": None,
                    "uploaded_file_name": None
                }

                # If a file was uploaded, encode it and add to payload
                if st_object.session_state.get("uploaded_file"):
                    uploaded_file = st_object.session_state.uploaded_file
                    # Reset buffer to the beginning before reading
                    uploaded_file.seek(0)
                    file_bytes = uploaded_file.read()
                    payload["uploaded_file_data"] = base64.b64encode(file_bytes).decode('utf-8')
                    payload["uploaded_file_name"] = uploaded_file.name
                    logger.info(f"Encoding and sending uploaded file '{uploaded_file.name}' to backend worker.")

                success = publish_to_rabbitmq_func(
                    queue_name="terraformGenerationRequestQueue",
                    routing_key="terraformGenerationRequestKey",
                    exchange_name="direct_exchange",
                    payload=payload,
                    reply_to=reply_q_name,
                    correlation_id=correlation_id
                )

                if success:
                    # Increased timeout for potentially long-running code generation
                    response = consume_from_reply_queue_func(reply_q_name, correlation_id, timeout_seconds=900) 
                    
                    if response and "error" in response:
                        st_object.session_state.terraform_generation_status = "failed"
                        st_object.session_state.terraform_error = response["error"]
                    elif response and "terraform_files" in response and "readme" in response:
                        st_object.session_state.terraform_generation_status = "completed"
                        st_object.session_state.generated_terraform_files = response["terraform_files"]
                        st_object.session_state.generated_readme = response["readme"]
                        
                        # Save the generated files to the project directory
                        output_dir = st_object.session_state.current_project_output_dir

                        # --- Handle returned code package (e.g., zip file) ---
                        if response.get("uploaded_file_data") and response.get("uploaded_file_name"):
                            file_data_b64 = response["uploaded_file_data"]
                            file_name = response["uploaded_file_name"]
                            file_path = os.path.join(output_dir, file_name)
                            try:
                                file_bytes = base64.b64decode(file_data_b64)
                                with open(file_path, "wb") as f:
                                    f.write(file_bytes)
                                logger.info(f"Saved returned user artifact: {file_path}")
                            except Exception as e:
                                logger.error(f"Failed to decode and save user artifact '{file_name}': {e}")
                                # Optionally notify the user of this specific failure
                                st_object.session_state.terraform_error = f"Failed to process the deployment package '{file_name}' returned by the worker."
                        
                        for filename, content in response["terraform_files"].items():
                            filepath = os.path.join(output_dir, filename)
                            with open(filepath, "w", encoding='utf-8') as f:
                                f.write(content)
                            logger.info(f"Saved generated Terraform file: {filepath}")
                        
                        readme_path = os.path.join(output_dir, "README.md")
                        with open(readme_path, "w", encoding='utf-8') as f:
                            f.write(response["readme"])
                        logger.info(f"Saved generated README.md: {readme_path}")
                    else:
                        st_object.session_state.terraform_generation_status = "failed"
                        st_object.session_state.terraform_error = "Timeout or invalid response from the Terraform generation service."
                else:
                    st_object.session_state.terraform_generation_status = "failed"
                    st_object.session_state.terraform_error = "Failed to publish the generation request to the backend service."
            
            except Exception as e:
                logger.error(f"An exception occurred during Terraform generation process: {e}", exc_info=True)
                st_object.session_state.terraform_generation_status = "failed"
                st_object.session_state.terraform_error = f"An unexpected error occurred: {e}"

            st_object.rerun()

    # State: Completed
    if status == "completed":
        st_object.success("✅ Terraform code and README generated successfully!")
        st_object.markdown("---")
        
        st_object.subheader("Generated README.md")
        with st_object.expander("View/Hide README", expanded=True):
            st_object.markdown(st_object.session_state.generated_readme)
        st_object.markdown("---")

        st_object.subheader("Generated Terraform Files")
        if st_object.session_state.generated_terraform_files:
            # Create tabs for each generated file
            file_tabs = st_object.tabs(sorted(list(st_object.session_state.generated_terraform_files.keys())))
            for i, filename in enumerate(sorted(list(st_object.session_state.generated_terraform_files.keys()))):
                with file_tabs[i]:
                    st_object.code(st_object.session_state.generated_terraform_files[filename], language='hcl')

        st_object.markdown("---")
        
        # --- Phase 3: Deployment UI ---
        # This function is defined in ui/github_ui.py and contains the form
        # for capturing credentials and triggering the next step.
        render_github_deployment_stage(
            st_object=st_object,
            publish_to_rabbitmq_func=publish_to_rabbitmq_func,
            consume_from_reply_queue_func=consume_from_reply_queue_func,
            get_rabbitmq_channel_func=get_rabbitmq_channel_func
        )

    # State: Failed
    if status == "failed":
        st_object.error(f"Terraform generation failed. Error: {st_object.session_state.terraform_error}")
        if st_object.button("Retry Generation"):
            # Reset state and try again
            st_object.session_state.terraform_generation_status = "not_started"
            st_object.session_state.generated_terraform_files = None
            st_object.session_state.generated_readme = None
            st_object.session_state.terraform_error = None
            st_object.rerun() 