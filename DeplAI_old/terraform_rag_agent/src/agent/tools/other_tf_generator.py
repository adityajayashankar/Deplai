from .base import BaseTool
from pydantic.v1 import BaseModel, Field
import json

class VariableGeneratorInput(BaseModel):
    name: str = Field(description="The name of the variable.")
    description: str = Field(description="The description for the variable.")
    type: str = Field(description="The Terraform type of the variable (e.g., 'string', 'number').")
    default: str = Field(description="The default value for the variable, as a string.")

class VariableGeneratorTool(BaseTool):
    name: str = "variable_generator"
    description: str = "Generates a single Terraform variable block as HCL code."
    args_schema = VariableGeneratorInput

    def _run(self, name: str, description: str, type: str, default: str) -> str:
        # Defaults need to be quoted if they are strings
        default_value_str = json.dumps(default)
        
        return f'''variable "{name}" {{
  description = "{description}"
  type        = {type}
  default     = {default_value_str}
}}'''

class OutputGeneratorInput(BaseModel):
    name: str = Field(description="The name of the output.")
    description: str = Field(description="The description for the output.")
    value: str = Field(description="The Terraform expression for the output's value (e.g., 'aws_instance.main.id').")

class OutputGeneratorTool(BaseTool):
    name: str = "output_generator"
    description: str = "Generates a single Terraform output block as HCL code."
    args_schema = OutputGeneratorInput

    def _run(self, name: str, description: str, value: str) -> str:
        # Sanitize the value to remove the deprecated interpolation syntax if present
        if value.strip().startswith("${") and value.strip().endswith("}"):
            value = value.strip()[2:-1].strip()

        return f'''output "{name}" {{
  description = "{description}"
  value       = {value}
}}'''