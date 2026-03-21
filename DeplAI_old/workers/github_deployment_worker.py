import sys
import os
import pika
import json
import logging
import zipfile
import shutil
import time

# Add the project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from terraform_rag_agent.src.agent.tools.github_deployer import GithubDeployerTool
from logger import setup_logger

# Setup logger
logger = setup_logger(name="GithubDeploymentWorker")

def unzip_s3_package_if_exists(directory: str):
    """
    Checks for 's3_website_package.zip' in a directory, unzips it, and cleans up.
    """
    package_path = os.path.join(directory, 's3_website_package.zip')
    if os.path.exists(package_path):
        logger.info(f"Found S3 website package at '{package_path}'. Unzipping for deployment.")
        try:
            # Unzip the contents
            with zipfile.ZipFile(package_path, 'r') as zip_ref:
                zip_ref.extractall(directory)
            
            # Delete the zip file after extraction
            os.remove(package_path)
            logger.info(f"Successfully unzipped and removed '{package_path}'.")
            
            # Log the contents to be sure
            logger.info(f"Final contents of '{directory}': {os.listdir(directory)}")

        except Exception as e:
            logger.error(f"Failed to unzip S3 website package: {e}", exc_info=True)
            # Depending on requirements, you might want to re-raise or handle this error
            raise

def get_rabbitmq_connection():
    """Establishes a connection to RabbitMQ with retries."""
    mq_host = os.getenv("MQ_HOST", "localhost")
    max_retries = 10
    retry_delay = 5  # seconds

    for attempt in range(max_retries):
        try:
            logger.info(f"Attempting to connect to RabbitMQ at '{mq_host}'... (Attempt {attempt + 1}/{max_retries})")
            connection = pika.BlockingConnection(pika.ConnectionParameters(host=mq_host))
            logger.info("Successfully connected to RabbitMQ.")
            return connection
        except pika.exceptions.AMQPConnectionError as e:
            logger.warning(f"Failed to connect to RabbitMQ: {e}. Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)
    
    logger.error("Could not connect to RabbitMQ after several retries. Exiting.")
    return None

def on_request(ch, method, props, body):
    """Callback function to process a deployment request."""
    try:
        data = json.loads(body)
        correlation_id = props.correlation_id
        reply_to = props.reply_to

        logger.info(f"Received deployment request with correlation ID: {correlation_id}")
        logger.debug(f"Request data: {data}")

        # Extract data from the payload
        project_name = data.get("project_name")
        output_directory = data.get("output_directory")
        
        # --- CRITICAL DIAGNOSTIC LOG ---
        logger.info(f"GITHUB_DEPLOYMENT_WORKER: Received output directory path: '{output_directory}'")
        if output_directory and os.path.exists(output_directory):
            logger.info(f"GITHUB_DEPLOYMENT_WORKER: Directory exists. Contents: {os.listdir(output_directory)}")
        else:
            logger.error(f"GITHUB_DEPLOYMENT_WORKER: Directory does not exist or path is empty!")
        # --- END DIAGNOSTIC LOG ---

        # Unzip the S3 website package if it exists before deployment
        unzip_s3_package_if_exists(output_directory)

        cloud_provider = data.get("cloud_provider")
        github_token = data.get("github_token")

        # Extract provider-specific credentials
        aws_access_key_id = data.get("aws_access_key_id")
        aws_secret_access_key = data.get("aws_secret_access_key")
        azure_client_id = data.get("azure_client_id")
        azure_tenant_id = data.get("azure_tenant_id")
        azure_subscription_id = data.get("azure_subscription_id")
        gcp_credentials_json = data.get("gcp_credentials_json")

        if not all([project_name, output_directory, cloud_provider, github_token]):
            raise ValueError("Missing required fields in the deployment request.")

        # Instantiate and run the tool
        deployer_tool = GithubDeployerTool()
        result_message = deployer_tool._run(
            project_name=project_name,
            output_directory=output_directory,
            cloud_provider=cloud_provider,
            github_token=github_token,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            azure_client_id=azure_client_id,
            azure_tenant_id=azure_tenant_id,
            azure_subscription_id=azure_subscription_id,
            gcp_credentials_json=gcp_credentials_json
        )
        
        response = {"status": "success", "message": result_message}
        logger.info(f"Deployment successful for {correlation_id}: {result_message}")

    except Exception as e:
        logger.error(f"Error processing deployment request for {correlation_id}: {e}", exc_info=True)
        response = {"status": "error", "message": str(e)}

    # Publish the response back to the reply_to queue
    ch.basic_publish(
        exchange='',
        routing_key=reply_to,
        properties=pika.BasicProperties(correlation_id=correlation_id),
        body=json.dumps(response)
    )
    ch.basic_ack(delivery_tag=method.delivery_tag)
    logger.info(f"Sent response for correlation ID: {correlation_id}")

def main():
    """Main function to start the worker."""
    connection = get_rabbitmq_connection()
    if not connection:
        return

    channel = connection.channel()
    
    # Declare the queue for receiving deployment requests
    queue_name = "deploymentRequestQueue"
    channel.queue_declare(queue=queue_name, durable=True)
    
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue=queue_name, on_message_callback=on_request)

    logger.info(f"[*] Waiting for deployment requests on queue '{queue_name}'. To exit press CTRL+C")
    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        logger.info("Stopping worker.")
        channel.stop_consuming()
    finally:
        connection.close()
        logger.info("RabbitMQ connection closed.")

if __name__ == '__main__':
    main() 