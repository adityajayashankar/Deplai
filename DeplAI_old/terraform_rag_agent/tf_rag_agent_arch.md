# Terraform RAG System Architecture - Corrected Flow

This diagram illustrates the two primary operational flows of the system: the one-time indexing process for populating the knowledge base, and the runtime process for generating and deploying code based on a user's request.

### (A) Indexing Time (One-Time Setup)
```
┌──────────────────┐          ┌──────────────────┐
│  Terraform Docs  │          │   SentenceTransf │
│  & Best Practices├─────────▶│  & Embeddings    │
└─────────┬────────┘          └────────┬─────────┘
          │                            │
          └─────────────┬──────────────┘
                        ▼
                    (writes to)
          ┌───────────────────────────┐
          │  Knowledge Base           │
          │  (ChromaDB Vector DB)     │
          └───────────────────────────┘
```

### (B) Runtime (Per-Request Execution)
```
                                            ┌───────────────────────────┐
                                            │  Knowledge Base           │
                                            │  (ChromaDB Vector DB)     │
                                            └────────────┬──────────────┘
                                                         │ (retrieval)
                                                         │
   ┌───────────────┐     (Architecture JSON)     ┌───────▼────────┐        (prompt)         ┌────────────────┐
   │               │────────────────────────────▶│                │────────────────────────▶│                │
   │ DeplAI UI &   │                             │  RAG Pipeline  │                         │   OpenAI API   │
   │   Workers     │                             │  (LangChain)   │                         │    (GPT-4)     │
   │               │◀───(final package)──────────│                │◀──────────(response)────│                │
   └───────┬───────┘                             └───────┬────────┘                         └────────────────┘
           │                                             │ (code)
           │                                             │
           │ (GitOps Deploy)                             ▼
           │                                     ┌────────────────┐
           │                                     │   Validation   │
           │                                     │    Pipeline    │
           │                                     └───────┬────────┘
           │                                             │ (error report)
           │                                             │
           │                         ┌───────────────────▼───────────────┐
           │                         │      Self-Correction Loop         │
           │                         │ (Reruns pipeline with error ctx)  │
           │                         └───────────────────────────────────┘
           ▼
┌──────────────────────┐           ┌───────────────────────────┐
│ GitHub Repo &        │           │   GitHub Actions CI/CD    │
│ Secrets Setup        ├───────────▶    (terraform apply)      │
│ (GitOps Deployment)  │           │                           │
└──────────┬───────────┘           └─────────────┬─────────────┘
           │                                     │
           └─────────────────────────────────────│
                                                 ▼
                                      ┌──────────────────┐
                                      │    Live Cloud    │
                                      │  Infrastructure  │
                                      └──────────────────┘
```

## Architecture Components Explained

### 1. Terraform Docs & Best Practices
- **Description:** The source documentation containing Terraform AWS resource definitions, usage examples, and best practices.
- **Function:** Provides the foundational knowledge for the RAG system.
- **Implementation:** Documentation scraped from registry.terraform.io and official AWS Terraform provider docs using structured mapper files that define the hierarchical organization of resources.
- **Mapper Integration:** JSON mapper files maintain the complex multi-level hierarchy of provider → service category → resource type → documentation.

### 2. SentenceTransformers & Embeddings
- **Description:** Natural language processing tools that convert text documentation into vector embeddings.
- **Function:** Transforms Terraform documentation into numerical representations that can be semantically searched.
- **Implementation:** Uses the `all-mpnet-base-v2` model to create high-quality embeddings with 768 dimensions.
- **Performance Considerations:** Batched processing for large documentation sets with caching of intermediate results.

### 3. Knowledge Base (Custom Ingestion)
- **Description:** Core component that organizes and indexes the Terraform documentation.
- **Function:** Structures the embeddings and provides retrieval mechanisms for relevant documentation.
- **Implementation:** Uses a custom Python script (`indexer.py`) that leverages components from `LlamaIndex` and `SentenceTransformers` but implements a manual ingestion pipeline. This provides granular control over cloning documentation from Git repositories and parsing specific file formats.
- **Advanced Features:** Supports hybrid search combining semantic and keyword matching for improved retrieval precision.

