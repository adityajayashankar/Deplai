import json
import openai 
import time
import threading
import traceback
import pika
import os # Added for getenv
import re # Added for regex matching

# Import config for RabbitMQ details and API Key
from config import MQ_HOST, MQ_PORT, MQ_USERNAME, MQ_PASSWORD, OPENAI_API_KEY
from logger import setup_logger # Import the custom logger

# Initialize logger for this module
logger = setup_logger(name="ArchJsonGen")

# OpenAI API configuration
if OPENAI_API_KEY:
    client = openai.OpenAI(api_key=OPENAI_API_KEY)
    logger.info(f"OpenAI client initialized in architecture_JsonGen.py")
else:
    logger.error(f"Error: OPENAI_API_KEY not found in environment variables for architecture_JsonGen.py.")
    client = None

# RabbitMQ Constants for this service
REQUEST_QUEUE_NAME = 'architectureJsonRequestQueue'
REQUEST_ROUTING_KEY = 'architectureJsonRequestKey'
EXCHANGE_NAME = 'direct_exchange' # Using the direct exchange

# Threading event for graceful shutdown
stop_event = threading.Event()
# TEST COMMENT

def json_gen(prompt_text):
    """Calls OpenAI API to generate architecture JSON for a specified cloud provider."""
    if not client:
        logger.error(f"Error: OpenAI client not initialized in json_gen.")
        return {"error": "OpenAI client not initialized."}
    try:
        # Determine provider from prompt, default to AWS
        provider_match = re.search(r"Provider:\s*(\w+)", prompt_text, re.IGNORECASE)
        provider = provider_match.group(1).upper() if provider_match else "AWS"
        logger.info(f"Determined provider from prompt: {provider}")

        system_prompt_content = ""
        if provider == "AZURE":
            system_prompt_content = """You are an Azure architecture expert. Generate a detailed Azure architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
For the `type` field in each node, use specific Azure service names that can be mapped for cost estimation.
Ensure the attributes for each node contain enough detail for cost estimation. For example, VMs need `instanceType`, `operatingSystem`, `termType`, `storageGB`, and `volumeType`. Storage needs `storageGB`, `storageClass`, `redundancy`, etc.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "Azure_Architecture_Example",
    "nodes": [
        {
          "id": "webAppServer",
          "type": "VirtualMachines",
          "label": "Web Server",
          "region": "eastus",
          "category": "General Purpose",
          "instance": "D2_v3",
          "attributes": {
            "vmSize": "Standard_D2_v3",
            "operatingSystem": "Windows",
            "tier": "Standard",
            "billingOption": "PayAsYouGo",
            "hoursPerMonth": 730,
            "numberOfInstances": 1,
            "osDiskSizeGB": 15,
            "osDiskType": "StandardSSD_LRS"
          }
        },
        {
          "id": "functionApp",
          "type": "AzureFunctions",
          "label": "Function App",
          "region": "eastus",
          "attributes": {
            "plan": "Consumption",
            "monthlyExecutions": 3000000,
            "executionTimeMs": 400,
            "memorySizeMB": 128
          }
        },
        {
          "id": "blobStorage",
          "type": "BlobStorage",
          "label": "Blob Storage",
          "region": "eastus",
          "attributes": {
            "storageGB": 500,
            "accessTier": "Cool",
            "redundancy": "LRS",
            "monthlyWriteOperations": 10000,
            "monthlyReadOperations": 50000,
            "monthlyListCreateContainerOperations": 10,
            "monthlyDataRetrievalGB": 10
          }
        },
        {
          "id": "virtualNetwork",
          "type": "VirtualNetwork",
          "label": "Virtual Network",
          "region": "eastus",
          "attributes": {
            "outboundDataGB": 100,
            "staticPublicIPs": 1,
            "hoursPerMonth": 730
          }
        },
        {
          "id": "sqlDatabase",
          "type": "SQLDatabase",
          "label": "SQL Database",
          "region": "eastus",
          "attributes": {
            "serviceTier": "Standard",
            "performanceLevel": "S0",
            "storageGB": 250
          }
        },
        {
          "id": "staticWebApp",
          "type": "StaticWebApps",
          "label": "Static Web App",
          "region": "eastus",
          "attributes": {
            "tier": "Standard",
            "bandwidthGB": 100,
            "storageGB": 100,
            "numberOfApps": 1
          }
        }
    ],
    "edges": [
        { "from": "webAppServer", "to": "functionApp" },
        { "from": "webAppServer", "to": "blobStorage" },
        { "from": "webAppServer", "to": "virtualNetwork" },
        { "from": "webAppServer", "to": "sqlDatabase" }
    ]
}

Provide only the JSON object as the response."""
        elif provider == "GCP":
            system_prompt_content = """You are a Google Cloud Platform (GCP) architecture expert. Generate a detailed GCP architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
For the `type` field in each node, use specific GCP service names (e.g., 'GCE', 'GCS', 'CloudSQL', 'CloudFunctions', 'VPC').
Ensure attributes provide details for cost estimation, like `instanceType` for compute and `storageClass` for storage.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "GCP_Architecture_Example",
    "nodes": [
        {
            "id": "webInstance",
            "type": "GCE",
            "label": "Web Server Instance",
            "region": "us-central1",
            "attributes": {
                "instanceType": "e2-medium",
                "operatingSystem": "Debian",
                "termType": "OnDemand",
                "storageGB": 20,
                "volumeType": "pd-standard"
            }
        },
        {
            "id": "sqlDatabase",
            "type": "CloudSQL",
            "label": "Cloud SQL DB",
            "region": "us-central1",
            "attributes": {
                "instanceType": "db-n1-standard-1",
                "databaseEngine": "PostgreSQL",
                "termType": "OnDemand",
                "storageGB": 100
            }
        },
        {
            "id": "fileStorage",
            "type": "GCS",
            "label": "Cloud Storage Bucket",
            "region": "us-central1",
            "attributes": {
                "storageGB": 500,
                "storageClass": "Standard",
                "numWriteOperations": 10000,
                "numReadOperations": 50000
            }
        }
    ],
    "edges": [
        { "from": "webInstance", "to": "sqlDatabase" },
        { "from": "webInstance", "to": "fileStorage" }
    ]
}

Provide only the JSON object as the response."""
        else:  # Default to AWS
            system_prompt_content = """You are an AWS architecture expert. Generate a detailed AWS architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
For the `type` field in each node, use specific AWS service names compatible with the Python `diagrams` library AND for cost estimation (e.g., `AmazonEC2`, `AmazonRDS`, `AmazonS3`, `AmazonVPC`, `AmazonSubnet`, `ELB`, `AutoScaling`, `AmazonCloudFront`, `AWSLambda`, `AWSIAM`).
Ensure the attributes for each node contain enough detail for cost estimation. For example, EC2 needs `instanceType`, `operatingSystem`, `tenancy`, `termType`, and `storageGB`. S3 needs `storageGB`, `storageClass`, `numPUTRequests`, etc.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "Cost_Estimation_Ready_Architecture",
    "nodes": [
        {
            "id": "webAppServer",
            "type": "AmazonEC2",
            "label": "Web Server",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "instanceType": "t3.micro",
                "operatingSystem": "Linux",
                "tenancy": "Shared",
                "capacitystatus": "Used",
                "preInstalledSw": "NA",
                "termType": "OnDemand",
                "storageGB": 15,
                "volumeType": "gp3"
            }
        },
        {
            "id": "database",
            "type": "AmazonRDS",
            "label": "RDS Database",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "instanceType": "db.t3.micro",
                "databaseEngine": "PostgreSQL",
                "termType": "OnDemand",
                "storageGB": 100,
                "storageType": "gp3"
            }
        },
        {
            "id": "storageBucket",
            "type": "AmazonS3",
            "label": "S3 Bucket",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "storageGB": 100,
                "storageClass": "Standard",
                "numPUTRequests": 10000,
                "numGETRequests": 50000
            }
        }
    ],
    "edges": [
        { "from": "webAppServer", "to": "database" },
        { "from": "webAppServer", "to": "storageBucket" }
    ]
}

Provide only the JSON object as the response."""

        logger.info(f"Attempting to generate JSON for {provider} with prompt: {prompt_text[:150]}...")
        
        response = client.chat.completions.create(
            model="gpt-4.1",
            messages=[
                {"role": "system", "content": system_prompt_content},
                {"role": "user", "content": prompt_text}
            ],
            response_format={"type": "json_object"}
        )
        generated_content = response.choices[0].message.content
        logger.info(f"Successfully received response from OpenAI.")
        
        architecture_data = json.loads(generated_content)
        logger.info(f"Successfully parsed architecture JSON from OpenAI response.")
        return {"architecture_json": architecture_data}

    except json.JSONDecodeError as e:
        logger.error(f"JSONDecodeError in json_gen: {e}. Response from OpenAI was: {generated_content if 'generated_content' in locals() else 'N/A'}", exc_info=True)
        return {"error": f"Failed to parse JSON from OpenAI: {e}", "raw_response": generated_content if 'generated_content' in locals() else 'N/A'}
    except openai.APIError as e: 
        logger.error(f"OpenAI API Error in json_gen: {e.status_code} - {e.message}", exc_info=True)
        return {"error": f"OpenAI API Error: {e.message} (Status: {e.status_code})"}
    except Exception as e:
        logger.error(f"Unexpected error in json_gen: {e}", exc_info=True)
        return {"error": f"An unexpected error occurred during JSON generation: {str(e)}"}

