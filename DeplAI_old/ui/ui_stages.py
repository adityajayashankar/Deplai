import streamlit as st
from logger import setup_logger
import os # Added for os.path.exists for diagram display
import json # Added for json.dumps if any direct saving happens here (though save_project_file handles it)
import uuid # For correlation IDs if any direct MQ call were here (they are passed in)
import time # For any direct time.sleep (though consume_from_reply_queue handles its own timeout)
from ui.github_ui import render_github_deployment_stage

logger = setup_logger(name="UIStages")

def render_project_sidebar(current_stage_key: str):
    """Renders the dynamic project progress sidebar."""
    st.sidebar.title("Project Progress")
    
    stages = {
        "project_definition": "Project Definition",
        "confirm_details": "Confirm Details",
        "requirements_gathering": "Requirements Gathering",
        "analysis": "Analysis",
        "architecture_generation": "Architecture Generation",
        "final_report": "Results",
        "terraform_generation": "Terraform Generation",
        "deployment": "Deployment" # Added deployment stage
    }

    # Find the index of the current stage
    stage_keys = list(stages.keys())
    try:
        current_index = stage_keys.index(current_stage_key)
    except ValueError:
        current_index = -1 # Stage not in the list

    # Display the stages
    for i, (key, name) in enumerate(stages.items()):
        if i == current_index:
            st.sidebar.markdown(f"**➡️ &nbsp; {name}**")
        elif i < current_index:
            st.sidebar.markdown(f"✅ &nbsp; <span style='color:grey'>{name}</span>", unsafe_allow_html=True)
        else:
            st.sidebar.markdown(f"&nbsp; &nbsp; &nbsp; <span style='color:grey'>{name}</span>", unsafe_allow_html=True)

def render_home_page(st_object):
    """Renders the home page/landing page content."""
    # The global CSS for .centered-content, .deplai-title, .deplai-tagline 
    # is assumed to be in streamlit_app.py and applied globally.
    
    st_object.markdown("""
        <div class="centered-content">
            <div class="deplai-title">DEPLAI</div>
            <div class="deplai-tagline">Design. Estimate. Deploy. All with a prompt.</div>
        </div>
    """, unsafe_allow_html=True)
    
    # Centering the button using columns
    col1, col2, col3 = st_object.columns([1,1,1]) # Adjust ratios as needed for centering
    with col2:
        if st_object.button("Let's Start", use_container_width=True):
            st_object.session_state.current_stage = "project_definition"
            logger.info("Moving from home_page to project_definition stage (triggered from ui_stages.render_home_page).")
            st_object.rerun() # Rerun to reflect stage change

def render_project_definition_stage(st_object, ai_determine_question_count_func, ai_client_info):
    """Renders the project definition stage UI and handles its logic."""
    st_object.title("DEPLAI")
    st_object.markdown("Welcome! This tool will help you design the perfect infrastructure for your project.")
    st_object.markdown("---") 

    st_object.subheader("Project Details")
    
    # Provider Selection
    st_object.session_state.project_details["provider"] = st_object.radio(
        "Select Cloud Provider",
        ["AWS", "Azure", "GCP"],
        index=0, # Default to AWS
        horizontal=True,
        help="Choose the cloud provider you want to deploy your infrastructure on."
    )
    
    st_object.session_state.project_details["title"] = st_object.text_input(
        "Project Title", 
        value=st_object.session_state.project_details.get("title", ""),
        placeholder="e.g., E-commerce Platform for Startups",
        help="Enter a concise and descriptive title for your cloud project."
    )
    st_object.session_state.project_details["description"] = st_object.text_area(
        "Project Description", 
        value=st_object.session_state.project_details.get("description", ""),
        placeholder="Describe your project, its goals, key features, expected user load, and any known technical constraints or preferences.",
        height=200,
        help="Provide a detailed description of your project's requirements and objectives."
    )
    
    st.session_state.project_details["other_details"] = st_object.text_area(
        "Other Details (Optional)",
        value=st_object.session_state.project_details.get("other_details", ""),
        placeholder="Include any other relevant information, such as compliance requirements (e.g., HIPAA, GDPR), specific instance types to use or avoid, or existing infrastructure to integrate with.",
        height=100,
        help="Add any other details the AI should consider during the design process."
    )
    
    st.session_state.project_details["deployment_type"] = st_object.radio(
        "Select Deployment Type",
        ["Infrastructure-Only", "Full Deployment (with my code)"],
        index=0,
        horizontal=True,
        help="Choose 'Infrastructure-Only' to generate the cloud architecture, or 'Full Deployment' to include your application code."
    )
    st_object.caption("""
        **Mode Explanation:**
        - **Infrastructure-Only:** Creates and deploys only the cloud architecture (e.g., VPCs, subnets, empty Lambda functions).
        - **Full Deployment:** Deploys both the infrastructure and your application code.
            - Currently supported services:
                - **AWS:** AWS Lambda (`.zip`), S3 (Static Website) (`.zip`)
                - **Azure:** _Coming soon!_
                - **GCP:** _Coming soon!_
    """)

    if st.session_state.project_details["deployment_type"] == "Full Deployment (with my code)":
        st.session_state.uploaded_file = st_object.file_uploader(
            "Upload your application code",
            type=['zip'],
            help="Upload a .zip file containing your application code (e.g., for a Lambda function or S3 website)."
        )
        if st.session_state.get('uploaded_file') is not None:
            st.session_state.project_details["upload_type"] = st_object.selectbox(
                "What is this .zip file for?",
                ("Select Upload Type", "Function", "Static Website"),
                index=0, # Default to placeholder
                help="Specify the purpose of your uploaded code to ensure it's processed correctly."
            )
    else:
        st.session_state.uploaded_file = None
        st.session_state.project_details["upload_type"] = None # Clear the upload type if not in full deployment mode

    if st_object.button("Start Design Process"):
        # Validation check
        can_proceed = True
        if not st.session_state.project_details["title"] or not st.session_state.project_details["description"]:
            st_object.warning("Please provide both a project title and description.")
            can_proceed = False
        
        if st.session_state.project_details["deployment_type"] == "Full Deployment (with my code)":
            if not st.session_state.uploaded_file:
                st_object.warning("Please upload a .zip file for the full deployment.")
                can_proceed = False
            elif st.session_state.project_details.get("upload_type", "Select Upload Type") == "Select Upload Type":
                st_object.warning("Please select the type of upload (e.g., Lambda or S3 Website).")
                can_proceed = False

        if can_proceed:
            with st_object.spinner("AI is determining the number of questions to ask..."):
                logger.info("Calling ai_determine_question_count_func from ui_stages.render_project_definition_stage")
                st_object.session_state.max_questions = ai_determine_question_count_func(
                    ai_client_info, 
                    st_object.session_state.project_details
                )
            st_object.session_state.current_stage = "confirm_details" 
            logger.info("Moving from project_definition to confirm_details stage (triggered from ui_stages.render_project_definition_stage).")
            st_object.rerun()
        else:
            st_object.warning("Please provide both a project title and description.")
            logger.warning("Attempted to start design process with empty title or description (from ui_stages).") 