### 4. ChromaDB Vector Database
- **Description:** Persistent storage system for vector embeddings of Terraform documentation.
- **Function:** Efficiently stores and retrieves embeddings based on semantic similarity to queries.
- **Implementation:** Integrated via a custom ingestion script, maintaining the structured metadata from mappers for filtering and categorization.
- **Integration Details:** ChromaDB provides persistent storage while the RAG agent's tools handle the retrieval logic.

### 5. Architecture JSON Input
- **Description:** The user's infrastructure specification in JSON format, generated by the main DeplAI application.
- **Function:** Defines the resources, attributes, and relationships to be generated as Terraform code.
- **Implementation:** Structured JSON with resource definitions, properties, and edge relationships between components.
- **Validation:** Schema validation ensures the input follows required patterns before processing.

### 6. DeplAI Application (UI & Workers)
- **Description:** The main user-facing application and its background workers.
- **Function:** Provides a UI for users to define requirements, initiates jobs via RabbitMQ, and receives the final packaged project.
- **Implementation:** A Streamlit UI for user interaction, and Python workers that manage the communication with the RAG agent.

### 7. RAG Pipeline (LangChain)
- **Description:** Orchestration layer that manages the retrieval and generation process.
- **Function:** Coordinates knowledge retrieval, prompt construction, and code generation in a multi-stage pipeline.
- **Implementation:** LangChain chains and agents with custom prompt templates for different resource types.
- **Error Handling:** Includes fallback mechanisms and a self-correction loop to handle validation errors.

### 8. OpenAI API (GPT-4)
- **Description:** Large language model service that generates Terraform code.
- **Function:** Creates HCL code based on architecture specifications and retrieved documentation.
- **Implementation:** API integration with the GPT-4 model using tailored system messages and low temperature settings.
- **Optimization:** Uses response streaming and efficient token management to handle large infrastructure generations.

### 9. Code Generator & Organizer
- **Description:** Component that processes, structures, and organizes the generated code.
- **Function:** Converts raw LLM outputs into properly structured Terraform files (`main.tf`, `variables.tf`, etc.).
- **Implementation:** Custom Python codebase that parses and organizes HCL into the standard Terraform structure.
- **Error Correction:** Implements heuristics to fix common LLM-generated code issues automatically.

### 10. Python-HCL2 & Jinja2 Templates
- **Description:** Tools for processing and templating Terraform HCL code.
- **Function:** Validates, parses, and formats the generated HCL, applying consistent patterns and structures.
- **Implementation:** Python-HCL2 for parsing and manipulation, Jinja2 for standard code templates and patterns.
- **Template Repository:** Maintains a library of best-practice templates for common infrastructure patterns.

### 11. Final Project Package
- **Description:** The complete, deployable project folder delivered to the user.
- **Function:** Provides the validated Terraform code, along with documentation, reports, and any user-provided artifacts (like Lambda zip files).
- **Implementation:** A downloadable archive containing the code, validation reports, cost estimates, and usage instructions.
- **Comprehensive Documentation:** Auto-generates README files and architectural diagrams for the generated infrastructure.

### 12. Validation Pipeline
- **Description:** Suite of tools for validating and optimizing the generated Terraform code.
- **Function:** Checks syntax, enforces best practices, and ensures security.
- **Implementation:** Integration with Terraform CLI, TFLint, and Checkov with unified reporting.
- **Parallel Processing:** Runs validation tools concurrently to improve performance for large codebases.

### 13. GitOps Deployment (GitHub Actions)
- **Description:** Automated deployment component using a GitOps workflow.
- **Function:** Deploys the generated infrastructure by pushing the code to a version-controlled repository.
- **Implementation:** The deployment worker creates a private GitHub repository, adds the user's AWS credentials as secrets, and pushes the final project package. A pre-configured GitHub Actions workflow (`deploy.yml`) in the new repository is automatically triggered.
- **Workflow Steps:** The GitHub Action runs `terraform init`, `terraform plan`, and `terraform apply` in a secure cloud environment to provision the infrastructure.

### 14. Live Cloud Infrastructure
- **Description:** The actual provisioned cloud resources created by the deployment.
- **Function:** Represents the running infrastructure in the user's AWS account.
- **Implementation:** Real-world resources created from the generated Terraform code.
- **Monitoring:** Integration with cloud provider monitoring services to track resource health and performance.