def process_message(channel, method, properties, body):
    """Processes each message from RabbitMQ queue, gets JSON, and replies to reply_to queue."""
    try:
        logger.info(f"Received message with delivery tag {method.delivery_tag}, reply_to: {properties.reply_to}, correlation_id: {properties.correlation_id}")
        message_data = json.loads(body.decode("utf-8"))
        prompt = message_data.get("prompt")
        
        reply_to = properties.reply_to
        correlation_id = properties.correlation_id

        if not prompt:
            logger.error(f"Error: No prompt provided in message.")
            response_payload = {"error": "No prompt provided in the message."}
        elif not reply_to or not correlation_id:
            logger.error(f"Error: Missing reply_to or correlation_id in message properties for delivery tag {method.delivery_tag}.")
            # Acknowledge the message to remove it from the queue as it cannot be processed.
            channel.basic_ack(delivery_tag=method.delivery_tag)
            return 
        else:
            response_payload = json_gen(prompt)
        
        if channel.is_open and reply_to: 
            channel.basic_publish(
                exchange='', # Default exchange for reply_to
                routing_key=reply_to,
                properties=pika.BasicProperties(
                    correlation_id=correlation_id,
                    content_type='application/json',
                    delivery_mode=2 # Persistent
                ),
                body=json.dumps(response_payload)
            )
            logger.info(f"Sent response to {reply_to} with correlation ID {correlation_id}")
        else:
            logger.error(f"Could not send reply: Channel closed or reply_to missing. Reply_to: {reply_to} for delivery_tag {method.delivery_tag}")

        channel.basic_ack(delivery_tag=method.delivery_tag)
        logger.info(f"Acknowledged message {method.delivery_tag}")

    except json.JSONDecodeError as e_json_decode:
        logger.error(f"Error decoding incoming message body (delivery_tag {method.delivery_tag}): {e_json_decode}", exc_info=True)
        if channel.is_open:
            channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False) 
    except Exception as e:
        logger.error(f"Error processing message (delivery_tag {method.delivery_tag}) in architecture_JsonGen: {e}", exc_info=True)
        # Acknowledge the message even in case of an unexpected error during processing 
        # to prevent it from being re-queued indefinitely if it's a "poison pill".
        if channel.is_open:
            channel.basic_ack(delivery_tag=method.delivery_tag)

