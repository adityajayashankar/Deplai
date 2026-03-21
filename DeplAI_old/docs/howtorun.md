<div align="center">
  🚩🧡🕉️ || जय श्री राम || 🕉️🧡🚩
</div>

---

# How to Set Up and Run the DeplAI Project

This guide provides step-by-step instructions to set up and run the complete DeplAI application, including all backend services, workers, and the user interface.

## 1. Prerequisites

Before you begin, ensure you have the following installed and configured:

*   **Python:** Version 3.13 or higher.
*   **Git:** For cloning the repository.
*   **Docker:** To run the required backend services (RabbitMQ and Redis).

## 2. Environment Configuration

You must provide API keys and service configurations in an environment file for the application to run.

1.  **Create the Environment File:**
    In the root directory of the project, make a copy of the `.env.template` file and name it `.env`.

2.  **Edit the `.env` File:**
    Open the newly created `.env` file and fill in the required values, such as your `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `GITHUB_TOKEN`. The comments in the file explain what each variable is for.

## 3. Backend Services & Dependencies

There are two ways to set up and run the backend services: manually using individual Docker commands or automatically with Docker Compose.

### Method 1: Manual Setup (Default)

This method requires you to run each component in a separate terminal.

1.  **Start Backend Services with Docker:**
    The application requires RabbitMQ for messaging and Redis for caching. Run the following commands in your terminal to start them in Docker containers:

    ```bash
    # Start RabbitMQ
    docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 -e RABBITMQ_DEFAULT_USER=user -e RABBITMQ_DEFAULT_PASS=password rabbitmq:3.9-management

    # Start Redis
    docker run -d --name redis -p 6379:6379 redis:latest
    ```

2.  **Set Up a Python Virtual Environment:**
    From the project's root directory, create and activate a virtual environment. This keeps the project's dependencies isolated.
    ```bash
    # Create the virtual environment
    python -m venv .venv

    # Activate it (Windows)
    .venv\\Scripts\\activate

    # Activate it (macOS/Linux)
    source .venv/bin/activate
    ```

3.  **Install Python Dependencies:**
    Install all the required Python libraries from the single `requirements.txt` file.
    ```bash
    pip install -r requirements.txt
    ```

### Method 2: Automated Setup with Docker Compose

If you have Docker Compose installed, you can start all services (backend, workers, and frontend) with a single command. This is the recommended approach for a simpler setup.

1.  **Build and Run the Services:**
    From the root directory of the project, run:
    ```bash
    docker-compose up --build
    ```
    This command will build the Docker images for the application components and start all the services defined in the `docker-compose.yml` file.

2.  **Accessing the Application:**
    *   **Streamlit UI:** `http://localhost:8501`
    *   **RabbitMQ Management:** `http://localhost:15672` (guest/guest)
    *   **Backend API (if needed):** `http://localhost:8000`

## 4. Populate the RAG Knowledge Base

This is a **one-time step** that you must perform before running the application for the first time. This process indexes the Terraform documentation, which the agent uses to generate code.

*   **If you are using the Manual Setup (Method 1):**
    From the project's **root directory**, run the following command in your activated virtual environment:
    ```bash
    python -m terraform_rag_agent.src.indexer
    ```

*   **If you are using Docker Compose (Method 2):**
    The `indexer` service is defined but commented out in `docker-compose.yml` to prevent it from running every time. To run it once, use the following command:
    ```bash
    docker-compose run --rm indexer
    ```

*Note: This can take several minutes to complete. You only need to re-run it if you want to update the agent's knowledge base.*

## 5. Running the Full Application (Manual Method)

**This section applies only if you chose Method 1 (Manual Setup).** If you are using Docker Compose, all services are already running.

To run DeplAI manually, you need to start three separate components in three different terminals: the **Workers**, the **Main Service**, and the **Streamlit UI**. Make sure your virtual environment is activated in each terminal.

**Terminal 1: Start the Workers**
These are the background processes that listen for jobs like generating Terraform code and deploying to GitHub.

```bash
# Start the Terraform Generator Worker
python -m workers.terraform_generator_worker

# In a NEW terminal, start the GitHub Deployment Worker
python -m workers.github_deployment_worker
```

**Terminal 2: Start the Main Service**
This service handles tasks like cost estimation.

```bash
# Start the main application service
python main.py
```

**Terminal 3: Start the Streamlit UI**
This is the user-facing web application.

```bash
streamlit run ui/app.py
```

Once all components are running, you can access the DeplAI application by navigating to the local URL provided by Streamlit in your web browser (usually `http://localhost:8501`). 
