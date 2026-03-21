import pytest
import pika
import json
import uuid
import time
import os

# --- Configuration ---
# Use an environment variable for the host, falling back to localhost if not set.
# This allows the test to be run in different environments (local vs. CI).
MQ_HOST = os.environ.get("MQ_HOST", "localhost")
MQ_PORT = 5672
MQ_USERNAME = "guest"
MQ_PASSWORD = "guest"
MAIN_EXCHANGE = "direct_exchange"
RUN_INTEGRATION_TESTS = os.environ.get("RUN_INTEGRATION_TESTS", "0").strip() == "1"

# Queues and Routing Keys
ARCH_INPUT_QUEUE = "architectureRequestQueue"
ARCH_ROUTING_KEY = "architectureRequestKey"
COST_INPUT_QUEUE = "costEstimationRequestQueue"
COST_ROUTING_KEY = "costEstimationRequestKey"
DIAGRAM_INPUT_QUEUE = "diagramRequestQueue"
DIAGRAM_ROUTING_KEY = "diagramRequestKey"


# --- Test Fixtures ---

@pytest.fixture(scope="module")
def rabbitmq_connection():
    """Fixture to establish a connection to RabbitMQ for the test module."""
    if not RUN_INTEGRATION_TESTS:
        pytest.skip(
            "Integration tests are disabled by default. Set RUN_INTEGRATION_TESTS=1 to run them."
        )

    try:
        credentials = pika.PlainCredentials(MQ_USERNAME, MQ_PASSWORD)
        parameters = pika.ConnectionParameters(host=MQ_HOST, port=MQ_PORT, credentials=credentials, heartbeat=360)
        connection = pika.BlockingConnection(parameters)
        yield connection
        connection.close()
    except pika.exceptions.AMQPConnectionError as e:
        pytest.skip(f"RabbitMQ is not reachable at {MQ_HOST}:{MQ_PORT}. Skipping integration tests. Error: {e}")

@pytest.fixture(scope="function")
def mq_channel(rabbitmq_connection):
    """Fixture to create a fresh channel and a temporary callback queue for a test."""
    channel = rabbitmq_connection.channel()
    # Declare a unique, exclusive queue for the reply
    result = channel.queue_declare(queue='', exclusive=True)
    callback_queue = result.method.queue
    yield channel, callback_queue
    # The queue will be deleted automatically when the connection closes


# --- Helper Function ---

def rpc_call(channel, callback_queue, exchange, routing_key, payload):
    """
    Performs a remote procedure call (RPC) over RabbitMQ.
    Sends a message and waits for a response on a specific callback queue.
    """
    correlation_id = str(uuid.uuid4())
    
    channel.basic_publish(
        exchange=exchange,
        routing_key=routing_key,
        properties=pika.BasicProperties(
            reply_to=callback_queue,
            correlation_id=correlation_id,
            delivery_mode=2, # Make message persistent
        ),
        body=json.dumps(payload)
    )
    
    print(f" [x] Sent RPC request to '{routing_key}' with correlation ID: {correlation_id}")

    # Wait for the response
    response = None
    start_time = time.time()
    while time.time() - start_time < 60: # 60-second timeout
        method_frame, properties, body = channel.basic_get(queue=callback_queue, auto_ack=True)
        if method_frame and properties.correlation_id == correlation_id:
            response = json.loads(body.decode())
            print(f" [.] Got response: {json.dumps(response, indent=2)}")
            break
        time.sleep(0.1)
        
    return response


# --- Sample Data ---

AWS_ARCHITECTURE_JSON = {
    "title": "Simple Web App",
    "provider": "aws",
    "services": {
        "ec2_instance": {
            "type": "t2.micro",
            "count": 2,
            "region": "us-east-1",
            "ami": "ami-0c55b159cbfafe1f0"
        },
        "s3_bucket": {
            "name": "my-test-bucket-for-ci",
            "region": "us-east-1",
            "storage_gb": 100
        },
        "lambda_function": {
            "name": "my-test-lambda",
            "region": "us-east-1",
            "requests_per_month": 1000000,
            "duration_ms": 500,
            "memory_mb": 512
        }
    }
}

# --- Integration Tests ---

def test_cost_estimation_service(mq_channel):
    """Tests the Cost Estimation service with a sample AWS architecture."""
    channel, callback_queue = mq_channel
    
    request_payload = {
        "provider": "aws",
        "architecture_json": AWS_ARCHITECTURE_JSON
    }
    
    print("\n[TEST] Running Cost Estimation Test...")
    response = rpc_call(channel, callback_queue, MAIN_EXCHANGE, COST_ROUTING_KEY, request_payload)
    
    assert response is not None, "Did not receive a response from the cost estimator service."
    assert "cost_report" in response, "Response should contain a 'cost_report' key."
    
    report = response["cost_report"]
    assert report["provider"] == "aws"
    assert "overall_total_monthly_usd" in report
    assert report["overall_total_monthly_usd"] > 0
    assert "service_breakdown" in report
    assert "EC2" in report["service_breakdown"]
    assert "S3" in report["service_breakdown"]
    assert "Lambda" in report["service_breakdown"]
    print("[PASS] Cost Estimation Test Passed.")


def test_diagram_generation_service(mq_channel):
    """Tests the Diagram Generation service."""
    channel, callback_queue = mq_channel
    
    output_dir = "test-diagrams"
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    request_payload = {
        "provider": "aws",
        "architecture_json": AWS_ARCHITECTURE_JSON,
        "output_directory": output_dir,
        "project_title_for_filename": "TestWebAppDiagram"
    }
    
    print("\n[TEST] Running Diagram Generation Test...")
    response = rpc_call(channel, callback_queue, MAIN_EXCHANGE, DIAGRAM_ROUTING_KEY, request_payload)
    
    assert response is not None, "Did not receive a response from the diagram generator service."
    assert "diagram_path" in response, f"Response should contain 'diagram_path'. Error: {response.get('error')}"
    
    diagram_path = response["diagram_path"]
    assert os.path.exists(diagram_path), f"Diagram file was not created at the expected path: {diagram_path}"
    assert diagram_path.startswith(output_dir)
    assert diagram_path.endswith(".png")
    
    # Clean up the generated file
    os.remove(diagram_path)
    print(f"[PASS] Diagram Generation Test Passed. Cleaned up {diagram_path}.")
    
def test_architecture_json_generation(mq_channel):
    """Tests the Architecture JSON Generation service."""
    channel, callback_queue = mq_channel
    
    request_payload = {
        "prompt": "Create a simple AWS serverless architecture for a web API.",
        "provider": "aws"
    }
    
    print("\n[TEST] Running Architecture JSON Generation Test...")
    # This assumes the architecture service uses a similar RPC pattern
    # We may need to adjust the routing key based on its implementation
    response = rpc_call(channel, callback_queue, MAIN_EXCHANGE, ARCH_ROUTING_KEY, request_payload)
    
    assert response is not None, "Did not receive a response from the architecture generation service."
    assert "architecture" in response, "Response should contain an 'architecture' key."
    
    arch = response["architecture"]
    assert isinstance(arch, dict)
    assert arch.get("provider") == "aws"
    assert "services" in arch and isinstance(arch["services"], dict)
    print("[PASS] Architecture JSON Generation Test Passed.") 
