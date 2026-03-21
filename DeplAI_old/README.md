<div align="center">
  🚩🧡🕉️ || जय श्री राम || 🕉️🧡🚩
</div>

---

<br />
<div align="center">

  <h1 align="center">🚀 DeplAI 🚀</h1>
  <p align="center">
    Your Intelligent Cloud Architecture Assistant!
    <br />
    DeplAI listens to your needs, designs tailored cloud architectures, estimates costs, generates diagrams, and (soon!) helps deploy your infrastructure using Terraform.
    <br />
    <a href="https://github.com/VinsmokeSomya/DeplAI/issues">Report Bug</a>
    ·
    <a href="https://github.com/VinsmokeSomya/DeplAI/issues">Request Feature</a>
  </p>
</div>

<div align="center">

[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](http://unlicense.org/)
[![GitHub issues](https://img.shields.io/github/issues/VinsmokeSomya/DeplAI.svg)](https://github.com/VinsmokeSomya/DeplAI/issues)
[![GitHub forks](https://img.shields.io/github/forks/VinsmokeSomya/DeplAI.svg)](https://github.com/VinsmokeSomya/DeplAI/network/members)
[![GitHub stars](https://img.shields.io/github/stars/VinsmokeSomya/DeplAI.svg)](https://github.com/VinsmokeSomya/DeplAI/stargazers)
[![Python Version](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

</div>

---

## 📖 About The Project

> Legacy notice: The Streamlit frontend is deprecated in this repo snapshot.  
> Use the React Connector UI (`/dashboard` and `/dashboard/pipeline`) as the active interface.

DeplAI is an innovative suite of tools designed to simplify and accelerate your cloud journey. Whether you're a startup sketching your first MVP or an enterprise optimizing existing infrastructure, DeplAI offers an AI-powered helping hand.

✨ **Core Features:**
*   **🗣️ AI-Powered Requirement Analysis:** Describe your project, and DeplAI's AI will ask clarifying questions to understand your needs.
*   **🏗️ Multi-Cloud Architecture Design:** Generates a detailed architecture in JSON format for **AWS, Azure, and GCP** based on your requirements.
*   **📊 Cost Estimation:** Provides an estimated monthly cost breakdown for the proposed services (currently AWS-only).
*   **🖼️ Multi-Cloud Diagram Generation:** Automatically creates a visual architecture diagram for **AWS, Azure, and GCP** from the JSON specification.
*   **🤖 Automated Terraform Code Generation:** Integrates a powerful RAG agent to generate validated, deploy-ready Terraform HCL code from your architecture.
*   **🚀 Automated GitOps Deployment:** Can automatically create a GitHub repository, configure secrets, and set up a CI/CD pipeline to deploy your infrastructure.
*   **Redis Caching:** Implements Redis caching for AI responses to improve speed and reduce costs.
*   **📜 Enhanced Logging:** Structured and emoji-enhanced logging for better readability and debugging.

✨ **Deployment Modes:**
*   **Infrastructure-Only Deployment:** Generates the complete Terraform code for your cloud architecture, allowing you to integrate your application code later. This is perfect for setting up a new environment before the application is ready.
*   **Full Deployment:** In addition to the infrastructure, this mode prompts you to upload your application code (e.g., a `.zip` file for a Lambda function or an S3 static website). The generated Terraform code will automatically include these artifacts in the deployment.

Our goal is to make cloud architecture design intuitive, cost-effective, and deployment-ready!

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---
## 📈 Progress

| Task | AWS | Azure | GCP |
|------|-----|-------|-----|
| Assistance | ✅ | ✅ | ✅ |
| Diagram Generation | ✅ | ✅ | ✅ |
| Cost Estimation | ✅ | ✅ | ⏳ |
| Terraform | ✅ | ✅ | ✅ |
| Terraform Test & Deployment| ✅ | 🔜 | 🔜 |
| GitOps | ✅ | ⏳ | ⏳ |
| Cloud Logging | ✅ | 🔜 | 🔜 |


<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🛠️ Built With

DeplAI leverages a modern stack of technologies:

*   ![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
*   ![Streamlit](https://img.shields.io/badge/Streamlit-FF4B4B?style=for-the-badge&logo=Streamlit&logoColor=white)
*   ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
*   ![RabbitMQ](https://img.shields.io/badge/RabbitMQ-FF6600?style=for-the-badge&logo=rabbitmq&logoColor=white)
*   ![Redis](https://img.shields.io/badge/redis-%23DD0031.svg?&style=for-the-badge&logo=redis&logoColor=white)
*   ![AWS](https://img.shields.io/badge/AWS-%23FF9900.svg?&style=for-the-badge&logo=amazon-aws&logoColor=white)
*   ![Azure](https://img.shields.io/badge/azure-%230072C6.svg?&style=for-the-badge&logo=microsoftazure&logoColor=white)
*   ![Google Cloud](https://img.shields.io/badge/Google%20Cloud-%234285F4.svg?&style=for-the-badge&logo=google-cloud&logoColor=white)
*   ![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)
*   ![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
*   ![Terraform](https://img.shields.io/badge/Terraform-7B42BC?style=for-the-badge&logo=terraform&logoColor=white)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🚀 Getting Started

Follow these steps to get DeplAI up and running on your local machine.

### Prerequisites

*   **Python:** Version 3.13 or higher.
*   **Docker & Docker Compose:** To run the entire application stack.
*   **Git:** For cloning the repository.
*   **AWS Account & Credentials:** (Optional, for actual cost estimation and deployment).

### Installation & Setup

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/VinsmokeSomya/DeplAI.git
    cd DeplAI
    ```

2.  **Create and Activate a Virtual Environment:**
    ```bash
    python -m venv .venv
    source .venv/bin/activate  # On Windows: .venv\Scripts\activate
    ```

3.  **Install Dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Set Up Environment Variables:**
    *   Copy the `.env.template` file to a new file named `.env`:
        ```bash
        cp .env.template .env
        ```
    *   Open the `.env` file and fill in your specific configurations, including `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `GITHUB_TOKEN`.

5.  **Populate the RAG Knowledge Base (One-Time Step):**
    Before running the application for the first time, you must index the Terraform documentation. This allows the agent to generate code.
    *   **If running manually (Method 2 below):** Activate your virtual environment and run:
        ```bash
        python -m terraform_rag_agent.src.indexer
        ```
    *   **If using Docker Compose (Method 1 below):** Run the following command once:
        ```bash
        docker-compose run --rm indexer
        ```
    *Note: This process can take several minutes.*

### Running the Application

There are two ways to run the full application stack.

#### Method 1: Using Docker Compose (Recommended)
This method starts the frontend, backend, and workers with a single command.

1.  **Build and Start All Services:**
    From the project root directory, run:
    ```bash
    docker-compose up --build
    ```
2.  **Access the Services:**
    *   **Streamlit UI:** `http://localhost:8501`
    *   **RabbitMQ Management:** `http://localhost:15672` (Use `guest`/`guest`)
    *   **Backend API:** `http://localhost:8000`

#### Method 2: Manual Execution
This method requires you to run each component in a separate terminal. Ensure your Python virtual environment is activated for each one.

1.  **Start External Services (Redis & RabbitMQ):**
    Use Docker to run the message queue and cache. Note that the container names (`redis-cache`, `rabbitmq-server`) should match what the application expects if you are also using the Docker Compose method.

    ```bash
    # Start Redis
    docker run -d --name redis-cache -p 6379:6379 redis:latest

    # Start RabbitMQ (Option 1: with default guest/guest user)
    docker run -d --name rabbitmq-server -p 5672:5672 -p 15672:15672 rabbitmq:3-management
    
    # OR
    
    # Start RabbitMQ (Option 2: with a custom user/password)
    docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 -e RABBITMQ_DEFAULT_USER=user -e RABBITMQ_DEFAULT_PASS=password rabbitmq:3.9-management
    ```

2.  **Run the Workers:**
    Open two separate terminals and run the following commands:
    ```bash
    # Terminal 1: Start the Terraform Generator Worker
    python -m workers.terraform_generator_worker

    # Terminal 2: Start the GitHub Deployment Worker
    python -m workers.github_deployment_worker
    ```

3.  **Run the Backend Service:**
    In a new terminal, start the main application service:
    ```bash
    # Start the main application service
    python main.py
    ```

4.  **Run the Streamlit Frontend:**
    In a final terminal, launch the UI:
    ```bash
    streamlit run streamlit_app.py
    ```
    Open your browser and go to the URL provided by Streamlit (usually `http://localhost:8501`).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🧪 Testing

This project is equipped with a full integration test suite and a continuous integration pipeline powered by Jenkins.

-   **Integration Tests:** The `tests/` directory contains tests that verify the end-to-end functionality of all major backend services, including the Architecture Generator, Cost Estimator, and Diagram Generator.
-   **CI/CD Pipeline:** The `Jenkinsfile` in the root directory defines a pipeline that automatically builds the environment, runs tests using both Docker Compose and manual setup methods in parallel, and ensures the application is always in a deployable state.
-   **Local Testing Environment:** The entire Jenkins setup can be run locally using Docker, providing a consistent and reproducible testing environment.

For a complete, step-by-step guide on how to set up the Jenkins container and run the pipeline, please see the **[Testing Guide](howtotest.md)**.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🛠 Project Structure

<pre>
.
├── .github/                        # GitHub Actions CI/CD workflows
├── .venv/                          # Python virtual environment
├── Projects/                       # Default output directory for generated projects
├── api_test/                       # Scripts for testing external API connections
│   ├── gemini-api-test.py
│   └── openai-api-test.py
├── cicd_templates/                 # Templates for CI/CD pipelines (e.g., deploy.yml)
├── terraform_rag_agent/            # The standalone Terraform Generation RAG Agent
│   ├── src/
│   │   ├── agent/                  # Core agent logic (orchestrator, planner, tools)
│   │   ├── ingestion/              # Scripts to build the knowledge base
│   │   └── utils/
│   ├── db/                         # ChromaDB knowledge base storage
│   ├── howtorun.md                 # Setup guide for the agent
│   └── requirements.txt
├── ui/                             # Modules for the Streamlit frontend
│   ├── ai_helpers.py               # Functions for interacting with the AI
│   ├── github_ui.py                # UI components for the GitHub deployment stage
│   ├── rabbitmq_helpers.py         # Functions for communicating with workers
│   └── ui_stages.py                # Defines the different stages of the UI conversation
├── workers/                        # Backend worker microservices
│   ├── github_deployment_worker.py # Worker to handle GitOps deployment
│   └── terraform_generator_worker.py # Worker to run the RAG agent
├── .gitignore
├── README.md                       # This file
├── finalstep.md                    # High-level plan for the final project workflow
├── main.py                         # Main FastAPI application (obsolete, functionality moved)
├── requirements.txt                # Main Python dependencies
└── streamlit_app.py                # Main entry point for the Streamlit UI
</pre>

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🛠 Services Overview

DeplAI's backend is built on a microservices architecture using RabbitMQ for message passing:

*   **🧠 Architecture JSON Generator:**
    *   Receives user requirements.
    *   Interacts with OpenAI (gpt-5-codex) to produce a structured JSON representing the cloud architecture for AWS, Azure, or GCP.
    *   Responds via a reply queue.
*   **💰 Cost Estimator:**
    *   Takes the architecture JSON as input.
    *   Queries AWS Pricing APIs (or uses mock data) for relevant services (EC2, RDS, S3, Lambda). **Azure and GCP coming soon!**
    *   Returns a detailed cost breakdown.
*   **🎨 Diagram Generator:**
    *   Accepts the architecture JSON.
    *   Uses the `diagrams` library to create a Python-based diagram for AWS, Azure, or GCP.
    *   Saves the diagram as an image and returns the path or image data.
*   **📜 Terraform Generator:**
    *   Takes the architecture JSON as input.
    *   Utilizes a Retrieval Augmented Generation (RAG) agent with a deep knowledge base of Terraform documentation.
    *   Generates validated, multi-file (`main.tf`, `variables.tf`, `outputs.tf`) Terraform HCL code for the specified architecture.
*   **🚀 GitOps Deployment Service:**
    *   Takes the generated Terraform code and any user-provided artifacts (e.g., website files).
    *   Creates a new private GitHub repository.
    *   Configures cloud credentials as GitHub secrets.
    *   Commits the code and a pre-configured GitHub Actions workflow to the repository, ready for an automated `terraform apply`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🗺️ Roadmap & Features

We have exciting plans for DeplAI! Check out our detailed roadmap and list of proposed features:
➡️ **[features.md](features.md)**

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 🤝 Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**!

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again! ⭐

1.  Fork the Project (`https://github.com/VinsmokeSomya/DeplAI/fork`)
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your Changes (`git commit -m 'feat: Add some AmazingFeature'`)
4.  Push to the Branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## 📜 License

Distributed under the Unlicense. See `LICENSE.txt` (or assume Unlicense if not present) for more information.
Essentially, this software is public domain. Do whatever you want with it.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---