def render_confirm_details_stage(st_object, get_next_question_func, ai_client_info):
    """Renders the confirm project details stage UI and handles its logic."""
    st_object.header("Confirm Project Details")
    st_object.markdown("Please review your project details before we start gathering requirements.")
    st_object.markdown("---")

    st_object.subheader("Cloud Provider")
    st_object.markdown(f"> {st_object.session_state.project_details.get('provider', '_Not selected_')}")

    st_object.subheader("Project Title")
    st_object.markdown(f"> {st_object.session_state.project_details.get('title', '_Not provided_')}")
    
    st_object.subheader("Project Description")
    st_object.markdown(f"> {st_object.session_state.project_details.get('description', '_Not provided_')}")

    if st.session_state.project_details.get("other_details"):
        st_object.subheader("Other Details")
        st_object.markdown(f"> {st_object.session_state.project_details.get('other_details')}")

    st_object.subheader("Deployment Type")
    deployment_type = st_object.session_state.project_details.get('deployment_type', 'Infrastructure-Only')
    st_object.markdown(f"> {deployment_type}")

    if deployment_type == "Full Deployment (with my code)" and st.session_state.get('uploaded_file'):
        st_object.subheader("Uploaded Code")
        st_object.markdown(f"> `{st.session_state.uploaded_file.name}`")
        upload_type = st.session_state.project_details.get("upload_type", "Not specified")
        st_object.subheader("Upload Type")
        st_object.markdown(f"> {upload_type}")

    st_object.subheader("Estimated Questions")
    st_object.markdown(f"Based on your project description, we'll ask approximately **{st_object.session_state.get('max_questions', 'N/A')}** questions to understand your requirements.")
    st_object.markdown("---")

    col1, col2 = st_object.columns(2)
    with col1:
        if st_object.button("✅ Confirm & Start Questions"):
            st_object.session_state.current_stage = "requirements_gathering"
            st_object.session_state.questions = []
            st_object.session_state.answers = []
            st_object.session_state.current_question_index = 0
            with st_object.spinner("Generating first question..."):
                logger.info("Calling get_next_question_func for the first question (from ui_stages.render_confirm_details_stage).")
                first_question, error = get_next_question_func(
                    ai_client_info,
                    st_object.session_state.project_details,
                    [], []
                )
            if first_question:
                st_object.session_state.questions.append(first_question)
                logger.info("First question generated successfully (from ui_stages).")
            else:
                st_object.error("Failed to generate the first question. Please check your API key or try again.")
                logger.error(f"Failed to generate the first question (from ui_stages). Error: {error}")
            logger.info("Moving from confirm_details to requirements_gathering stage (triggered from ui_stages).")
            st_object.rerun()
    with col2:
        if st_object.button("📝 Edit Details"):
            st_object.session_state.current_stage = "project_definition"
            logger.info("Moving from confirm_details back to project_definition stage (triggered from ui_stages).")
            st_object.rerun() 

