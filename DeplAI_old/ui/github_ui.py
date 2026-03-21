import streamlit as st
import logging
import uuid

logger = logging.getLogger(__name__)

def render_github_deployment_stage(st_object, publish_to_rabbitmq_func, consume_from_reply_queue_func, get_rabbitmq_channel_func):
    """
    Renders the UI for the GitOps deployment phase, allowing the user
    to input credentials and trigger the deployment.
    """
    st.header("Phase 3: Automated GitOps Deployment")
    st.info("The agent has successfully generated the Terraform code. To proceed, please provide the necessary credentials to create a GitHub repository and set up the deployment pipeline.")
    
    cloud_provider = st.session_state.project_details.get("provider", "aws").lower()

    with st.form("deployment_credentials_form"):
        st.subheader("GitHub Credentials")
        github_token = st.text_input(
            "GitHub Personal Access Token (PAT)",
            type="password",
            help="Requires `repo` and `workflow` scopes. This token will be used to create the repository and will not be stored."
        )

        # --- Dynamic Credential Inputs ---
        aws_access_key_id, aws_secret_access_key = None, None
        azure_client_id, azure_tenant_id, azure_subscription_id = None, None, None
        gcp_credentials_json = None

        if cloud_provider == "aws":
            st.subheader("AWS Credentials for CI/CD")
            st.write("These credentials will be stored as secrets in the GitHub repository to allow the CI/CD pipeline to deploy your infrastructure.")
            aws_access_key_id = st.text_input("AWS Access Key ID", type="password")
            aws_secret_access_key = st.text_input("AWS Secret Access Key", type="password")
        
        elif cloud_provider == "azure":
            st.subheader("Azure Credentials for CI/CD")
            st.write("These credentials will be stored as secrets in the GitHub repository to allow the CI/CD pipeline to deploy your infrastructure.")
            azure_client_id = st.text_input("Azure Client ID", type="password")
            azure_tenant_id = st.text_input("Azure Tenant ID", type="password")
            azure_subscription_id = st.text_input("Azure Subscription ID", type="password")

        elif cloud_provider == "gcp":
            st.subheader("GCP Credentials for CI/CD")
            st.write("These credentials will be stored as secrets in the GitHub repository to allow the CI/CD pipeline to deploy your infrastructure.")
            gcp_credentials_json = st.text_area(
                "GCP Service Account JSON",
                height=300,
                help="Paste the entire content of your GCP service account JSON key file here."
            )

        submitted = st.form_submit_button("🚀 Deploy to GitHub")

        if submitted:
            # --- Input Validation ---
            credentials_valid = False
            if cloud_provider == "aws" and all([github_token, aws_access_key_id, aws_secret_access_key]):
                credentials_valid = True
            elif cloud_provider == "azure" and all([github_token, azure_client_id, azure_tenant_id, azure_subscription_id]):
                credentials_valid = True
            elif cloud_provider == "gcp" and all([github_token, gcp_credentials_json]):
                credentials_valid = True
            
            if not credentials_valid:
                st.error("All fields are required. Please provide all credentials.")
            else:
                st.success("Credentials received. Triggering deployment...")
                logger.info("Deployment form submitted. Triggering backend process...")
                
                with st.spinner("🚀 Contacting deployment worker... This may take a moment."):
                    channel = get_rabbitmq_channel_func()
                    if not channel:
                        st.error("Failed to connect to the backend service. Please check the system status.")
                        return

                    correlation_id = str(uuid.uuid4())
                    reply_q_obj = channel.queue_declare(queue='', exclusive=True, auto_delete=True)
                    reply_q_name = reply_q_obj.method.queue

                    # Construct the payload for the deployment worker
                    payload = {
                        "project_name": st.session_state.project_details.get("title", "Untitled DeplAI Project"),
                        "output_directory": st.session_state.current_project_output_dir,
                        "cloud_provider": cloud_provider,
                        "github_token": github_token,
                    }

                    # Add provider-specific credentials to the payload
                    if cloud_provider == "aws":
                        payload.update({
                            "aws_access_key_id": aws_access_key_id,
                            "aws_secret_access_key": aws_secret_access_key
                        })
                    elif cloud_provider == "azure":
                        payload.update({
                            "azure_client_id": azure_client_id,
                            "azure_tenant_id": azure_tenant_id,
                            "azure_subscription_id": azure_subscription_id
                        })
                    elif cloud_provider == "gcp":
                        payload.update({"gcp_credentials_json": gcp_credentials_json})

                    # Publish the request
                    publish_to_rabbitmq_func(
                        queue_name="deploymentRequestQueue",
                        routing_key="deploymentRequestQueue", # Routing key must match queue name for default exchange
                        exchange_name="", # Use the default exchange
                        payload=payload,
                        reply_to=reply_q_name,
                        correlation_id=correlation_id
                    )

                    # Wait for the response
                    response = consume_from_reply_queue_func(reply_q_name, correlation_id, timeout_seconds=300)

                # Process the response
                if response and response.get("status") == "success":
                    st.success(f"✅ Deployment pipeline configured successfully!")
                    st.markdown(response.get("message", "No message provided."))
                elif response:
                    st.error(f"❌ Deployment failed: {response.get('message', 'No error details provided.')}")
                else:
                    st.error("❌ No response from the deployment worker. The process may have timed out or failed.") 