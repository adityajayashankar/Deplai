from pydantic import BaseModel
import pika
import sys
import os
import threading
import json
from fastapi import FastAPI

from architecture_JsonGen import consume_json_requests, stop_consuming as stop_arch_json_consuming
from diagram_gen import DiagramGen  
import time
import traceback
from aws_cost_estimation import (
    create_pricing_client,
    get_rds_cost_estimate,
    get_ec2_cost_estimate,
    get_lambda_cost_estimate,
    get_s3_cost_estimate,
    get_aws_cost_estimation
)
# --- Azure Cost Estimation Imports ---
from azure_cost_estimation import (
    get_vm_cost as get_azure_vm_cost,
    get_function_cost as get_azure_function_cost,
    get_blob_storage_cost as get_azure_blob_storage_cost,
    get_virtual_network_cost as get_azure_vnet_cost,
    get_sql_database_cost as get_azure_sql_db_cost,
    get_azure_cost_estimation
)
import signal # For signal handling

from logger import setup_logger # Import custom logger

# --- Configuration ---
COST_INPUT_QUEUE = "costEstimationRequestQueue"
COST_OUTPUT_QUEUE = "costResultQueue"
DIAGRAM_INPUT_QUEUE = "diagramRequestQueue"
MAIN_EXCHANGE = "direct_exchange"

# Configuration for RabbitMQ connection (should be imported from config.py)
from config import MQ_HOST, MQ_PORT, MQ_USERNAME, MQ_PASSWORD

# --- Logging Setup ---
# logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s')
# logger = logging.getLogger(__name__) # Replace with custom logger
logger = setup_logger(name="MainService")

# List to keep track of service threads for graceful shutdown
service_threads = []
services_to_stop = [] # List to keep track of service objects with stop methods