def render_requirements_gathering_stage(st_object, get_next_question_func, ai_client_info):
    """Renders the requirements gathering stage UI and handles its logic."""
    st_object.markdown("<h2 style='font-size: 2.5em;'>Requirements Collection</h2>", unsafe_allow_html=True)
    st_object.markdown(f"Question {st_object.session_state.current_question_index + 1} of {st_object.session_state.max_questions}")

    progress_value = 0.0
    if st_object.session_state.max_questions > 0:
        progress_value = (st_object.session_state.current_question_index + 1) / st_object.session_state.max_questions
    st_object.progress(progress_value)
    st_object.markdown("---")

    if st_object.session_state.current_question_index < len(st_object.session_state.questions):
        current_question = st_object.session_state.questions[st_object.session_state.current_question_index]
        st_object.markdown(f"<span style='font-size: 1.7em;'><b>Espada: {current_question}</b></span>", unsafe_allow_html=True)
        
        user_answer = st_object.text_area(f"Your Answer to Question {st_object.session_state.current_question_index + 1}:", key=f"answer_{st_object.session_state.current_question_index}")

        col1, col2 = st_object.columns([1,6])
        with col1:
            if st_object.button("Submit Answer", key=f"submit_answer_{st_object.session_state.current_question_index}"):
                if user_answer:
                    st_object.session_state.answers.append(user_answer)
                    st_object.session_state.current_question_index += 1
                    if st_object.session_state.current_question_index < st_object.session_state.max_questions:
                        with st_object.spinner("Generating next question..."):
                            logger.info(f"Calling get_next_question_func for question {st_object.session_state.current_question_index + 1} (from ui_stages).")
                            next_q, error = get_next_question_func(
                                ai_client_info,
                                st_object.session_state.project_details,
                                st_object.session_state.questions,
                                st_object.session_state.answers
                            )
                        if next_q:
                            st_object.session_state.questions.append(next_q)
                            logger.info(f"Next question ({st_object.session_state.current_question_index + 1}) generated (from ui_stages).")
                        else:
                            st_object.error("Failed to generate the next question. Proceeding to analysis.")
                            logger.error(f"Failed to generate next question (from ui_stages). Error: {error}. Proceeding to analysis.")
                            st_object.session_state.current_stage = "analysis"
                    else:
                        logger.info("All questions asked. Moving to analysis stage (from ui_stages).")
                        st_object.session_state.current_stage = "analysis"
                    st_object.rerun()
                else:
                    st_object.warning("Please provide an answer.")
                    logger.warning("Submit answer clicked with no answer provided (from ui_stages).")
        with col2:
            if st_object.button("Skip to Analysis & Architecture", key="skip_to_analysis_from_ui_stages"):
                st_object.session_state.current_stage = "analysis"
                logger.info("Skipped requirements_gathering. Moving to analysis stage (from ui_stages).")
                st_object.rerun()
    else:
        st_object.info("All questions asked or index out of bounds. Moving to analysis.")
        logger.info("All questions asked or index out of bounds in requirements_gathering (from ui_stages). Moving to analysis stage.")
        st_object.session_state.current_stage = "analysis"
        st_object.rerun()

    st_object.markdown("---")
    with st_object.expander("View previous questions and answers"):
        st_object.subheader("Conversation History")
        if not st_object.session_state.questions:
            st_object.markdown("_No questions asked yet._")
        for i in range(len(st_object.session_state.questions)):
            st_object.markdown(f"**Q{i+1}:** {st_object.session_state.questions[i]}")
            if i < len(st_object.session_state.answers):
                st_object.markdown(f"**A{i+1}:** {st_object.session_state.answers[i]}")
            st_object.markdown("---") 

def render_analysis_stage(st_object, analyze_requirements_func, generate_architecture_prompt_func, ai_client_info):
    """Renders the analysis stage UI and handles its logic."""
    st_object.header("Requirements Analysis")
    
    # Perform analysis if not already done or if explicitly retrying
    # This check ensures analysis is done only once per entry unless state indicates a retry
    if not st_object.session_state.get("analysis_summary") or st_object.session_state.get("retry_analysis_flag", False):
        with st_object.spinner("Analyzing requirements..."):
            logger.info("Calling analyze_requirements_func (from ui_stages.render_analysis_stage).")
            analysis_summary, error = analyze_requirements_func(
                ai_client_info,
                st_object.session_state.project_details,
                st_object.session_state.questions,
                st_object.session_state.answers
            )
        st_object.session_state.retry_analysis_flag = False # Reset retry flag

        if analysis_summary:
            st_object.session_state.analysis_summary = analysis_summary
            # Generate architecture prompt immediately after successful analysis
            st_object.session_state.generated_architecture_prompt = generate_architecture_prompt_func(
                ai_client_info, 
                st_object.session_state.project_details,
                st_object.session_state.questions,
                st_object.session_state.answers
            )
            logger.info("Analysis summary and architecture prompt generated (from ui_stages).")
        else:
            st_object.session_state.analysis_summary = None # Ensure it's None on failure
            st_object.session_state.generated_architecture_prompt = None
            st_object.error(f"Failed to analyze requirements. Error: {error}. Please try again or check logs.")
            logger.error(f"Failed to analyze requirements (from ui_stages). Error: {error}")
            if st_object.button("Retry Analysis"):
                st_object.session_state.retry_analysis_flag = True # Set flag to retry on next rerun
                logger.info("Retry Analysis button clicked (from ui_stages).")
                st_object.rerun()
            return # Stop further rendering in this stage if analysis failed

    # Display analysis summary and prompt if available
    if st_object.session_state.get("analysis_summary"):
        st_object.markdown("### Analysis Summary:")
        st_object.markdown(st_object.session_state.analysis_summary)

        if st_object.session_state.get("generated_architecture_prompt"):
            st_object.markdown("### Generated Architecture Prompt:")
            st_object.text_area("Architecture Prompt", st_object.session_state.generated_architecture_prompt, height=200, disabled=True)
            
            if st_object.button("Proceed to Architecture Generation"):
                # Logic to determine and store unique project output directory is now in streamlit_app.py
                # right before switching to 'architecture_generation' stage.
                # Here we just set the stage.
                st_object.session_state.current_stage = "architecture_generation"
                logger.info("Proceeding to Architecture Generation stage (triggered from ui_stages).")
                st_object.rerun()
        else:
             st_object.warning("Architecture prompt could not be generated. Analysis might have been incomplete.")
             logger.warning("Render_analysis_stage: Architecture prompt missing after analysis summary was supposedly generated.")
    elif not st_object.session_state.get("retry_analysis_flag", False): # Only show if not actively retrying
        st_object.info("Analysis not yet performed or failed. Click 'Retry Analysis' if available.")
        logger.info("Render_analysis_stage: No analysis summary and not in retry state.") 

