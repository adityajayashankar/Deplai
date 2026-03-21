import os
import json
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Any, Optional, NamedTuple
from datetime import datetime
from tqdm import tqdm
import hashlib

import chromadb
from chromadb.utils import embedding_functions
from dotenv import load_dotenv

from .utils.rag_logger import get_rag_logger

logger = get_rag_logger(__name__)

class Document(NamedTuple):
    text: str
    metadata: dict

class TerraformDocIndexer:
    def __init__(self, mapper_file_path: str, db_path: str, repo_cache_dir: str):
        """Initialize the indexer with paths and configuration for Git-based ingestion."""
        self.mapper_file_path = Path(mapper_file_path)
        self.db_path = db_path
        self.repo_cache_dir = Path(repo_cache_dir)
        self.base_data_path = Path(db_path).parent.parent # Assumes db_path is .../data/vector_db
        self.chroma_client = None
        self.chroma_collection = None
        self.embedding_function = None
        self.source_mapper = {}
        
        load_dotenv()
        logger.debug("🔧 Initializing TerraformDocIndexer (Git-based)...")

        for dir_path in [self.repo_cache_dir, Path(self.db_path)]:
            if not dir_path.exists():
                logger.info(f"📂 Directory not found: {dir_path}. Creating it.")
                dir_path.mkdir(parents=True, exist_ok=True)
        
        self._load_source_mapper()

    def _load_source_mapper(self):
        """Loads the source mapper JSON file."""
        if self.mapper_file_path.exists():
            with open(self.mapper_file_path, 'r', encoding='utf-8') as f:
                self.source_mapper = json.load(f)
        else:
            logger.error(f"❌ Mapper file not found: {self.mapper_file_path}. Aborting.")
            raise FileNotFoundError(f"Mapper file not found: {self.mapper_file_path}")

    def _get_embedding_function(self):
        """Initialize the Sentence Transformer embedding function."""
        if not self.embedding_function:
            model_name = os.getenv("EMBEDDING_MODEL", "all-mpnet-base-v2")
            logger.info(f"🧠 Loading embedding model: {model_name}")
            try:
                self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
                    model_name=model_name
                )
                logger.info("✅ Embedding model loaded successfully.")
            except Exception as e:
                logger.error(f"🔥 Failed to load embedding model '{model_name}': {e}", exc_info=True)
                raise
        return self.embedding_function

    def setup_chromadb_collection(self, collection_name: str):
        """Initialize or connect to a specific ChromaDB collection."""
        logger.info(f"🗄️ Setting up ChromaDB collection: '{collection_name}' at path: {self.db_path}")
        try:
            if not self.chroma_client:
                self.chroma_client = chromadb.PersistentClient(path=self.db_path)

            embed_func = self._get_embedding_function()
            self.chroma_collection = self.chroma_client.get_or_create_collection(
                name=collection_name,
                embedding_function=embed_func
            )
            logger.info(f"✅ Successfully accessed ChromaDB collection: '{collection_name}'.")
        except Exception as e:
            logger.error(f"🔥 Failed to setup/connect to ChromaDB collection '{collection_name}': {e}", exc_info=True)
            self.chroma_collection = None
            raise

    def _run_git_command(self, command: List[str], cwd: str, timeout_seconds: int = 1800):
        """Runs a Git command and logs output."""
        try:
            logger.debug(f"Running command: git {' '.join(command)} in {cwd}")
            result = subprocess.run(
                ['git'] + command,
                cwd=cwd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout_seconds
            )
            logger.debug(f"Git command stdout: {result.stdout}")
            return True
        except FileNotFoundError:
            logger.error("🔥 Git command not found. Please ensure Git is installed and in your system's PATH.")
            raise
        except subprocess.TimeoutExpired:
            logger.error(f"🔥 Git command timed out after {timeout_seconds}s: {' '.join(command)}")
            return False
        except subprocess.CalledProcessError as e:
            logger.error(f"🔥 Git command failed: {' '.join(command)}")
            logger.error(f"Git stderr: {e.stderr}")
            return False

    def _clone_or_update_repo(self, git_url: str, version: Optional[str] = None) -> Optional[Path]:
        """Clones or updates a git repository, checks out a version, and returns the local path."""
        repo_name = git_url.split('/')[-1].replace('.git', '')
        repo_path = self.repo_cache_dir / repo_name

        def _clone_fresh() -> bool:
            logger.info(f"Cloning fresh repository for: {repo_name} from {git_url}")
            if version:
                clone_cmd = ["clone", "--depth", "1", "--branch", version, git_url, str(repo_path)]
            else:
                clone_cmd = ["clone", "--depth", "1", "--single-branch", "--filter=blob:none", git_url, str(repo_path)]
            return self._run_git_command(clone_cmd, cwd=str(self.repo_cache_dir))

        def _quarantine_and_reclone() -> bool:
            try:
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                quarantine_path = self.repo_cache_dir / f"{repo_name}_broken_{stamp}"
                logger.warning(f"Quarantining broken repo cache: {repo_path} -> {quarantine_path}")
                repo_path.rename(quarantine_path)
            except Exception as e:
                logger.error(f"Could not quarantine broken repo '{repo_name}': {e}")
                return False
            return _clone_fresh()

        if repo_path.exists():
            logger.info(f"Updating existing repository: {repo_name}")
            # Ensure remote refs are current before branch checks.
            if not self._run_git_command(["fetch", "--all", "--tags", "--prune"], cwd=str(repo_path)):
                if not _quarantine_and_reclone():
                    return None
                return repo_path

            # Recover from detached HEAD to allow pull/update.
            current_branch = None
            try:
                branch_result = subprocess.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=str(repo_path),
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=60
                )
                current_branch = branch_result.stdout.strip()
            except Exception:
                current_branch = None

            if current_branch == "HEAD" or not current_branch:
                target_branch = None
                if self._run_git_command(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], cwd=str(repo_path), timeout_seconds=60):
                    target_branch = "main"
                elif self._run_git_command(["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], cwd=str(repo_path), timeout_seconds=60):
                    target_branch = "master"

                if target_branch:
                    logger.warning(f"Repository '{repo_name}' is in detached HEAD. Checking out '{target_branch}'.")
                    if not self._run_git_command(["checkout", target_branch], cwd=str(repo_path), timeout_seconds=120):
                        if not self._run_git_command(["checkout", "-b", target_branch, f"origin/{target_branch}"], cwd=str(repo_path), timeout_seconds=120):
                            if not _quarantine_and_reclone():
                                return None
                            return repo_path
                    if not self._run_git_command(["pull", "origin", target_branch], cwd=str(repo_path)):
                        if not _quarantine_and_reclone():
                            return None
                        return repo_path
                else:
                    logger.error(f"Could not determine a default branch for '{repo_name}' (origin/main or origin/master missing).")
                    if not _quarantine_and_reclone():
                        return None
                    return repo_path
            else:
                if not self._run_git_command(["pull", "origin", current_branch], cwd=str(repo_path)):
                    if not _quarantine_and_reclone():
                        return None
                    return repo_path
        else:
            logger.info(f"Cloning new repository: {repo_name} from {git_url}")
            if not _clone_fresh():
                return None
            
        if version:
            logger.info(f"Checking out version: {version} for {repo_name}")
            if not self._run_git_command(["checkout", version], cwd=str(repo_path)):
                logger.warning(f"Could not checkout version '{version}' for {repo_name}. Using default branch.")

        return repo_path

    def _generate_doc_id(self, text: str) -> str:
        """Generates a consistent SHA256 hash for a given text string to use as a document ID."""
        return hashlib.sha256(text.encode('utf-8')).hexdigest()

    def _extract_resource_name_from_frontmatter(self, content: str) -> Optional[str]:
        """Extracts the resource name from the frontmatter of a markdown file."""
        frontmatter_match = re.search(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
        if frontmatter_match:
            frontmatter_str = frontmatter_match.group(1)
            patterns = [
                r'page_title:\s*".*?:\s*([^"]+)"',
                r'title:\s*"([^"]+)"'
            ]
            for pattern in patterns:
                title_match = re.search(pattern, frontmatter_str)
                if title_match:
                    resource_name = title_match.group(1).strip()
                    logger.debug(f"Extracted resource_name '{resource_name}' from content")
                    return resource_name
        return None

    def _process_markdown_file(self, file_path: Path, source_metadata: dict) -> Optional[Document]:
        """Reads a markdown file, extracts its content and metadata, and prepares it for indexing."""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            logger.warning(f"Could not read file {file_path}: {e}")
            return None

        # The category from the mapper is the ground truth for the document type.
        category = source_metadata.get("category", "unknown")
        
        # Map plural to singular for consistency with RAG tool expectations
        doc_type_mapping = {
            "resources": "resource",
            "data_sources": "data_source"
        }
        doc_type = doc_type_mapping.get(category, category) # fallback to category name itself

        metadata = {
            "source": source_metadata.get("name"),
            "category": category, # Keep original category for reference
            "doc_type": doc_type, # Use the potentially singularized type for the tool
            "file_path": str(file_path.relative_to(self.repo_cache_dir)),
            "file_name": file_path.name,
            "git_source": source_metadata.get("git_url")
        }
        logger.debug(f"Assigned doc_type: '{doc_type}' from category: '{category}' for {file_path.name}")

        resource_name = self._extract_resource_name_from_frontmatter(content)
        if resource_name:
            metadata['resource_name'] = resource_name

        return Document(text=content, metadata=metadata)

    def _process_examples(self, example_dir: Path, source_metadata: dict) -> list[Document]:
        """Processes example directories, creating a document per subdirectory."""
        TEXT_EXTENSIONS = ['.tf', '.tfvars', '.md', '.json', '.hcl', '.txt', '']
        example_units = [d for d in example_dir.iterdir() if d.is_dir()]
        if not example_units:
            logger.info(f"Found 0 example units in {example_dir.name}.")
            return []
            
        logger.info(f"Found {len(example_units)} example units in {example_dir.name}.")

        all_docs = []
        for unit_path in tqdm(example_units, desc=f"  -> Processing units in {example_dir.name}", leave=False):
            unit_content = ""
            for file_path in unit_path.rglob('*'):
                if file_path.is_file() and file_path.suffix.lower() in TEXT_EXTENSIONS:
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            unit_content += f"---\n# Source: {file_path.relative_to(unit_path)}\n---\n{f.read()}\n\n"
                    except Exception as e:
                        logger.warning(f"Could not read file {file_path} in example unit {unit_path.name}: {e}")
                    continue
                
            if unit_content:
                category = source_metadata.get("category", "unknown") # Use category from mapper
                metadata = {
                    "source": source_metadata.get("name"),
                    "category": category,
                    "doc_type": category, # doc_type should be 'examples'
                    "unit_name": unit_path.name,
                    "file_path": str(unit_path.relative_to(self.base_data_path)),
                    "git_source": source_metadata.get("git_url")
                }
                all_docs.append(Document(text=unit_content, metadata=metadata))
        return all_docs

    def _process_docs(self, base_dir: Path, file_pattern: str, source_metadata: dict) -> list[Document]:
        """Finds all files matching a pattern and processes them."""
        doc_files = list(base_dir.rglob(file_pattern))
        if not doc_files:
            logger.warning(f"Documentation directory {base_dir} not found or no files matching '{file_pattern}'.")
            return []

        logger.info(f"Found {len(doc_files)} files matching '{file_pattern}' in {source_metadata['category']}.")
        processed_docs = []
        for file_path in tqdm(doc_files, desc=f"  -> Processing files in {source_metadata['category']}", leave=False):
            processed_doc = self._process_markdown_file(file_path, source_metadata)
            if processed_doc:
                processed_docs.append(processed_doc)
        return processed_docs

    def store_documents(self, documents: list[Document]):
        """Store processed documents into the active ChromaDB collection."""
        if not documents:
            logger.warning("No documents to store.")
            return
            
        logger.info(f"💾 Storing {len(documents)} documents into ChromaDB collection '{self.chroma_collection.name}'...")
        batch_size = 100
        for i in tqdm(range(0, len(documents), batch_size), desc="  -> Storing to ChromaDB", leave=False):
            batch = documents[i:i+batch_size]
            
            ids = [self._generate_doc_id(doc.text) for doc in batch]
            contents = [doc.text for doc in batch]
            metadatas = [doc.metadata for doc in batch]

            try:
                self.chroma_collection.upsert(
                    ids=ids,
                    documents=contents,
                    metadatas=metadatas
                )
            except Exception as e:
                logger.error(f"🔥 Error storing documents in ChromaDB: {e}")
                if metadatas:
                    logger.error(f"Example of metadata that may have failed: {metadatas[0]}")
                return

    def index_all_documentation(self):
        """Main function to load mapper, process sources, and index them."""
        logger.info("🚀 Starting Terraform Documentation Indexing Pipeline (Git-based)...")
        sources = self.source_mapper.get("documentation_sources", [])

        for source in sources:
            source_name = source.get("name")
            if not source_name:
                logger.warning("⚠️ Skipping source in mapper with no 'name' field.")
                continue

            collection_name = f"{source_name}_docs"
            logger.info(f"--- 🚀 Processing Source: {source_name} into collection '{collection_name}' ---")

            self.setup_chromadb_collection(collection_name)

            source_control = source.get("source_control", {})
            git_url = source_control.get("url")
            version = source_control.get("version_tag")
            if not git_url:
                logger.warning(f"⚠️ No git URL for source '{source_name}'. Skipping.")
                continue

            repo_path = self._clone_or_update_repo(git_url, version)
            if not repo_path:
                logger.error(f"❌ Failed to clone/update repo for '{source_name}'. Skipping.")
                continue
            
            docs_for_this_source = []
            paths_config = source.get("paths", [])

            for path_item in paths_config:
                category = path_item.get("category")
                file_pattern = path_item.get("file_pattern")
                # Handle comma-separated list of files/dirs in the 'directory' field
                directories = [d.strip() for d in path_item.get("directory", "").split(',')]

                if not all([category, file_pattern, directories]):
                    logger.warning(f"Skipping invalid path item in '{source_name}': {path_item}")
                    continue

                source_metadata = {"name": source_name, "category": category, "git_url": git_url}
                
                for dir_str in directories:
                    if not dir_str: continue
                    path_to_process = repo_path / dir_str

                    if category == "examples":
                        logger.info(f"  -> Processing examples from '{dir_str}'")
                        docs_for_this_source.extend(self._process_examples(path_to_process, source_metadata))
                    elif path_to_process.is_file():
                        logger.info(f"  -> Processing file '{dir_str}'")
                        doc = self._process_markdown_file(path_to_process, source_metadata)
                        if doc:
                            docs_for_this_source.append(doc)
                    elif path_to_process.is_dir():
                        logger.info(f"  -> Processing docs directory '{dir_str}'")
                        docs_for_this_source.extend(self._process_docs(path_to_process, file_pattern, source_metadata))
                    else:
                        logger.warning(f"Path '{path_to_process}' not found for source '{source_name}'. Skipping.")

            if docs_for_this_source:
                self.store_documents(docs_for_this_source)
            else:
                logger.warning(f"🤔 No documents were processed for source: {source_name}.")

        logger.info("🎉 All sources processed. Documentation indexing pipeline completed.")


def main():
    """Main function to run the indexer independently."""
    # Define paths relative to the script's location (src/indexer.py)
    module_root = Path(__file__).parent.parent.resolve() # This is Terraform-RAG-Model
    
    mapper_path = module_root / "mappers" / "source_mapper.json"
    db_path = str(module_root / "data" / "vector_db")
    repo_cache = str(module_root / "data" / "repos")

    logger.info(f"Module root directory: {module_root}")
    logger.info(f"Source Mapper Path: {mapper_path}")
    logger.info(f"Vector DB Path: {db_path}")
    logger.info(f"Git Repos Cache Path: {repo_cache}")

    try:
        indexer = TerraformDocIndexer(
            mapper_file_path=str(mapper_path),
            db_path=db_path,
            repo_cache_dir=repo_cache,
        )
        indexer.index_all_documentation()
    except FileNotFoundError as e:
        logger.error(f"Initialization failed: {e}")
    except Exception as e:
        logger.critical(f"A critical error occurred: {e}", exc_info=True)


if __name__ == "__main__":
    logger.info("🚀 Starting Terraform Documentation Indexing (direct script run)...")
    main()
    logger.info("🏁 Indexing Process Finished (direct script run).")