class CostEstimatorService:
    def __init__(self):
        self.connection = None
        self.mq_channel = None
        self._consuming_event = threading.Event() # Use an event for clearer stop signal
        self.logger = setup_logger(name="MainService.CostEstimator") # Specific logger for this class

    def connect_rabbitmq(self):
        max_retries = 10
        retry_delay = 5
        for attempt in range(max_retries):
            if self._consuming_event.is_set():
                return False
            try:
                self.logger.info(f"[CostEstimatorService] Attempting to connect to RabbitMQ at '{MQ_HOST}'... (Attempt {attempt + 1}/{max_retries})")
                credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
                parameters = pika.ConnectionParameters(
                    host=MQ_HOST, port=MQ_PORT, credentials=credentials,
                    heartbeat=1800, blocked_connection_timeout=300
                )
                self.connection = pika.BlockingConnection(parameters)
                self.mq_channel = self.connection.channel()
                self.logger.info(f"[CostEstimatorService] RabbitMQ Connection Established Successfully.")
                
                self.mq_channel.exchange_declare(exchange=MAIN_EXCHANGE, exchange_type='direct', durable=True)
                
                self.mq_channel.queue_declare(queue=COST_INPUT_QUEUE, durable=True)
                self.mq_channel.queue_bind(exchange=MAIN_EXCHANGE, queue=COST_INPUT_QUEUE, routing_key="costEstimationRequestKey")
                self.logger.info(f"[CostEstimatorService] Declared and bound queue: {COST_INPUT_QUEUE} with key costEstimationRequestKey")
                return True
            except pika.exceptions.AMQPConnectionError as e:
                self.logger.warning(f"[CostEstimatorService] RabbitMQ Connection Error: {e}. Retrying in {retry_delay} seconds...")
            except Exception as e:
                self.logger.error(f"[CostEstimatorService] Unexpected error during RabbitMQ connection: {e}. Retrying in {retry_delay} seconds...", exc_info=True)
            
            time.sleep(retry_delay)
            
        self.logger.error("[CostEstimatorService] Could not connect to RabbitMQ after several retries. Giving up.")
        return False

    def message_handler(self, ch, method, properties, body):
        self.logger.info(f"[CostEstimatorService] Received message on {COST_INPUT_QUEUE}. Reply_to: {properties.reply_to}, Corr_ID: {properties.correlation_id}")
        try:
            message_data = json.loads(body.decode())
            provider = message_data.get("provider")
            architecture_json = message_data.get("architecture_json") 

            if not provider:
                self.logger.error(f"[CostEstimatorService] 'provider' key missing in message payload.")
                response_payload = {"error": "'provider' key missing in message payload."}
            elif not architecture_json:
                self.logger.error(f"[CostEstimatorService] 'architecture_json' key missing in message payload.")
                response_payload = {"error": "'architecture_json' key missing in message payload."}
            else:
                self.logger.info(f"[CostEstimatorService] Incoming request for provider '{provider}': %s", json.dumps(architecture_json, indent=2))
                
                # --- Provider-Specific Logic ---
                if provider.lower() == "aws":
                    # Use the single, consolidated cost estimation function
                    cost_result = get_aws_cost_estimation(architecture_json)
                    
                    response_payload = {
                        "cost_report": {
                            "architecture_title": architecture_json.get("title", "Untitled Architecture"),
                            "provider": provider,
                            "service_breakdown": cost_result.get("cost_breakdown", {}),
                            "overall_total_monthly_usd": cost_result.get("total_monthly_cost", 0.0),
                            "notes": cost_result.get("notes", ""), # Pass the notes to the UI
                            "errors": cost_result.get("errors", []) # Pass the errors to the UI
                        }
                    }

                elif provider.lower() == "azure":
                    # Use the single, consolidated cost estimation function for Azure
                    cost_result = get_azure_cost_estimation(architecture_json)
                    
                    response_payload = {
                        "cost_report": {
                            "architecture_title": architecture_json.get("title", "Untitled Architecture"),
                            "provider": provider,
                            "service_breakdown": cost_result.get("cost_breakdown", {}),
                            "overall_total_monthly_usd": cost_result.get("total_monthly_cost", 0.0),
                            "notes": cost_result.get("notes", ""),
                            "errors": cost_result.get("errors", [])
                        }
                    }
                
                else:
                    self.logger.error(f"Unsupported provider '{provider}' for cost estimation.")
                    response_payload = {"error": f"Unsupported provider '{provider}' for cost estimation."}
                    # This short-circuits the normal response path
                    ch.basic_publish(
                        exchange='', routing_key=properties.reply_to, body=json.dumps(response_payload),
                        properties=pika.BasicProperties(correlation_id=properties.correlation_id)
                    )
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                    return

            self.logger.info(f"[CostEstimatorService] Calculated Costs: {json.dumps(response_payload, indent=2)}")

            # Publish to the reply_to queue specified by the client
            if properties.reply_to and self.mq_channel and self.mq_channel.is_open:
                self.mq_channel.basic_publish(
                    exchange='', # Default exchange for direct-to-queue
                    routing_key=properties.reply_to,
                    body=json.dumps(response_payload),
                    properties=pika.BasicProperties(
                        correlation_id = properties.correlation_id,
                        delivery_mode=2, 
                        content_type='application/json'
                    )
                )
                self.logger.info(f"[CostEstimatorService] Published cost report to {properties.reply_to}")
            elif not properties.reply_to:
                self.logger.error(f"[CostEstimatorService] Cannot publish cost report. reply_to property missing.")
            else:
                self.logger.error(f"[CostEstimatorService] Cannot publish cost report. MQ channel is closed.")
            
            ch.basic_ack(delivery_tag=method.delivery_tag)

        except json.JSONDecodeError as e:
            self.logger.error(f"[CostEstimatorService] Error decoding JSON: {e}", exc_info=True)
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
        except Exception as e:
            self.logger.error(f"[CostEstimatorService] Unexpected error in message_handler: {e}", exc_info=True)
            # Requeue message if it's a transient error, otherwise nack without requeue
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False) # Changed to False to avoid potential poison messages

    def start_consuming(self):
        self._consuming_event.clear() # Ensure event is clear before starting
        if not self.connect_rabbitmq():
            self.logger.error(f"[CostEstimatorService] Failed to connect to RabbitMQ. Aborting consumption start.")
            return

        self.logger.info(f"[CostEstimatorService] Waiting for messages on {COST_INPUT_QUEUE}. To exit set stop event.")
        self.mq_channel.basic_qos(prefetch_count=1)
        self.mq_channel.basic_consume(queue=COST_INPUT_QUEUE, on_message_callback=self.message_handler)

        try:
            while not self._consuming_event.is_set() and self.mq_channel and self.mq_channel.is_open:
                self.connection.process_data_events(time_limit=1)
        except KeyboardInterrupt:
            self.logger.info(f"[CostEstimatorService] Keyboard Interrupt detected. Stopping consumer...")
        except pika.exceptions.StreamLostError as e:
            self.logger.error(f"[CostEstimatorService] StreamLostError: {e}. Attempting to reconnect and resume...", exc_info=True)
            self.mq_channel = None 
            # Loop will attempt to reconnect via connect_rabbitmq() if _consuming_event is not set
        except Exception as e:
            self.logger.error(f"[CostEstimatorService] Unexpected error in consuming loop: {e}", exc_info=True)
        finally:
            self.stop_consuming() # Ensure cleanup happens
        self.logger.info(f"[CostEstimatorService] Consumption loop finished.")

    def stop_consuming(self):
        self.logger.info(f"[CostEstimatorService] Stopping consumer...")
        self._consuming_event.set()
        if self.mq_channel and self.mq_channel.is_open:
            try: self.mq_channel.stop_consuming() # Gracefully stop the consumer callback
            except Exception as e: self.logger.warning(f"[CostEstimatorService] Error during channel.stop_consuming: {e}", exc_info=True)
            try: self.mq_channel.close()
            except Exception as e: self.logger.warning(f"[CostEstimatorService] Error closing channel: {e}", exc_info=True)
        if self.connection and self.connection.is_open:
            try: self.connection.close()
            except Exception as e: self.logger.warning(f"[CostEstimatorService] Error closing connection: {e}", exc_info=True)
        self.logger.info(f"[CostEstimatorService] Consumer stopped.")

    def stop(self):
        """Compatibility method for shared graceful shutdown logic."""
        self.stop_consuming()