def render_architecture_generation_stage(st_object, get_rabbitmq_channel_func, publish_to_rabbitmq_func, consume_from_reply_queue_func, generate_security_assessment_func, save_project_file_func, ai_client_info):
    """Renders the architecture generation stage UI and handles its logic."""
    action_taken_in_pass = False

    if not st_object.session_state.get("generated_architecture_prompt"):
        st_object.error("Architecture prompt not generated. Please go back to the analysis stage.")
        logger.error("Architecture prompt not found in session state at architecture_generation stage (from ui_stages).")
        if st_object.button("Back to Analysis"):
            st_object.session_state.current_stage = "analysis"
            logger.info("Moving back to analysis stage from architecture_generation due to missing prompt (from ui_stages).")
            st_object.rerun()
        st_object.stop()

    json_val = st_object.session_state.get("generated_architecture_json")
    json_processed_successfully = isinstance(json_val, dict)
    json_failed = json_val is False

    diagram_val = st_object.session_state.get("diagram_path")
    diagram_processed_successfully = isinstance(diagram_val, str)
    diagram_failed = diagram_val is False
    
    cost_val = st_object.session_state.get("cost_estimation_report")
    cost_processed_successfully = isinstance(cost_val, dict)
    cost_failed = cost_val is False

    security_val = st_object.session_state.get("security_assessment")
    security_processed_successfully = isinstance(security_val, dict)
    security_failed = security_val is False
    
    json_settled = json_processed_successfully or json_failed
    diagram_settled = diagram_processed_successfully or diagram_failed
    cost_settled = cost_processed_successfully or cost_failed
    security_settled = security_processed_successfully or security_failed

    all_components_settled_initially = json_settled and diagram_settled and cost_settled and security_settled
    all_components_succeeded_initially = json_processed_successfully and diagram_processed_successfully and cost_processed_successfully and security_processed_successfully

    if not all_components_settled_initially:
        if not all_components_succeeded_initially:
            st_object.header("Generating Cloud Architecture")
            st_object.markdown("Components are being generated.")
            logger.info("Entering architecture_generation stage. Some components pending (from ui_stages).")

    # 1. Generate Architecture JSON
    if not json_processed_successfully and not json_failed:
        action_taken_in_pass = True
        arch_json_correlation_id = str(uuid.uuid4())
        arch_json_channel = get_rabbitmq_channel_func()
        if not arch_json_channel:
            st_object.error("RabbitMQ connection is not available for Architecture JSON. Cannot proceed.")
            logger.error("RabbitMQ channel not available for Architecture JSON generation (from ui_stages).")
            st_object.session_state.generated_architecture_json = False
        else:
            try:
                arch_json_reply_q_obj = arch_json_channel.queue_declare(queue='', exclusive=True, auto_delete=True)
                arch_json_reply_q_name = arch_json_reply_q_obj.method.queue
                with st_object.spinner("Generating Architecture JSON via backend service..."):
                    logger.info("Requesting Architecture JSON from backend (from ui_stages).")
                    payload = {"prompt": st_object.session_state.generated_architecture_prompt}
                    if publish_to_rabbitmq_func(
                        queue_name="architectureJsonRequestQueue", 
                        routing_key="architectureJsonRequestKey", 
                        exchange_name="direct_exchange", 
                        payload=payload,
                        reply_to=arch_json_reply_q_name,
                        correlation_id=arch_json_correlation_id
                    ):
                        response_json = consume_from_reply_queue_func(arch_json_reply_q_name, arch_json_correlation_id, timeout_seconds=90)
                        if response_json and "architecture_json" in response_json:
                            st_object.session_state.generated_architecture_json = response_json["architecture_json"]
                            logger.info("Architecture JSON received successfully from backend (from ui_stages).")
                            save_project_file_func(st_object.session_state.current_project_output_dir, json.dumps(st_object.session_state.generated_architecture_json, indent=2), "architecture_json", "json")
                        elif response_json and "error" in response_json:
                            error_msg_json = f"Error from Architecture JSON service: {response_json['error']}"
                            st_object.error(error_msg_json)
                            logger.error(f"{error_msg_json} (from ui_stages).")
                            if "raw_response" in response_json:
                                st_object.text_area("Raw Error Response from Backend", response_json['raw_response'], height=100, disabled=True)
                                logger.error(f"Raw error response from Arch JSON backend: {response_json['raw_response']} (from ui_stages).")
                            st_object.session_state.generated_architecture_json = False
                        else:
                            st_object.error("Failed to receive valid architecture JSON from backend or timed out.")
                            logger.error("Failed to receive valid architecture JSON from backend or timed out (from ui_stages).")
                            st_object.session_state.generated_architecture_json = False
                    else:
                        st_object.error("Failed to send request for Architecture JSON to backend.")
                        logger.error("Failed to send (publish) request for Architecture JSON to backend (from ui_stages).")
                        st_object.session_state.generated_architecture_json = False
            except Exception as e_arch_json:
                st_object.error(f"Error during Architecture JSON generation (RabbitMQ setup): {e_arch_json}")
                logger.error(f"Error during Architecture JSON generation (RabbitMQ setup from ui_stages): {e_arch_json}", exc_info=True)
                st_object.session_state.generated_architecture_json = False
            json_val = st_object.session_state.get("generated_architecture_json")
            json_processed_successfully = isinstance(json_val, dict)
            json_failed = json_val is False

    # 2. Generate Diagram
    if json_processed_successfully and not diagram_processed_successfully and not diagram_failed:
        action_taken_in_pass = True
        diag_correlation_id = str(uuid.uuid4())
        diag_channel = get_rabbitmq_channel_func()
        if not diag_channel:
            st_object.error("RabbitMQ connection is not available for Diagram. Cannot proceed.")
            logger.error("RabbitMQ channel not available for Diagram generation (from ui_stages).")
            st_object.session_state.diagram_path = False
        else:
            try:
                diag_reply_q_obj = diag_channel.queue_declare(queue='', exclusive=True, auto_delete=True)
                diag_reply_q_name = diag_reply_q_obj.method.queue
                with st_object.spinner("Generating Architecture Diagram via backend service..."):
                    logger.info("Requesting Architecture Diagram from backend (from ui_stages).")
                    payload_diag = {
                        "provider": st_object.session_state.project_details.get("provider", "aws"),
                        "architecture_json": st_object.session_state.generated_architecture_json,
                        "output_directory": st_object.session_state.current_project_output_dir,
                        "project_title_for_filename": st_object.session_state.project_details.get("title", "architecture_diagram")
                    }
                    if publish_to_rabbitmq_func(
                        queue_name="diagramRequestQueue",
                        routing_key="diagramRequestKey",
                        exchange_name="direct_exchange",
                        payload=payload_diag,
                        reply_to=diag_reply_q_name,
                        correlation_id=diag_correlation_id
                    ):
                        response_diag = consume_from_reply_queue_func(diag_reply_q_name, diag_correlation_id, timeout_seconds=60)
                        if response_diag and "diagram_path" in response_diag:
                            st_object.session_state.diagram_path = response_diag["diagram_path"]
                            logger.info(f"Architecture Diagram path received: {st_object.session_state.diagram_path} (from ui_stages).")
                        elif response_diag and "error" in response_diag:
                            error_msg_diag = f"Error from Diagram service: {response_diag['error']}"
                            st_object.error(error_msg_diag)
                            logger.error(f"{error_msg_diag} (from ui_stages).")
                            st_object.session_state.diagram_path = False
                        else:
                            st_object.error("Failed to receive diagram path from backend or timed out.")
                            logger.error("Failed to receive diagram path from backend or timed out (from ui_stages).")
                            st_object.session_state.diagram_path = False
                    else:
                        st_object.error("Failed to send request for Diagram to backend.")
                        logger.error("Failed to send (publish) request for Diagram to backend (from ui_stages).")
                        st_object.session_state.diagram_path = False
            except Exception as e_diag:
                st_object.error(f"Error during Diagram generation (RabbitMQ setup): {e_diag}")
                logger.error(f"Error during Diagram generation (RabbitMQ setup from ui_stages): {e_diag}", exc_info=True)
                st_object.session_state.diagram_path = False
            diagram_val = st_object.session_state.get("diagram_path")
            diagram_processed_successfully = isinstance(diagram_val, str)
            diagram_failed = diagram_val is False

    # 3. Generate Cost Estimation
    if json_processed_successfully and not cost_processed_successfully and not cost_failed:
        action_taken_in_pass = True
        cost_correlation_id = str(uuid.uuid4())
        cost_channel = get_rabbitmq_channel_func()
        if not cost_channel:
            st_object.error("RabbitMQ connection is not available for Cost Estimation. Cannot proceed.")
            logger.error("RabbitMQ channel not available for Cost Estimation generation (from ui_stages).")
            st_object.session_state.cost_estimation_report = False
        else:
            try:
                cost_reply_q_obj = cost_channel.queue_declare(queue='', exclusive=True, auto_delete=True)
                cost_reply_q_name = cost_reply_q_obj.method.queue
                with st_object.spinner("Generating Cost Estimation via backend service..."):
                    logger.info("Requesting Cost Estimation from backend (from ui_stages).")
                    payload_cost = {
                        "provider": st_object.session_state.project_details.get("provider", "AWS"),
                        "architecture_json": st_object.session_state.generated_architecture_json
                    }
                    if publish_to_rabbitmq_func(
                        queue_name="costEstimationRequestQueue",
                        routing_key="costEstimationRequestKey",
                        exchange_name="direct_exchange",
                        payload=payload_cost,
                        reply_to=cost_reply_q_name,
                        correlation_id=cost_correlation_id
                    ):
                        response_cost = consume_from_reply_queue_func(cost_reply_q_name, cost_correlation_id, timeout_seconds=120)
                        if response_cost and "cost_report" in response_cost:
                            st_object.session_state.cost_estimation_report = response_cost["cost_report"]
                            logger.info("Cost Estimation report received successfully from backend (from ui_stages).")
                            save_project_file_func(st_object.session_state.current_project_output_dir, json.dumps(st_object.session_state.cost_estimation_report, indent=2), "cost_estimation", "json")
                        elif response_cost and "error" in response_cost:
                            error_msg_cost = f"Error from Cost Estimation service: {response_cost['error']}"
                            st_object.error(error_msg_cost)
                            logger.error(f"{error_msg_cost} (from ui_stages).")
                            st_object.session_state.cost_estimation_report = False
                        else:
                            st_object.error("Failed to receive cost estimation from backend or timed out.")
                            logger.error("Failed to receive cost estimation from backend or timed out (from ui_stages).")
                            st_object.session_state.cost_estimation_report = False
                    else:
                        st_object.error("Failed to send request for Cost Estimation to backend.")
                        logger.error("Failed to send (publish) request for Cost Estimation to backend (from ui_stages).")
                        st_object.session_state.cost_estimation_report = False
            except Exception as e_cost:
                st_object.error(f"Error during Cost Estimation generation (RabbitMQ setup): {e_cost}")
                logger.error(f"Error during Cost Estimation generation (RabbitMQ setup from ui_stages): {e_cost}", exc_info=True)
                st_object.session_state.cost_estimation_report = False
            cost_val = st_object.session_state.get("cost_estimation_report")
            cost_processed_successfully = isinstance(cost_val, dict)
            cost_failed = cost_val is False

    # 4. Generate Security Assessment
    arch_prompt_for_security = st_object.session_state.get("generated_architecture_prompt")
    if json_processed_successfully and arch_prompt_for_security and not security_processed_successfully and not security_failed:
        action_taken_in_pass = True
        with st_object.spinner("Generating Security Assessment..."):
            logger.info("Calling generate_security_assessment_func (from ui_stages).")
            provider_for_security = st_object.session_state.project_details.get("provider", "AWS")
            assessment_result, error_details = generate_security_assessment_func(ai_client_info, arch_prompt_for_security, provider_for_security)
            if error_details:
                error_msg_sec = f"Error in Security Assessment: {error_details.get('error', 'Unknown error')}"
                st_object.error(error_msg_sec)
                logger.error(f"{error_msg_sec} (from ui_stages).")
                if "raw_response" in error_details and error_details["raw_response"]:
                    st_object.text_area("Raw Security Assessment Error Response", str(error_details['raw_response']), height=100, disabled=True)
                    logger.error(f"Final Report: Raw Security Assessment Error: {str(error_details['raw_response'])} (from ui_stages).")
                st_object.session_state.security_assessment = False
            elif assessment_result:
                st_object.session_state.security_assessment = assessment_result
                logger.info("Security Assessment generated successfully (from ui_stages).")
                save_project_file_func(st_object.session_state.current_project_output_dir, json.dumps(st_object.session_state.security_assessment, indent=2), "security_assessment", "json")
            else:
                st_object.error("Failed to generate Security Assessment (no result and no error details).")
                logger.error("Failed to generate Security Assessment (no result/error details from ui_stages).")
                st_object.session_state.security_assessment = False
            security_val = st_object.session_state.get("security_assessment")
            security_processed_successfully = isinstance(security_val, dict)
            security_failed = security_val is False
            
    json_settled = json_processed_successfully or json_failed
    diagram_settled = diagram_processed_successfully or diagram_failed
    cost_settled = cost_processed_successfully or cost_failed
    security_settled = security_processed_successfully or security_failed
    
    all_components_settled_finally = json_settled and diagram_settled and cost_settled and security_settled
    all_components_succeeded_finally = json_processed_successfully and diagram_processed_successfully and cost_processed_successfully and security_processed_successfully

    if all_components_settled_finally:
        st_object.markdown("---")
        if not all_components_succeeded_finally and any([json_failed, diagram_failed, cost_failed, security_failed]):
             st_object.warning("Some components could not be generated successfully. Displaying available results and errors.")
             logger.warning("Some architecture components failed generation. Displaying available results/errors (from ui_stages).")

        if json_processed_successfully:
            st_object.subheader("Architecture JSON")
            with st_object.expander("View/Hide Architecture JSON", expanded=False):
                st_object.json(st_object.session_state.generated_architecture_json)
        elif st_object.session_state.get("generated_architecture_json") is False:
            st_object.warning("Architecture JSON generation failed or was skipped.")
            logger.warning("Architecture JSON generation previously marked as failed/skipped (from ui_stages).")
        st_object.markdown("---")

        if diagram_processed_successfully and os.path.exists(diagram_val):
            st_object.subheader("Architecture Diagram")
            with st_object.expander("View/Hide Architecture Diagram", expanded=False):
                st_object.image(st_object.session_state.diagram_path)
                with open(st_object.session_state.diagram_path, "rb") as file:
                    st_object.download_button(
                        label="Download Diagram",
                        data=file,
                        file_name=os.path.basename(st_object.session_state.diagram_path),
                        mime="image/png"
                    )
        elif st_object.session_state.get("diagram_path") is False:
             st_object.warning("Architecture Diagram generation failed or was skipped.")
             logger.warning("Architecture Diagram generation previously marked as failed/skipped (from ui_stages).")
        elif diagram_val and not os.path.exists(diagram_val):
             st_object.error(f"Diagram path found ({diagram_val}) but image file does not exist.")
             logger.error(f"Final Report: Diagram path {diagram_val} found in session state, but image file does not exist on disk (from ui_stages).")
        st_object.markdown("---")

        st_object.subheader("Cost Estimation Report")
        if cost_processed_successfully:
            cost_report_data = st_object.session_state.cost_estimation_report
            st_object.markdown(f"**Architecture Title:** {cost_report_data.get('architecture_title', 'N/A')}")

            # Display Service Breakdown
            st_object.markdown("**Service Cost Breakdown:**")
            
            breakdown = cost_report_data.get("service_breakdown", {})
            if breakdown:
                for service, details in breakdown.items():
                    if isinstance(details, dict) and "error" not in details:
                        # Find the total cost key (e.g., 'ec2_total_monthly_usd')
                        total_key = next((key for key in details if 'total_monthly_usd' in key), None)
                        cost = details.get(total_key, 0.0)
                        
                        # Display the main service total
                        st_object.markdown(f"**{service} Total:** `${cost:,.2f}`")

                        # Add an expander for the detailed breakdown
                        with st_object.expander(f"View details for {service}"):
                            for key, value in details.items():
                                # Clean up the key for display
                                display_key = key.replace('_', ' ').replace('usd', 'USD').capitalize()
                                if isinstance(value, (int, float)):
                                    st_object.markdown(f"- **{display_key}:** `${value:,.2f}`")
                                else:
                                    st_object.markdown(f"- **{display_key}:** {value}")
                    elif isinstance(details, dict) and "error" in details:
                        st_object.error(f"**{service}:** Could not be estimated. Reason: {details['error']}")
                    else:
                        st_object.warning(f"Cost details for {service} are in an unknown format.")
            else:
                st_object.markdown("_No service breakdown available._")

            # Display Overall Total
            st_object.markdown("---") # Separator before the total
            overall_total = cost_report_data.get("overall_total_monthly_usd", 0.0)
            st_object.metric(
                label="Overall Total Monthly Estimate",
                value=f"${overall_total:,.2f}",
                help="This is a high-level estimate. Costs can vary based on actual usage, data transfer, and other factors."
            )

            # Display any notes or errors from the backend
            if cost_report_data.get("notes"):
                # Combine notes and errors for display, but separate them visually
                notes = cost_report_data.get("notes", "")
                errors = cost_report_data.get("errors", [])
                
                # Extract the informational part of the notes
                info_notes = notes
                for error in errors:
                    info_notes = info_notes.replace(error, "").strip()

                if info_notes:
                    st_object.info(f"💡 **Notes from Cost Estimator:**\n\n{info_notes}")
                
                if errors:
                    error_message = "Failed to estimate cost for the following services:\n\n- " + "\n- ".join(errors)
                    st_object.error(f"⚠️ **Estimation Failures:**\n\n{error_message}")
        elif st_object.session_state.get("cost_estimation_report") is False:
            st_object.warning("Cost Estimation generation failed or was skipped.")
            logger.warning("Cost Estimation generation previously marked as failed/skipped (from ui_stages).")
        else:
            st_object.info("Cost Estimation is pending or not applicable yet.")
            logger.info("Cost Estimation pending/not applicable/not yet processed (from ui_stages).")
        st_object.markdown("---")

        if security_processed_successfully:
            st_object.subheader("Security Assessment")
            with st_object.expander("View/Hide Security Assessment", expanded=False):
                sec_assessment = st_object.session_state.security_assessment
                st_object.markdown("##### Potential Vulnerabilities:")
                if sec_assessment.get("vulnerabilities"):
                    for vuln in sec_assessment.get("vulnerabilities", []):
                        st_object.markdown(f"- {vuln}")
                else:
                    st_object.markdown("_No specific vulnerabilities identified._")
                recommendations = sec_assessment.get("recommendations", {})
                st_object.markdown("##### Recommended AWS Services:")
                if recommendations.get("services"):
                    for serv in recommendations.get("services", []):
                        st_object.markdown(f"- {serv}")
                else:
                    st_object.markdown("_No specific services recommended._")
                st_object.markdown("##### Recommended Best Practices:")
                if recommendations.get("practices"):
                    for prac in recommendations.get("practices", []):
                        st_object.markdown(f"- {prac}")
                else:
                    st_object.markdown("_No specific best practices listed._")
        elif st_object.session_state.get("security_assessment") is False:
            st_object.warning("Security Assessment generation failed or was skipped.")
            logger.warning("Security Assessment generation previously marked as failed/skipped (from ui_stages).")
        st_object.markdown("---")

        # --- Next Step Navigation ---
        st_object.subheader("Next Step: Code Generation")
        st_object.markdown("Once you have reviewed the analysis and reports, you can proceed to generate the deployable Terraform code.")
        if st_object.button("🚀 Proceed to Terraform Generation"):
            st_object.session_state.current_stage = "terraform_generation"
            logger.info("Moving from final_report to terraform_generation stage (from ui_stages).")
            st_object.rerun()
    
    elif action_taken_in_pass: 
        logger.debug("Action taken in architecture_generation pass, rerunning (from ui_stages).")
        st_object.rerun() 

