# Terraform-RAG-Model/src/agent/tools/base.py
from typing import Type, Optional, Any, Dict
from pydantic.v1 import BaseModel, Field # Use Pydantic v1 for compatibility

class BaseTool(BaseModel):
    name: str = Field(description="The unique name of the tool.")
    description: str = Field(description="A clear description of what the tool does, its purpose, and when to use it.")
    args_schema: Optional[Type[BaseModel]] = Field(
        default=None, 
        description="The Pydantic model defining the arguments this tool accepts. None if no arguments."
    )

    # Pydantic models handle their own __init__ based on defined fields.
    # We don't need a custom __init__ here if name, description, args_schema are fields.

    def execute(self, action_input: BaseModel | Dict[str, Any]) -> Any:
        """Executes the tool with the given, already validated, input.
        
        Args:
            action_input: The validated Pydantic model instance if args_schema is defined,
                          or a dictionary if no args_schema is defined or for simple cases.
                          Tools should ideally work with their specific input model type.
        """
        raise NotImplementedError(f"Tool '{self.name}' has not implemented the execute method.")

    def __str__(self) -> str:
        return f"Tool(name='{self.name}', description='{self.description}', args_schema='{self.args_schema.__name__ if self.args_schema else None}')"
    
    class Config:
        # Pydantic v1 config example: allow arbitrary types if needed for args_schema, though Type[BaseModel] is preferred
        # arbitrary_types_allowed = True 
        keep_model_attributes = True # Important for Pydantic v1 if using class vars as defaults for fields
        validate_assignment = True 