### 15. Feedback Loop
- **Description:** System for continuous improvement based on generation results.
- **Function:** The agent's self-correction loop uses validation failures to refine its plan and regenerate code.
- **Implementation:** Stores successful generations as examples and uses validation errors to improve prompt templates and generation strategies over time.
- **Learning Mechanism:** Periodically updates prompt templates and embedding strategies based on performance data.

---

## End-to-End Process Flow

### 1. Knowledge Base Preparation & Management
1. **Automated Documentation Collection**:
   * Load JSON mapper files defining Terraform documentation structure
   * Automatically clone or pull Terraform provider repositories based on mapper definitions
   * Extract meaningful content from markdown files
   * Chunk documentation into appropriate segments (1000 tokens with 200 token overlap)
   * Generate embeddings using SentenceTransformers (all-mpnet-base-v2)
   * Store embeddings in ChromaDB with metadata from mapper files
   * Organize documentation by provider, service category, and resource type
   * Index related resources to enable cross-referencing during retrieval
   * Schedule periodic updates to capture new Terraform resources and documentation

2. **Architecture JSON Input Processing**:
   * User defines project requirements in the DeplAI Streamlit UI.
   * The application generates a validated `architecture.json` and sends it to the `terraform_generator_worker` via RabbitMQ.
   * The worker parses resource properties, attributes, and relationships.
   * A dependency graph is built using NetworkX to determine resource creation order.
   * The RAG agent's Planner receives the architecture and any user-provided code details.

3. **Knowledge Retrieval**:
   * For each resource in the plan, the RAG tool formulates specific queries.
   * Retrieve relevant documentation chunks from ChromaDB using semantic similarity.
   * Apply filters based on resource type and relationships.
   * Augment with best-practice patterns for the specific configuration.
   * Create resource-specific context sets with the most relevant documentation.

### 2. RAG Pipeline & Code Generation
1. **Pipeline Orchestration**:
   * LangChain manages the multi-stage generation process:
     - The Orchestrator calls the Planner to create a step-by-step resource generation plan.
     - It then iterates through the plan, calling the Code Generation and RAG tools.
   * The RAG tool combines retrieved documentation with the resource plan.
   * It formats prompts with specific instructions for each resource type.
   * It manages token limits and injects few-shot examples for complex patterns.

2. **Terraform Code Generation**:
   * Send prepared prompts to OpenAI GPT-4 with a low temperature (0.2) for consistent output.
   * Generate code in stages based on the dependency-ordered plan.
   * Process LLM responses to extract valid HCL.
   * Correct common LLM errors in Terraform syntax.

3. **Code Organization & Structure**:
   * The Code Splitter tool parses the generated HCL.
   * It organizes the code into a standard structure: `main.tf`, `variables.tf`, `outputs.tf`.
   * It ensures consistent naming conventions and references.

### 3. Validation, Optimization & Deployment
1. **Code Validation & Self-Correction**:
   * The orchestrator passes the generated code to the `TerraformValidationTool`.
   * This tool runs `terraform init` and `terraform validate`.
   * If validation fails, the error message and code are sent back to the `TerraformCodeCorrectorTool`.
   * The corrector tool analyzes the error and regenerates the faulty code block.
   * This loop continues until the code is valid or a retry limit is reached.

2. **Output & Packaging**:
   * Once the code is valid, the orchestrator packages the final project.
   * The package includes the Terraform files, a `README.md`, and any user code (e.g., `function.zip`).
   * This final project folder is sent back to the main application.

3. **Automated Deployment via GitOps**:
   * The user initiates deployment from the DeplAI UI.
   * A dedicated worker (`github_deployment_worker`) receives the project package.
   * The worker creates a new private GitHub repository for the user.
   * It securely adds the user's AWS credentials as repository secrets.
   * It pushes the project code to the new repository, which triggers a GitHub Action to run `terraform apply`.

### 4. Continuous Improvement System
1. **Feedback Collection & Analysis**:
   * The self-correction loop is the primary feedback mechanism, learning from validation errors.
   * Successful generations can be stored as examples to improve few-shot prompting.
   * The system's performance is tracked to identify areas for prompt engineering improvements. 