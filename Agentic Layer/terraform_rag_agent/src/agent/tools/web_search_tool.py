# Terraform-RAG-Model/src/agent/tools/web_search_tool.py
import os
from typing import Type, Optional, Any, List

from pydantic.v1 import BaseModel, Field, PrivateAttr # Import PrivateAttr

try:
    from tavily import TavilyClient
except ImportError:
    print("Tavily Python SDK not found. Please install it with `pip install tavily-python`")
    TavilyClient = None # Allows the class to be defined, but tool will be non-functional

from langchain_community.tools.tavily_search import TavilySearchResults
from pydantic import BaseModel, Field

from .base import BaseTool
from utils import get_rag_logger # Corrected absolute import for logger

logger = get_rag_logger(__name__)

class WebSearchToolInput(BaseModel):
    query: str = Field(description="The search query to send to the web search engine.")
    # Optional: Add other parameters like max_results_per_query if needed,
    # but agent should pass these if tool supports them explicitly in execute.
    # For now, max_results is a tool-level config.

class WebSearchTool(BaseTool):
    name: str = "web_search"
    description: str = (
        "Performs a web search using the Tavily API to find up-to-date information, "
        "answer general knowledge questions, or research topics not covered by other specialized tools. "
        "Useful for current events, technical questions beyond existing documentation, or exploring broader concepts."
    )
    args_schema: Type[BaseModel] = WebSearchToolInput

    # Declare as Pydantic fields
    api_key: Optional[str] = Field(None, description="API key for the Tavily search service.")
    max_results: int = Field(default=5, description="Maximum number of search results to return from Tavily API.")
    _client: Optional[Any] = PrivateAttr(default=None) # Use PrivateAttr

    def __init__(self, **kwargs: Any):
        """
        Initializes the WebSearchTool.
        The 'api_key' and 'max_results' are expected to be passed via kwargs if overriding defaults,
        and will be set by Pydantic during super().__init__(**kwargs).
        """
        super().__init__(**kwargs) # This will initialize api_key, max_results, name, description, args_schema

        if not TavilyClient:
            logger.error("❌ TavilyClient is not available (ImportError). WebSearchTool will not function.")
            # self._client is already None by default
            return

        if not self.api_key:
            # This means api_key was not provided via kwargs or was explicitly None.
            # The orchestrator is responsible for os.getenv("TAVILY_API_KEY") and passing it.
            logger.warning("⚠️ Tavily API key was not provided to WebSearchTool during initialization. WebSearchTool may not function.")
            # self._client remains None
        else:
            try:
                self._client = TavilyClient(api_key=self.api_key)
                logger.info(f"🛠️ {self.__class__.__name__} ({self.name}) initialized with TavilyClient. Default max results for search: {self.max_results}")
            except Exception as e:
                logger.error(f"❌ Failed to initialize TavilyClient: {e}")
                self._client = None # Ensure client is None on failure

    def _run(self, query: str, include_answer: bool = False, max_results: int = 5) -> str:
        """
        Executes the web search tool to find information on Tavily.
        """
        if not self._client:
            return "Error: WebSearchTool is not configured or TavilyClient failed to initialize (missing API key or other issue)."

        logger.info(f"🔎 Performing web search for: '{query}' with max_results={max_results}")
        try:
            # Tavily search_depth="advanced" can be explored later if needed.
            # For now, using basic search and the tool-level max_results.
            response = self._client.search(query=query, max_results=max_results)
            
            # Process results - response['results'] is a list of dicts
            # Example result keys: 'title', 'url', 'content', 'score', 'raw_content'
            if response and response.get("results"):
                formatted_results = []
                for i, res in enumerate(response["results"]):
                    formatted_results.append(
                        f"""Result {i+1}:
                            Title: {res.get('title', 'N/A')}
                            URL: {res.get('url', 'N/A')}
                            Snippet: {res.get('content', 'N/A')[:500]}..."""
                    )
                return "\n---\n".join(formatted_results)
            else:
                return "No results found or unexpected response format from Tavily."

        except Exception as e:
            logger.error(f"❌ Error during Tavily web search for '{query}': {e}", exc_info=True)
            return f"Error during web search: {e}"

if __name__ == '__main__':
    # Example Usage (requires TAVILY_API_KEY in environment or passed directly)
    print("--- WebSearchTool Example Usage ---")
    
    # Attempt to load .env if this script is run directly for testing
    try:
        from dotenv import load_dotenv
        # Assuming .env is in the project root, relative to this file's location
        # Terraform-RAG-Model/src/agent/tools/web_search_tool.py
        # Project root: Terraform-RAG-Model/../../.env => DeplAI/.env
        dotenv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.env'))
        if os.path.exists(dotenv_path):
            load_dotenv(dotenv_path=dotenv_path)
            print(f"Loaded .env from {dotenv_path} for standalone test.")
        else:
            print(f".env file not found at {dotenv_path} for standalone test.")
    except ImportError:
        print("python-dotenv not installed, cannot load .env for standalone test.")

    key = os.getenv("TAVILY_API_KEY")
    if not key:
        print("TAVILY_API_KEY not found in environment. Please set it to run this example.")
    else:
        print(f"Using TAVILY_API_KEY from environment for test.")
        try:
            search_tool = WebSearchTool(api_key=key, max_results=2) # Pass the key here
            
            # Test case 1: Valid query
            search_input_valid = WebSearchToolInput(query="What is the capital of France?")
            results_valid = search_tool._run(search_input_valid.query)
            print(f"Results for '{search_input_valid.query}':{results_valid}")

            # Test case 2: Another query
            search_input_tech = WebSearchToolInput(query="Latest advancements in large language models")
            results_tech = search_tool._run(search_input_tech.query)
            print(f"Results for '{search_input_tech.query}':{results_tech}")

        except Exception as e:
            print(f"An error occurred during the example: {e}")

    # Example of tool instantiation without API key (to see warning)
    print("--- Test instantiation without API key (expect warning) ---")
    search_tool_no_key = WebSearchTool() # api_key will be None
    # results_no_key = search_tool_no_key.execute(WebSearchToolInput(query="test"))
    # print(f"Execution result with no key: {results_no_key}") # Will show error message 