def consume_json_requests():
    """Connects to RabbitMQ, consumes messages, processes them, and sends back a response."""
    
    connection = None
    max_retries = 10
    retry_delay = 5

    for attempt in range(max_retries):
        if stop_event.is_set():
            return
        try:
            logger.info(f"ArchitectureJsonGen: Attempting to connect to RabbitMQ at '{MQ_HOST}'... (Attempt {attempt + 1}/{max_retries})")
            credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
            parameters = pika.ConnectionParameters(
                host=MQ_HOST, 
                port=MQ_PORT, 
                credentials=credentials,
                heartbeat=600, 
                blocked_connection_timeout=300
            )
            connection = pika.BlockingConnection(parameters)
            logger.info("ArchitectureJsonGen: Connected to RabbitMQ.")
            break  # Exit loop on successful connection
        except pika.exceptions.AMQPConnectionError as e:
            logger.warning(f"ArchitectureJsonGen: RabbitMQ Connection Error: {e}. Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)
        except Exception as e:
            logger.error(f"ArchitectureJsonGen: Unexpected error during connection: {e}. Retrying in {retry_delay} seconds...", exc_info=True)
            time.sleep(retry_delay)

    if not connection or not connection.is_open:
        logger.error("ArchitectureJsonGen: Could not connect to RabbitMQ after several retries. Worker is stopping.")
        return

    try:
        channel = connection.channel()
        channel.exchange_declare(exchange=EXCHANGE_NAME, exchange_type='direct', durable=True)
        
        # Declare the queue, bind it, and set up the consumer
        channel.queue_declare(queue=REQUEST_QUEUE_NAME, durable=True)
        channel.queue_bind(exchange=EXCHANGE_NAME, queue=REQUEST_QUEUE_NAME, routing_key=REQUEST_ROUTING_KEY)
        logger.info(f"ArchitectureJsonGen: Declared exchange '{EXCHANGE_NAME}', queue '{REQUEST_QUEUE_NAME}', bound with key '{REQUEST_ROUTING_KEY}'")

        channel.basic_qos(prefetch_count=1)
        
        # The on_message_callback is called by pika with 4 arguments: channel, method, properties, body.
        # We pass process_message directly to basic_consume.
        channel.basic_consume(queue=REQUEST_QUEUE_NAME, on_message_callback=process_message)

        logger.info(f"ArchitectureJsonGen: Waiting for messages on {REQUEST_QUEUE_NAME}. To exit set stop_event.")
        
        # Main consuming loop
        while not stop_event.is_set() and channel.is_open:
            try:
                connection.process_data_events(time_limit=1)
            except pika.exceptions.StreamLostError:
                logger.error("ArchitectureJsonGen: Connection lost. Attempting to reconnect...")
                # The outer loop will handle the reconnection logic.
                break 
            
    except Exception as e:
        logger.error(f"ArchitectureJsonGen: An unhandled exception occurred in consume_json_requests: {e}", exc_info=True)
    finally:
        if connection and connection.is_open:
            logger.info("ArchitectureJsonGen: Closing RabbitMQ connection.")
            connection.close()
        logger.info("ArchitectureJsonGen: Consumer has stopped.")

def stop_consuming():
    """Signals the consumer loop to stop."""
    logger.info(f"ArchitectureJsonGen: stop_consuming() called. Setting stop_event.")
    stop_event.set()

if __name__ == '__main__':
    logger.info(f"Starting Architecture JSON Generation service (standalone mode)...")
    from dotenv import load_dotenv
    load_dotenv() # Load .env file for standalone execution

    # Ensure OPENAI_API_KEY is available for the client
    # This re-checks environment or .env specifically for standalone run
    current_api_key = os.getenv('OPENAI_API_KEY')
    if not OPENAI_API_KEY and current_api_key: # If global was not set but .env has it
        logger.info(f"Re-initializing OpenAI client with key from .env for standalone run.")
        client = openai.OpenAI(api_key=current_api_key)
    elif not client and not current_api_key : # Neither global nor .env has it
        logger.critical(f"FATAL: OpenAI client could not be initialized. Ensure OPENAI_API_KEY is set in .env file.")
        exit(1) # Exit if no key, client cannot function
    elif not client and OPENAI_API_KEY: # If global was somehow set but client not init
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        logger.info(f"OpenAI client initialized (late) for standalone run.")

    if not client:
        logger.error(f"ERROR: OpenAI client is not initialized. Cannot start service.")
    else:
        try:
            consume_json_requests()
        except KeyboardInterrupt:
            logger.info(f"Architecture JSON Generation service interrupted by user (Ctrl+C).")
        finally:
            logger.info(f"Shutting down Architecture JSON Generation service...")
            stop_consuming() # Ensure stop_event is set for graceful exit
            # Potentially add a join for a thread if consume_json_requests was run in a thread here.
            # For now, it's a direct call, so stop_event should allow the loop to terminate.
            logger.info(f"Architecture JSON Generation service shut down complete.")
