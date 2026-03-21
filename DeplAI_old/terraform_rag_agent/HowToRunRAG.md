# How to Set Up and Run the Terraform RAG Agent

This guide provides detailed instructions to set up the agent's environment, its dependencies, and run it as a worker service.

## 1. Prerequisites

Before you begin, ensure you have the following installed and configured:

*   **Python:** Version 3.10 or higher.
*   **Git:** For cloning the repository.
*   **Docker:** To run the required services (RabbitMQ and Redis).
*   **OpenAI API Key:** You need an active key for the agent to access the language models.

## 2. Docker Setup (Dependencies)

The agent relies on two external services: **RabbitMQ** for receiving jobs and **Redis** for caching. The easiest way to run them is with Docker.

1.  **Run RabbitMQ:**
    This command starts a RabbitMQ container with the management plugin enabled.
    ```bash
    docker run -d --name deplai-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
    ```
    *   The agent communicates on port `5672`.
    *   You can access the management UI at `http://localhost:15672` (default user: `guest`, password: `guest`).

2.  **Run Redis:**
    This command starts a Redis container for caching LLM responses, which improves performance.
    ```bash
    docker run -d --name deplai-redis -p 6379:6379 redis:latest
    ```
    *   The agent connects on port `6379`.

## 3. Local Setup

1.  **Navigate to the Agent Directory:**
    From the root of the DeplAI project, move into the agent's directory.
    ```bash
    cd terraform_rag_agent
    ```

2.  **Create and Activate a Virtual Environment:**
    ```bash
    # On Windows
    python -m venv venv
    .\venv\Scripts\activate

    # On macOS/Linux
    python3 -m venv venv
    source venv/bin/activate
    ```

3.  **Install Dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Set Up Environment Variables:**
    Create a `.env` file by copying the `.env.template` template.
    ```bash
    # PowerShell / Windows
    Copy-Item .env.template .env

    # macOS/Linux
    cp .env.template .env
    ```
    Open the `.env` file and add your configuration:
    ```.env
    OPENAI_API_KEY='your_openai_api_key_here'

    # RabbitMQ Connection Details (must match DeplAI root config names)
    MQ_HOST=localhost
    MQ_PORT=5672
    MQ_USERNAME=guest
    MQ_PASSWORD=guest
    
    # Redis
    REDIS_HOST=localhost
    REDIS_PORT=6379
    ```
    Note: the application reads env keys `MQ_*` (not `RABBITMQ_*`).

## 4. Key Scripts in `src/`

The `src` directory contains the core logic for the agent. Here's an overview of the key files:

*   `agent/`: This directory contains the most critical components of the agent's "brain," including the `Orchestrator` that manages the entire generation process, the `Planner` that breaks down tasks, and the various `Tools` the agent can use (code generation, validation, etc.).
*   `indexer.py`: **(Important)** This is the script used to build the agent's knowledge base. It scrapes Terraform documentation from the web and populates the ChromaDB vector store. You must run this script once before starting the agent for the first time.
*   `generator.py`: This script contains the high-level logic for the generation worker. It listens for messages from RabbitMQ, invokes the agent's orchestrator to generate the code, and handles the final packaging of artifacts.
*   `retriever.py`: A component responsible for querying the ChromaDB knowledge base to find relevant documentation based on the agent's current task.
*   `input_parser.py` / `architecture.py`: These modules handle the parsing and validation of the incoming `architecture.json` from the main application, ensuring the agent has a structured plan to work with.
*   `inspect_db.py`: A utility script for developers to check the contents of the ChromaDB knowledge base for debugging purposes.
*   `utils/`: A collection of helper functions and utilities used across the agent's codebase.

## 5. Running the Agent

1.  **Populate the Knowledge Base (One-Time Step):**
    Before running the agent for the first time, you must populate its knowledge base.
    
    **From the DeplAI project root**, run:
    ```bash
    python -m terraform_rag_agent.src.indexer
    ```
    This can take several minutes. You only need to re-run it when you want to update the agent's knowledge with newer documentation.

2.  **Run the Terraform Generator Worker:**
    The agent is a long-running service. To start it, run the following command **from the DeplAI project root directory** (one level above `terraform_rag_agent`).

    ```bash
    # Ensure you are in the root DeplAI directory
    # If you are in terraform_rag_agent, run: cd .. 
    
    # Run the worker module
    python -m workers.terraform_generator_worker
    ```
    The terminal will show that the worker has connected to RabbitMQ and is waiting for jobs. You can now use the main Streamlit UI to trigger a deployment, and this worker will automatically pick it up.