def render_final_report_stage(st_object, save_all_results_func):
    """Renders the final report stage UI and handles its logic."""
    st_object.header("DEPLAI Results")
    st_object.markdown("---")
    
    project_title = st_object.session_state.project_details.get("title", "Untitled Project")
    st_object.subheader(f"Final Report for: {project_title}")
    st_object.markdown(f"Generated at: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}") 
    st_object.markdown(f"Output Directory: `{st_object.session_state.get('current_project_output_dir', 'Not Set')}`")
    st_object.markdown("---")

    # Display Architecture JSON
    if st_object.session_state.get("generated_architecture_json") and isinstance(st_object.session_state.generated_architecture_json, dict):
        st_object.subheader("Architecture JSON")
        with st_object.expander("View/Hide Architecture JSON", expanded=True):
            st_object.json(st_object.session_state.generated_architecture_json)
    elif st_object.session_state.get("generated_architecture_json") is False:
        st_object.warning("Architecture JSON generation failed or was skipped.")
    else:
        st_object.info("Architecture JSON not available.")
    st_object.markdown("---")

    # Display Diagram
    diagram_path = st_object.session_state.get("diagram_path")
    if isinstance(diagram_path, str) and os.path.exists(diagram_path):
        st_object.subheader("Architecture Diagram")
        with st_object.expander("View/Hide Architecture Diagram", expanded=True):
            st_object.image(diagram_path)
            with open(diagram_path, "rb") as file:
                st_object.download_button(
                    label="Download Diagram",
                    data=file,
                    file_name=os.path.basename(diagram_path),
                    mime="image/png"
                )
    elif diagram_path is False:
        st_object.warning("Architecture Diagram generation failed or was skipped.")
    elif diagram_path and not os.path.exists(diagram_path):
         st_object.error(f"Diagram path found ({diagram_path}) but image file does not exist.")
    else:
        st_object.info("Architecture Diagram not available.")
    st_object.markdown("---")

    # Display Cost Estimation
    st_object.subheader("Cost Estimation Report")
    if st_object.session_state.get("cost_estimation_report") and isinstance(st_object.session_state.cost_estimation_report, dict):
        cost_report_data = st_object.session_state.cost_estimation_report
        st_object.markdown(f"**Architecture Title:** {cost_report_data.get('architecture_title', 'N/A')}")

        # Display Service Breakdown
        st_object.markdown("**Service Cost Breakdown:**")
        
        breakdown = cost_report_data.get("service_breakdown", {})
        if breakdown:
            for service, details in breakdown.items():
                if isinstance(details, dict) and "error" not in details:
                    # Find the total cost key (e.g., 'ec2_total_monthly_usd')
                    total_key = next((key for key in details if 'total_monthly_usd' in key), None)
                    cost = details.get(total_key, 0.0)
                    
                    # Display the main service total
                    st_object.markdown(f"**{service} Total:** `${cost:,.2f}`")

                    # Add an expander for the detailed breakdown
                    with st_object.expander(f"View details for {service}"):
                        for key, value in details.items():
                            # Clean up the key for display
                            display_key = key.replace('_', ' ').replace('usd', 'USD').capitalize()
                            if isinstance(value, (int, float)):
                                st_object.markdown(f"- **{display_key}:** `${value:,.2f}`")
                            else:
                                st_object.markdown(f"- **{display_key}:** {value}")
                elif isinstance(details, dict) and "error" in details:
                    st_object.error(f"**{service}:** Could not be estimated. Reason: {details['error']}")
                else:
                    st_object.warning(f"Cost details for {service} are in an unknown format.")
        else:
            st_object.markdown("_No service breakdown available._")

        # Display Overall Total
        st_object.markdown("---") # Separator before the total
        overall_total = cost_report_data.get("overall_total_monthly_usd", 0.0)
        st_object.metric(
            label="Overall Total Monthly Estimate",
            value=f"${overall_total:,.2f}",
            help="This is a high-level estimate. Costs can vary based on actual usage, data transfer, and other factors."
        )

        # Display any notes or errors from the backend
        if cost_report_data.get("notes"):
            # Combine notes and errors for display, but separate them visually
            notes = cost_report_data.get("notes", "")
            errors = cost_report_data.get("errors", [])
            
            # Extract the informational part of the notes
            info_notes = notes
            for error in errors:
                info_notes = info_notes.replace(error, "").strip()

            if info_notes:
                st_object.info(f"💡 **Notes from Cost Estimator:**\n\n{info_notes}")
            
            if errors:
                error_message = "Failed to estimate cost for the following services:\n\n- " + "\n- ".join(errors)
                st_object.error(f"⚠️ **Estimation Failures:**\n\n{error_message}")
    elif st_object.session_state.get("cost_estimation_report") is False:
        st_object.warning("Cost Estimation generation failed or was skipped.")
    else:
        st_object.info("Cost Estimation not available.")
    st_object.markdown("---")

    # Display Security Assessment
    if st_object.session_state.get("security_assessment"):
        st_object.subheader("Security Assessment")
        if "error" in st_object.session_state.security_assessment:
            st_object.error(f"Could not generate security assessment: {st_object.session_state.security_assessment['error']}")
        else:
            with st_object.expander("View/Hide Security Assessment"):
                st_object.markdown(st_object.session_state.security_assessment.get("assessment_details", "No details available."))
    st_object.markdown("---")

    # --- Next Step Navigation ---
    st_object.subheader("Next Step: Code Generation")
    st_object.markdown("Once you have reviewed the analysis and reports, you can proceed to generate the deployable Terraform code.")
    if st_object.button("🚀 Proceed to Terraform Generation"):
        st_object.session_state.current_stage = "terraform_generation"
        logger.info("Moving from final_report to terraform_generation stage (from ui_stages).")
        st_object.rerun()

def render_terraform_generation_stage(st_object):
    """
    Placeholder for the Terraform code generation UI.
    """
    st_object.header("Phase 2: Terraform Generation")
    
    # This part assumes the terraform code is stored in session_state
    # after being generated in a previous step (which we'll need to add
    # to the main app logic).
    terraform_code = st_object.session_state.get("terraform_code")
    
    if terraform_code:
        st_object.subheader("Generated Terraform Code")
        st_object.code(terraform_code, language="hcl")
    else:
        st_object.warning("Terraform code not found in session. This stage may have been entered prematurely.")
        logger.warning("render_terraform_generation_stage entered without terraform_code in session state.")
        # We don't stop here, because the user might have landed here from a different flow
        # or we might be debugging the deployment part.

    st.markdown("---")

    # This is where we integrate the new UI component
    render_github_deployment_stage() 