class DiagramServiceWrapper:
    def __init__(self):
        self.connection = None
        self.mq_channel = None
        self._stop_event = threading.Event()
        self.logger = setup_logger(name="MainService.DiagramService")
        self.diagram_gen_instance = DiagramGen() # Create an instance of DiagramGen

    def connect_rabbitmq(self):
        max_retries = 10
        retry_delay = 5
        for attempt in range(max_retries):
            if self._stop_event.is_set():
                return False
            try:
                self.logger.info(f"[DiagramService] Attempting to connect to RabbitMQ at '{MQ_HOST}'... (Attempt {attempt + 1}/{max_retries})")
                credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
                parameters = pika.ConnectionParameters(
                    host=MQ_HOST, port=MQ_PORT, credentials=credentials,
                    heartbeat=1800, blocked_connection_timeout=300
                )
                self.connection = pika.BlockingConnection(parameters)
                self.mq_channel = self.connection.channel()
                self.logger.info("[DiagramService] RabbitMQ Connection Established.")
                
                self.mq_channel.exchange_declare(exchange=MAIN_EXCHANGE, exchange_type='direct', durable=True)
                self.mq_channel.queue_declare(queue=DIAGRAM_INPUT_QUEUE, durable=True)
                self.mq_channel.queue_bind(exchange=MAIN_EXCHANGE, queue=DIAGRAM_INPUT_QUEUE, routing_key="diagramRequestKey")
                self.logger.info(f"[DiagramService] Declared and bound queue: {DIAGRAM_INPUT_QUEUE} with key diagramRequestKey")
                return True
            except pika.exceptions.AMQPConnectionError as e:
                self.logger.warning(f"[DiagramService] MQ Connection Error: {e}. Retrying in {retry_delay}s...")
            except Exception as e:
                self.logger.error(f"[DiagramService] Unexpected error during RabbitMQ connection: {e}. Retrying in {retry_delay}s...", exc_info=True)
            
            time.sleep(retry_delay)
            
        self.logger.error("[DiagramService] Could not connect to RabbitMQ after several retries. Giving up.")
        return False

    def message_handler(self, ch, method, properties, body):
        self.logger.info(f"[DiagramService] Received message on {DIAGRAM_INPUT_QUEUE}. Reply_to: {properties.reply_to}, Corr_ID: {properties.correlation_id}")
        response_payload = None
        try:
            message_data = json.loads(body.decode())
            provider = message_data.get("provider")
            architecture_json = message_data.get("architecture_json")
            output_directory = message_data.get("output_directory")
            project_title_for_filename = message_data.get("project_title_for_filename")
            
            if not provider:
                self.logger.error(f"[DiagramService] 'provider' key missing in message.")
                response_payload = {"error": "'provider' key missing in message payload."}
            elif not architecture_json:
                self.logger.error(f"[DiagramService] 'architecture_json' key missing in message.")
                response_payload = {"error": "'architecture_json' key missing in message payload."}
            elif not output_directory:
                self.logger.error(f"[DiagramService] 'output_directory' key missing in message.")
                response_payload = {"error": "'output_directory' key missing in message payload."}
            elif not project_title_for_filename:
                self.logger.error(f"[DiagramService] 'project_title_for_filename' key missing in message.")
                response_payload = {"error": "'project_title_for_filename' key missing in message payload."}
            elif not properties.reply_to or not properties.correlation_id:
                self.logger.error(f"[DiagramService] Missing reply_to or correlation_id. Cannot send response.")
                ch.basic_ack(delivery_tag=method.delivery_tag)
                return
            else:
                self.logger.info(f"[DiagramService] Calling diagram generator with provider: '{provider}', output_dir: '{output_directory}', filename_base: '{project_title_for_filename}'")
                result = self.diagram_gen_instance.generate_diagram_from_json_direct(
                    provider,
                    architecture_json,
                    output_directory=output_directory,
                    project_title_for_filename=project_title_for_filename
                )

                if isinstance(result, str) and os.path.exists(result):
                    self.logger.info(f"[DiagramService] Diagram generated successfully: {result}")
                    response_payload = {"diagram_path": result}
                elif isinstance(result, dict) and "error" in result:
                    self.logger.error(f"[DiagramService] Error from diagram generator: {result.get('error')}")
                    response_payload = result
                else:
                    self.logger.error(f"[DiagramService] Unknown error or invalid response from diagram generator. Result was: {result}")
                    response_payload = {"error": "Unknown error or invalid response from diagram generator."}
            
            if response_payload is None:
                self.logger.error("[DiagramService] Response payload was not set. This indicates an unhandled logic path.")
                response_payload = {"error": "Internal server error: response payload not set."}

            if properties.reply_to and self.mq_channel and self.mq_channel.is_open:
                self.mq_channel.basic_publish(
                    exchange='',
                    routing_key=properties.reply_to,
                    body=json.dumps(response_payload),
                    properties=pika.BasicProperties(
                        correlation_id = properties.correlation_id,
                        delivery_mode=pika.spec.PERSISTENT_DELIVERY_MODE,
                        content_type='application/json'
                    )
                )
                self.logger.info(f"[DiagramService] Sent response to {properties.reply_to}")
            elif not properties.reply_to:
                self.logger.error(f"[DiagramService] Cannot publish response. reply_to property missing (should have been caught earlier).")
            else:
                self.logger.error(f"[DiagramService] Cannot publish response. MQ channel is closed or unavailable.")

            ch.basic_ack(delivery_tag=method.delivery_tag)

        except json.JSONDecodeError as e:
            self.logger.error(f"[DiagramService] Error decoding JSON: {e}", exc_info=True)
            error_response = {"error": f"JSONDecodeError: {str(e)}"}
            if properties.reply_to and properties.correlation_id and self.mq_channel and self.mq_channel.is_open:
                self.mq_channel.basic_publish(exchange='', routing_key=properties.reply_to, body=json.dumps(error_response), properties=pika.BasicProperties(correlation_id=properties.correlation_id, content_type='application/json'))
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
        except Exception as e:
            self.logger.error(f"[DiagramService] Unexpected error in message_handler: {e}", exc_info=True)
            error_response = {"error": f"Unexpected error in diagram service: {str(e)}", "traceback": traceback.format_exc()}
            if properties.reply_to and properties.correlation_id and self.mq_channel and self.mq_channel.is_open:
                self.mq_channel.basic_publish(exchange='', routing_key=properties.reply_to, body=json.dumps(error_response), properties=pika.BasicProperties(correlation_id=properties.correlation_id, content_type='application/json'))
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

    def start(self):
        self._stop_event.clear()
        if not self.connect_rabbitmq():
             self.logger.error(f"[DiagramService] Failed to connect to MQ. Aborting diagram service start.")
             return
        
        self.logger.info(f"[DiagramService] Starting Diagram Generator to listen on {DIAGRAM_INPUT_QUEUE}...")
        self.mq_channel.basic_qos(prefetch_count=1)
        self.mq_channel.basic_consume(queue=DIAGRAM_INPUT_QUEUE, on_message_callback=self.message_handler)

        try:
            while not self._stop_event.is_set() and self.mq_channel and self.mq_channel.is_open:
                self.connection.process_data_events(time_limit=1)
        except KeyboardInterrupt:
            self.logger.info(f"[DiagramService] Keyboard Interrupt. Stopping...")
        except Exception as e:
            self.logger.error(f"[DiagramService] Error in consumption loop: {e}", exc_info=True)
        finally:
            self.stop() # Ensure cleanup
        self.logger.info(f"[DiagramService] Diagram service consumption loop finished.")

    def stop(self):
        self.logger.info(f"[DiagramService] Stopping diagram service...")
        self._stop_event.set()
        if self.mq_channel and self.mq_channel.is_open:
            try: self.mq_channel.stop_consuming()
            except Exception as e: self.logger.warning(f"[DiagramService] Error channel.stop_consuming: {e}", exc_info=True)
            try: self.mq_channel.close()
            except Exception as e: self.logger.warning(f"[DiagramService] Error closing channel: {e}", exc_info=True)
        if self.connection and self.connection.is_open:
            try: self.connection.close()
            except Exception as e: self.logger.warning(f"[DiagramService] Error closing connection: {e}", exc_info=True)
        self.logger.info(f"[DiagramService] Diagram service stopped.")

