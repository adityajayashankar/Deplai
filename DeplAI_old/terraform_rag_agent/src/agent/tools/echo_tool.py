from typing import Type
from pydantic.v1 import BaseModel, Field

from .base import BaseTool
from utils.rag_logger import get_rag_logger

logger = get_rag_logger(__name__)

class EchoToolInput(BaseModel):
    message: str = Field(description="The message to echo back.")

class EchoTool(BaseTool):
    # Pydantic will use these class attributes as default values for the fields
    # inherited from BaseTool, because BaseTool.Config has keep_model_attributes = True.
    name: str = "echo_tool"
    description: str = "A simple tool that echoes back the input message. Useful for testing."
    args_schema: Type[BaseModel] = EchoToolInput

    def __init__(self, **kwargs):
        # Pass kwargs to Pydantic BaseModel __init__.
        # This allows any Pydantic field (including those from BaseTool like name, description)
        # to be potentially overridden at instantiation if needed, though we rely on class vars here.
        super().__init__(**kwargs) 
        logger.info(f"🛠️ {self.__class__.__name__} ({self.name}) initialized.")

    def execute(self, action_input: EchoToolInput) -> str:
        logger.info(f"📣 Echoing message: '{action_input.message}'")
        return action_input.message

if __name__ == '__main__':
    # Example usage (for testing the tool directly)
    import logging
    logging.basicConfig(level=logging.INFO)
    # Ensure our tool's logger is also set to INFO for this direct test if it wasn't already.
    # logger = get_rag_logger(__name__, level=logging.INFO) # Re-getting might create issues, better to set level
    logger.setLevel(logging.INFO)

    echo_tool = EchoTool()
    print(f"Tool details: {echo_tool}")
    test_input = EchoToolInput(message="Hello, world! This is a test of the EchoTool.")
    result = echo_tool.execute(test_input)
    print(f"Input to EchoTool: {test_input.message}")
    print(f"Output from EchoTool: {result}")

    test_input_2 = EchoToolInput(message="Another test!")
    result_2 = echo_tool.execute(test_input_2)
    print(f"Input to EchoTool: {test_input_2.message}")
    print(f"Output from EchoTool: {result_2}") 