# Signal handler for graceful shutdown
def graceful_shutdown(sig, frame):
    logger.info(f"Graceful shutdown initiated by signal {sig}")
    
    # Stop the Architecture JSON generator thread
    logger.info(f"Stopping Architecture JSON Generation Service...")
    stop_arch_json_consuming() # Signal the architecture_JsonGen consumer to stop

    # Stop other class-based services
    for service in services_to_stop:
        logger.info(f"Stopping service: {service.__class__.__name__}...")
        stop_method = getattr(service, "stop", None)
        if not callable(stop_method):
            stop_method = getattr(service, "stop_consuming", None)

        if callable(stop_method):
            stop_method()
        else:
            logger.warning(f"No stop method found for service: {service.__class__.__name__}")

    # Wait for all threads to complete
    logger.info(f"Waiting for service threads to complete...")
    for t in service_threads:
        logger.info(f"Joining thread: {t.name}")
        t.join(timeout=10) # Wait up to 10 seconds for each thread
        if t.is_alive():
            logger.warning(f"Thread {t.name} did not stop in time.")
    
    logger.info(f"All services and threads stopped. Exiting.")
    sys.exit(0)

if __name__ == "__main__":
    signal.signal(signal.SIGINT, graceful_shutdown)
    signal.signal(signal.SIGTERM, graceful_shutdown)

    logger.info(f"Initializing Cloud Architecture Assistant Backend Services...")

    # 1. Start Architecture JSON Generation Service (thread-based)
    logger.info(f"Starting Architecture JSON Generation Service...")
    arch_json_thread = threading.Thread(target=consume_json_requests, name="ArchitectureJsonServiceThread")
    service_threads.append(arch_json_thread)
    arch_json_thread.start()

    # 2. Start Cost Estimator Service
    logger.info(f"Starting Cost Estimator Service...")
    cost_estimator = CostEstimatorService()
    # cost_estimator.connect_rabbitmq() # connect_rabbitmq is called within start_consuming
    cost_thread = threading.Thread(target=cost_estimator.start_consuming, name="CostEstimatorThread")
    service_threads.append(cost_thread)
    services_to_stop.append(cost_estimator) # For calling stop_consuming during shutdown
    cost_thread.start()

    # 3. Start Diagram Generation Service
    logger.info(f"Starting Diagram Generation Service...")
    diagram_service = DiagramServiceWrapper()
    # diagram_service.connect_rabbitmq() # connect_rabbitmq is called within start
    diagram_thread = threading.Thread(target=diagram_service.start, name="DiagramServiceThread")
    service_threads.append(diagram_thread)
    services_to_stop.append(diagram_service) # For calling stop during shutdown
    diagram_thread.start()

    logger.info(f"All backend services initialized and running.")
    
    # Keep the main thread alive to allow background threads to run
    # The signal handler will manage shutdown.
    try:
        while True:
            # Check if any service threads have unexpectedly died
            for t in service_threads[:]: # Iterate over a copy
                if not t.is_alive():
                    logger.warning(f"Thread {t.name} has died unexpectedly. Attempting to restart or log error.")
                    # Simple removal, or implement restart logic if necessary
                    service_threads.remove(t)
                    # Potentially try to restart the service associated with t
            if not service_threads: # If all threads died
                logger.error(f"All service threads have died. Shutting down.")
                graceful_shutdown(None, None) # Trigger shutdown
                break
            time.sleep(5) # Check every 5 seconds
    except KeyboardInterrupt:
        logger.info(f"Main thread received KeyboardInterrupt. Initiating graceful shutdown...")
        graceful_shutdown(signal.SIGINT, None)
    except Exception as e:
        logger.error(f"Unhandled exception in main thread: {e}", exc_info=True)
        graceful_shutdown(signal.SIGTERM, None) # Or some other signal
