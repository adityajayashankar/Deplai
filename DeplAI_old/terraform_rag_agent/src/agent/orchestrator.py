import os
import json
import logging # Keep for initial setup if custom logger fails
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path
from datetime import datetime
import re

from .helper.s3_website_helper import unzip_website_files

# Attempt to import OpenAI, prompt if not found
try:
    from openai import OpenAI, APIError
    from openai.types.chat import ChatCompletionMessageParam, ChatCompletion
except ImportError:
    print("OpenAI library not found. Please install it: pip install openai")
    exit(1)

# Attempt to import dotenv, prompt if not found
try:
    from dotenv import load_dotenv, dotenv_values
except ImportError:
    print("python-dotenv library not found. Please install it: pip install python-dotenv")
    # Continue without it, assuming environment variables might be set manually
    pass

from pydantic.v1 import BaseModel, ValidationError # Use Pydantic v1 for compatibility
from utils.rag_logger import get_rag_logger # Absolute import for logger
from .prompts import get_react_system_prompt, format_react_user_prompt
from .tools.base import BaseTool # Relative import for tools.base
from .tools.echo_tool import EchoTool # Ensure EchoTool is correctly imported
from .tools.web_search_tool import WebSearchTool # Ensure WebSearchTool is correctly imported
from .tools.terraform_documentation_rag_tool import TerraformDocumentationRAGTool # Import new RAG tool
from .tools.code_generator import TerraformCodeGeneratorTool # Import new Code Generator tool
from .tools.terraform_validator import TerraformValidationTool # Import new Validator tool
from .tools.terraform_corrector import TerraformCodeCorrectorTool # Import new Corrector tool
from .tools.code_splitter import CodeSplitterTool # Import the new splitter tool
from .tools.documentation_generator import DocumentationGeneratorTool, DocumentationGeneratorToolInput # Import new Documentation Generator tool
from .planner import Planner, Plan # Import the new Planner
from langchain_core.runnables import Runnable
from langchain_openai import ChatOpenAI
from tavily import TavilyClient
# GithubDeployerTool is now invoked by a separate worker, not the orchestrator.
# from .tools.github_deployer import GithubDeployerTool 
from utils.llm_utils import get_llm, get_chat_llm
from utils.file_utils import save_artifacts

logger = get_rag_logger(__name__)

# --- Agent State ---
class AgentState(BaseModel):
    query: str
    max_iterations: int
    current_iteration: int = 0
    scratchpad: List[Dict[str, Any]] = [] # Stores thought, action, observation per step
    final_answer: Optional[str] = None
    error_message: Optional[str] = None
    hcl_context: List[str] = [] # To hold the context of previously generated code
    
    # For ReAct prompt formatting
    overall_goal: Optional[str] = None # The user's high-level objective
    current_task_focus: Optional[str] = None
    history: List[Dict[str, str]] = [] # For more complex conversational history if needed

    def add_step(self, thought: str, action_name: str, action_input: Dict, observation: str):
        self.scratchpad.append({
            "iteration": self.current_iteration,
            "thought": thought,
            "action_name": action_name,
            "action_input": action_input,
            "observation": observation
        })
        # Simple history update for the ReAct prompt
        self.history.append({"role": "assistant", "content": f"Thought: {thought}\nAction: {action_name}\nAction Input: {json.dumps(action_input)}"})
        self.history.append({"role": "user", "content": f"Observation: {observation}"})


    def get_full_scratchpad(self) -> str:
        output = ""
        for item in self.scratchpad:
            output += f"\nIteration {item['iteration']}:\n"
            output += f"Thought: {item['thought']}\n"
            output += f"Action: {item['action_name']}\n"
            output += f"Action Input: {json.dumps(item['action_input'])}\n"
            output += f"Observation: {item['observation']}\n"
        return output

    def get_react_prompt_messages(self, system_prompt: str) -> List[ChatCompletionMessageParam]:
        messages: List[ChatCompletionMessageParam] = [{"role": "system", "content": system_prompt}]
        
        # Add history to messages
        # For ReAct, the history is built by thought/action/observation cycles
        # The format_react_user_prompt will take care of structuring the latest user turn
        
        # The user prompt needs the overall goal and the formatted scratchpad (previous steps)
        user_prompt_content = format_react_user_prompt(
            initial_query=self.overall_goal or self.query, # Pass the overall goal
            current_task=self.current_task_focus or self.query, 
            scratchpad=self.get_formatted_scratchpad_for_prompt(),
            history=self.history # Pass the agent's history
        )
        messages.append({"role": "user", "content": user_prompt_content})
        return messages

    def get_formatted_scratchpad_for_prompt(self) -> str:
        if not self.scratchpad:
            return "No actions taken yet."
        
        formatted = ""
        for item in self.scratchpad:
            formatted += f"Iteration {item['iteration']}:\n"
            formatted += f"Thought: {item['thought']}\n"
            formatted += f"Action: {item['action_name']}\n"
            formatted += f"Action Input: {json.dumps(item['action_input'])}\n"
            formatted += f"Observation: {item['observation']}\n---\n"
        return formatted.strip()

    def get_history_as_string(self) -> str:
        return "\n".join([f"{m['role'].capitalize()}: {m['content']}" for m in self.history])

# --- Agent Orchestrator ---
class AgentOrchestrator:
    def __init__(self,
                 tools: List[BaseTool],
                 llm_model_name: str = "gpt-4.1",
                 max_iterations: int = 10,
                 max_retries_llm: int = 3
                ):
        self.llm_model_name = llm_model_name
        self.max_iterations = max_iterations
        self.max_retries_llm = max_retries_llm
        try:
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            logger.info("✔ OpenAI client initialized successfully.")
        except Exception as e:
            logger.error(f"❌ Failed to initialize OpenAI client: {e}")
            raise
        
        self.tools_map = {tool.name: tool for tool in tools}
        self.planner = Planner(llm_model_name=self.llm_model_name)
        self.system_prompt_template = get_react_system_prompt()
        self.available_tools_description_str = self._get_available_tools_message(list(self.tools_map.values()))
        
        logger.info(f"🧠 Agent Orchestrator initialized with model: {self.llm_model_name}.")
        logger.info(f"🛠️ Available tools: {', '.join(self.tools_map.keys())}")

    def _clean_hcl_from_llm_output(self, llm_output: str) -> str:
        """
        Cleans the HCL code block from the LLM's output.
        Handles markdown code blocks and other potential wrapping.
        """
        logger.debug(f"Cleaning LLM output: {llm_output}")
        if "```hcl" in llm_output:
            # Extracts content between ```hcl and ```
            try:
                return llm_output.split("```hcl")[1].split("```")[0].strip()
            except IndexError:
                # Fallback for malformed markdown
                return llm_output.replace("```hcl", "").replace("```", "").strip()
        # Fallback for outputs that might not use markdown
        return llm_output.strip()

    def _get_available_tools_message(self, tools: List[BaseTool]) -> str:
        if not tools:
            return "No tools available."
        tool_descriptions = []
        for tool in tools:
            schema_info = "No arguments"
            if tool.args_schema:
                try:
                    # For Pydantic v1
                    schema_info = json.dumps(tool.args_schema.schema(), indent=2)
                except Exception as e_schema: # pragma: no cover
                    logger.warning(f"Could not get schema for {tool.name}: {e_schema}")
            
            tool_descriptions.append(
                f"- Tool Name: \"{tool.name}\"\n"
                f"  Description: {tool.description}\n"
                f"  Input Schema (JSON):\n{schema_info}"
            )
        return "\n".join(tool_descriptions)

    def _reason(self, state: AgentState) -> Tuple[Optional[str], Optional[str], Optional[Dict[str, Any]], Optional[str]]:
        logger.info("🤔 Agent is reasoning...")

        # Format the system prompt with the current state and available tools
        # Add HCL context to the history for the prompt
        context_str = "\n".join(state.hcl_context)
        history_str = state.get_history_as_string()
        if context_str:
            history_str += f"\\n\\n--- HCL CONTEXT ---\\nHere is the HCL code that has been generated in previous steps. Use this as context for resource dependencies and naming.\\n\\n{context_str}\\n--- END HCL CONTEXT ---"

        system_prompt = self.system_prompt_template.format(
            overall_goal=state.overall_goal,
            history=history_str,
            current_task_focus=state.current_task_focus,
            tool_descriptions=self.available_tools_description_str
        )

        messages = state.get_react_prompt_messages(system_prompt=system_prompt)

        logger.debug(f"📜 Sending messages to LLM: {messages}")

        for attempt in range(self.max_retries_llm):
            try:
                response: ChatCompletion = self.client.chat.completions.create(
                    model=self.llm_model_name,
                    messages=messages,
                    temperature=0.0, # Low temperature for more deterministic ReAct
                    response_format={"type": "json_object"} # Requires compatible models
                )
                raw_llm_output = response.choices[0].message.content
                logger.debug(f"💬 Raw LLM Output: {raw_llm_output}")

                if not raw_llm_output:
                    raise ValueError("LLM returned empty content.")

                parsed_output = json.loads(raw_llm_output)
                thought = parsed_output.get("thought")
                action_details = parsed_output.get("action")

                if not thought or not action_details:
                    raise ValueError("LLM output missing 'thought' or 'action'.")

                action_name = action_details.get("name") # Correctly parse 'name'
                action_input = action_details.get("args", {}) # Correctly parse 'args'

                if not action_name:
                    raise ValueError("LLM action details missing 'name'.")

                return thought, action_name, action_input, None # No error

            except json.JSONDecodeError as e:
                error_msg = f"JSON parsing error from LLM output: {e}. Output: {raw_llm_output}"
                logger.error(f"❌ {error_msg}")
                if attempt == self.max_retries_llm - 1: return None, None, None, error_msg
            except (APIError, ValueError) as e:
                error_msg = f"Error interacting with LLM or processing output: {e}"
                logger.error(f"❌ {error_msg}")
                if attempt == self.max_retries_llm - 1: return None, None, None, error_msg
            
            logger.warning(f"Retrying LLM call ({attempt + 1}/{self.max_retries_llm})...")
        
        return None, None, None, "LLM interaction failed after multiple retries."


    def _act(self, action_name: str, action_input: Optional[Dict[str, Any]]) -> Tuple[str, bool]:
        logger.info(f"🎬 Attempting to execute action: '{action_name}' with input: {action_input if action_input else 'No input'}")
        if action_name == "FinalAnswer":
            answer = action_input.get("answer", "No answer provided by FinalAnswer action.") if action_input else "No answer detail."
            logger.info(f"🏁 FinalAnswer action recognized. Result: {answer}")
            return answer, True # True indicates it's a final answer

        tool = self.tools_map.get(action_name)
        if not tool:
            logger.error(f"❌ Action Error: Tool '{action_name}' not found.")
            return f"Error: Tool '{action_name}' not found. Available tools: {', '.join(self.tools_map.keys())}", False

        try:
            # More robust tool calling logic
            args_to_pass = {}
            if tool.args_schema:
                # If input is provided, validate it and convert to dict for unpacking
                if action_input:
                    validated_model = tool.args_schema(**action_input)
                    args_to_pass = validated_model.dict()
                else:
                    # Let the tool handle default empty invocation, it will raise
                    # a ValidationError if required fields are missing, which is caught below.
                    validated_model = tool.args_schema()
                    args_to_pass = validated_model.dict()
            elif action_input:
                # For tools without a schema, pass the input dict directly
                args_to_pass = action_input

            # Call the tool's run method by unpacking the arguments
            observation = tool._run(**args_to_pass)

            logger.info(f"👁️‍🗨️ Observation from '{action_name}': {observation[:200] + '...' if len(observation) > 200 else observation}")
            return str(observation), False

        except ValidationError as e:
            error_msg = f"Input validation error for tool '{action_name}': {e}"
            logger.error(f"❌ {error_msg}")
            return f"Error: {error_msg}", False
        except Exception as e:
            error_msg = f"Error executing tool '{action_name}': {e}"
            logger.error(f"❌ {error_msg}", exc_info=True) # Log full traceback for unexpected tool errors
            return f"Error: {error_msg}", False

    def _assemble_code(self, generated_artifacts: Dict[str, str], plan: Plan) -> str:
        """Assembles the final HCL code from artifacts in the correct order."""
        # Order artifacts based on the original plan's resource dependency
        ordered_code_blocks = []
        for resource in plan.resources:
            code = generated_artifacts.get(resource.name)
            if code:
                ordered_code_blocks.append(code)
            else:
                logger.warning(f"Could not find generated code for resource: {resource.name}")
        
        return "\n\n".join(ordered_code_blocks)

    def _execute_step(self, step_query: str, max_iterations: int, overall_goal: str, context_history: List[str]) -> AgentState:
        """
        Executes a single step of the plan using the ReAct loop.
        """
        state = AgentState(
            query=step_query, 
            max_iterations=max_iterations,
            overall_goal=overall_goal, # Set the overall goal
            current_task_focus=step_query,
            hcl_context=context_history # Pass the context here
        )
        # Inject the context from previous steps
        if context_history:
            history_str = "\n".join(context_history)
            state.history.append({"role": "system", "content": f"You have already completed the following steps:\n{history_str}"})


        logger.info(f"▶️  Executing step: '{step_query}'")

        for i in range(max_iterations):
            state.current_iteration = i + 1
            logger.info(f"🔄 Iteration {state.current_iteration}/{max_iterations} for step: '{step_query}'")

            thought, action_name, action_input, error = self._reason(state)

            if error:
                state.error_message = f"Reasoning error in step: {error}"
                break
            
            if not thought or not action_name:
                state.error_message = "Agent failed to produce a thought or action for the step."
                break

            logger.debug(f"🤔 Thought: {thought}")
            logger.info(f"💡 Planned Action: {action_name}, Input: {action_input}")
            
            observation, is_final = self._act(action_name, action_input)
            
            state.add_step(thought, action_name, action_input or {}, observation)
            
            if is_final:
                state.final_answer = observation
                logger.info(f"✅ Step finished with final answer.")
                break
        
        if not state.final_answer and not state.error_message:
            state.final_answer = "Step finished without a conclusive answer."

        return state


    def run(self, query: str, max_iterations_per_step: int = 5, user_code_path: Optional[str] = None, upload_type: Optional[str] = None, project_name: Optional[str] = None) -> dict:
        """
        Main entry point for the agent orchestrator.
        It takes a user query, generates a plan, executes each step of the plan,
        and finally saves the generated artifacts.

        Args:
            query: The natural language query from the user.
            max_iterations_per_step: The maximum number of ReAct loops for each step.
            user_code_path: The local filesystem path to the user's uploaded code.
            upload_type: The type of code uploaded (e.g., 'S3 Static Website').
            project_name: The name of the project.

        Returns:
            A dictionary containing the final answer and status.
        """
        logger.info(f"🚀 Starting agent run for high-level query: '{query}'")
        s3_file_list = None
        
        if upload_type == 'S3 Static Website':
            if user_code_path and project_name:
                logger.info(f"S3 Static Website deployment detected. Unzipping '{user_code_path}'.")
                try:
                    # The user_code_path from the worker is the path to the saved zip file.
                    # We can now pass it directly to the refactored helper function.
                    unzipped_dir, file_list = unzip_website_files(user_code_path, project_name)
                    user_code_path = unzipped_dir # This now points to the directory of unzipped files
                    s3_file_list = file_list
                    logger.info(f"S3 code unzipped to '{user_code_path}'. Files: {s3_file_list}")
                except Exception as e:
                    logger.error(f"❌ Failed to unzip S3 website assets: {e}", exc_info=True)
                    return {"error": f"Failed to process S3 website .zip file: {e}", "final_answer": None}
            else:
                logger.error("❌ S3 deployment requires a code path and project name.")
                return {"error": "S3 deployment requires a code path and project name.", "final_answer": None}
        elif user_code_path:
            logger.info(f"👨‍💻 User has provided an application code file: {user_code_path}")

        try:
            plan = self.planner.generate_plan(query, user_code_path=user_code_path, s3_file_list=s3_file_list)
            if not plan:
                return {"error": "Failed to generate a plan.", "final_answer": None}
            logger.info(f"📝 Plan generated successfully. Summary: {plan.summary}")
            logger.info(f"🗒️ Plan Details:\n{json.dumps(plan.dict(), indent=2)}")
        except Exception as e:
            logger.error(f"❌ Critical error during planning phase: {e}")
            return {"error": f"Critical error during planning phase: {e}", "final_answer": None}
        
        generated_hcl = {}
        final_generated_code = ""
        final_state = None
        validation_result = "Validation not yet run."

        max_correction_loops = 5
        for attempt in range(max_correction_loops):
            logger.info(f"--- 🔄 Code Generation & Validation Cycle: Attempt {attempt + 1}/{max_correction_loops} ---")

            # --- Code Generation Phase (only on first attempt) ---
            if attempt == 0:
                logger.info("🎬 Starting execution stage based on the generated plan...")
                context_so_far = []
                for i, resource in enumerate(plan.resources):
                    logger.info(f"--- Executing Plan Step {i+1}/{len(plan.resources)} for resource '{resource.name}' ---")
                    
                    step_prompt = f"Generate the Terraform HCL code for the resource '{resource.name}' of type '{resource.resource_type}'. The configuration should be: {resource.description}."
                    
                    # Execute the ReAct loop for this step
                    step_state = self._execute_step(
                        step_query=step_prompt,
                        max_iterations=max_iterations_per_step,
                        overall_goal=query,
                        context_history=context_so_far
                    )
                    
                    if step_state.final_answer:
                        code_for_resource = self._clean_hcl_from_llm_output(step_state.final_answer)
                        generated_hcl[resource.name] = code_for_resource
                        # HISTORY PRUNING: Add a concise note instead of the full code to keep context small.
                        context_so_far.append(f"Note: Terraform code for resource '{resource.name}' ({resource.resource_type}) has been generated and stored.")
                        logger.info(f"✅ Successfully generated HCL for '{resource.name}' and pruned history.")
                    else:
                        logger.error(f"❌ Failed to generate code for resource '{resource.name}'. Aborting run.")
                        return {
                            "error": f"Failed to generate code for resource '{resource.name}'.",
                            "final_answer": "Aborted due to code generation failure.",
                            "generated_code": self._assemble_code(generated_hcl, plan),
                            "full_scratchpad": step_state.get_full_scratchpad()
                        }
                
                final_resource_code = self._assemble_code(generated_hcl, plan)

                # --- Variable and Output Generation ---
                variable_code_blocks = []
                if plan.variables:
                    logger.info(f"--- 📝 Generating {len(plan.variables)} Variables ---")
                    var_gen_tool = self.tools_map.get('variable_generator')
                    if var_gen_tool:
                        for var in plan.variables:
                            try:
                                var_code = var_gen_tool._run(name=var.name, description=var.description, type=var.type, default=var.default)
                                variable_code_blocks.append(var_code)
                            except Exception as e:
                                logger.error(f"Failed to generate variable '{var.name}': {e}")
                    else:
                        logger.warning("⚠️ VariableGeneratorTool not found. Skipping variable generation.")

                output_code_blocks = []
                if plan.outputs:
                    logger.info(f"--- 📝 Generating {len(plan.outputs)} Outputs ---")
                    out_gen_tool = self.tools_map.get('output_generator')
                    if out_gen_tool:
                        for out in plan.outputs:
                            try:
                                out_code = out_gen_tool._run(name=out.name, description=out.description, value=out.value)
                                output_code_blocks.append(out_code)
                            except Exception as e:
                                logger.error(f"Failed to generate output '{out.name}': {e}")
                    else:
                        logger.warning("⚠️ OutputGeneratorTool not found. Skipping output generation.")
                
                # --- Assemble Final Code ---
                final_generated_code = final_resource_code
                if variable_code_blocks:
                    final_generated_code += "\n\n" + "\n\n".join(variable_code_blocks)
                if output_code_blocks:
                    final_generated_code += "\n\n" + "\n\n".join(output_code_blocks)

            # --- Validation Phase ---
            logger.info("--- ⚙️ Final Validation Stage ---")
            logger.info(f"📜 Final Generated Code for Validation:\n{final_generated_code}")
            
            validator_tool = self.tools_map.get('terraform_validator')
            if not validator_tool:
                return {"error": "TerraformValidationTool not found.", "final_answer": None}

            validation_result = validator_tool._run(
                code=final_generated_code,
                user_code_path=user_code_path
            )
            is_valid = validation_result.get("valid", False)
            validation_message = validation_result.get("error_message", "No validation message.")

            logger.info(f"🧐 Validation Result: {validation_message if not is_valid else '✅ Terraform code is valid.'}")
            
            # --- Decision & Correction Phase ---
            if is_valid:
                logger.info("✅ Initial code validation successful. Proceeding to split files.")
                
                # --- Code Splitting Phase ---
                splitter_tool = self.tools_map.get('code_splitter')
                if not splitter_tool:
                    logger.error("❌ CodeSplitterTool not found. Cannot proceed.")
                    # Safely append to the error message
                    current_error = validation_result.get("error_message") or ""
                    new_error = "Error: CodeSplitterTool not found."
                    validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                    break

                try:
                    split_hcl_code = splitter_tool._run(hcl_code=final_generated_code)
                    if not isinstance(split_hcl_code, dict) or not split_hcl_code:
                        logger.error("❌ Code splitting failed to produce a valid dictionary.")
                        current_error = validation_result.get("error_message") or ""
                        new_error = "Error: Code splitting failed to produce a valid dictionary."
                        validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                        break
                    logger.info(f"✅ Code successfully split into files: {list(split_hcl_code.keys())}")
                except Exception as e:
                    logger.error(f"❌ An exception occurred during code splitting: {e}", exc_info=True)
                    current_error = validation_result.get("error_message") or ""
                    new_error = f"An exception occurred during code splitting: {e}"
                    validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                    break
                
                # --- Final Validation on Split Files ---
                logger.info("--- ⚙️ Final Validation on Split Files ---")
                validation_result_split = validator_tool._run(
                    code=split_hcl_code,
                    user_code_path=user_code_path
                )
                is_valid_split = validation_result_split.get("valid", False)

                if not is_valid_split:
                    logger.error("❌ Validation failed on the split files. Aborting.")
                    validation_result = validation_result_split # Use the more specific error
                    # We could trigger another correction loop here, but for now, we'll abort.
                    break

                logger.info("✅ Split code passed final validation. Agent run successful.")

                # --- Documentation Generation ---
                readme_content = "# Documentation generation was skipped."
                if self.tools_map.get('documentation_generator'):
                    logger.info("📄 Generating documentation for the final code...")
                    doc_gen_tool = self.tools_map['documentation_generator']
                    readme_content = doc_gen_tool._run(
                        hcl_code=final_generated_code, # Use the full code for context
                        plan_summary=plan.summary,
                        original_goal=query
                    )
                    logger.info("✅ Documentation generated successfully.")
                else:
                    logger.warning("No documentation generator tool found. Skipping README generation.")
                
                # --- Save Final Artifacts ---
                output_dir = save_artifacts(
                    plan=plan,
                    split_hcl_code=split_hcl_code,
                    readme_content=readme_content,
                    user_code_path=user_code_path
                )
                logger.info(f"✅ Successfully saved artifacts to: {output_dir}")

                if not final_state:
                    final_state = AgentState(query=query, max_iterations=0)

                final_state.final_answer = {
                    "status": "SUCCESS",
                    "message": f"Successfully generated and validated Terraform code. Artifacts saved to {output_dir}",
                    "artifacts": split_hcl_code,
                    "output_path": output_dir
                }
                break  # Exit the correction loop
            else:
                logger.warning("❌ Validation failed. Attempting self-correction...")
                
                if attempt + 1 == max_correction_loops:
                    logger.error("❌ Maximum correction attempts reached. Aborting.")
                    break # Break after last attempt

                # --- Self-Correction Step ---
                corrector_tool = self.tools_map.get('terraform_code_corrector')
                if not corrector_tool:
                    logger.error("❌ TerraformCodeCorrectorTool not found. Aborting.")
                    current_error = validation_result.get("error_message") or ""
                    new_error = "Correction attempt failed: Corrector tool not available."
                    validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                    break

                logger.info("🤖 Engaging self-correction mechanism...")
                try:
                    # Step 1: Generate a high-level plan to fix the error.
                    fix_plan = self.planner.generate_fix_plan(
                        original_goal=query,
                        invalid_code=final_generated_code,
                        error_message=validation_message
                    )
                    
                    if not fix_plan:
                        logger.error("❌ Failed to generate a fix plan. Aborting correction.")
                        current_error = validation_result.get("error_message") or ""
                        new_error = "Correction attempt failed: Could not generate a fix plan."
                        validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                        break
                    
                    logger.info(f"📝 Generated Fix Plan:\n---\n{fix_plan}\n---")

                    # Step 2: Execute the correction using the generated plan.
                    corrected_code = corrector_tool._run(
                        invalid_hcl_code=final_generated_code,
                        error_message=validation_message,
                        original_goal=query,
                        fix_plan=fix_plan
                    )

                    if "Error: Could not correct code." not in corrected_code:
                        final_generated_code = self._clean_hcl_from_llm_output(corrected_code)
                        logger.info("✅ Self-correction generated a new version of the code. Re-validating in next loop iteration...")
                    else:
                        logger.error("❌ Self-correction failed to produce a result. Aborting.")
                        current_error = validation_result.get("error_message") or ""
                        new_error = f"Correction attempt failed: {corrected_code}"
                        validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                        break # Exit loop if correction fails
                except Exception as e:
                    logger.error(f"❌ An exception occurred during self-correction: {e}", exc_info=True)
                    # Safely append to the string message
                    current_error = validation_result.get("error_message") or ""
                    new_error = f"An exception occurred during self-correction: {e}"
                    validation_result["error_message"] = f"{current_error}\\n\\n{new_error}".strip()
                    break

        # This block now correctly reports the final state after the loop
        final_answer_summary = "Agent run finished."
        if final_state and "SUCCESS" in final_state.final_answer.get("status", ""):
             final_answer_summary = "Agent run finished, and the code is VALID."
        else:
            final_answer_summary = "Agent run finished, but the code is NOT valid."
            if not final_state:
                final_state = AgentState(query=query, max_iterations=0)
            final_state.final_answer = {
                "status": "FAILURE",
                "message": final_answer_summary,
                "artifacts": {},
                "output_path": ""
            }


        logger.info(f"🏁 {final_answer_summary}")
        if final_generated_code:
            print("\n--- Generated Terraform Code ---\n")
            print(final_generated_code)

        # Final return structure
        return {
            "final_answer": final_state.final_answer,
            "generated_code": final_generated_code,
            "validation_result": validation_result,
            "full_scratchpad": final_state.get_full_scratchpad() if final_state else "No execution steps were run."
        }

# --- Test Functions (defined at module level) ---
def run_web_search_test_example(
    query: str = "What were the key announcements at the last OpenAI DevDay? Summarize the top 2.",
    max_iterations: int = 5,
    log_file_path: Optional[str] = None,
    tavily_api_key_from_dotenv: Optional[str] = None,
    hf_token_from_dotenv: Optional[str] = None
):
    """
    Example function to run the orchestrator with a web search query.
    """
    if log_file_path:
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
        with open(log_file_path, 'a') as f:
            f.write(f"--- Test Run Start (Web Search): {query} ---\n")
        logger.info(f"Logging web search test to: {log_file_path}")

    logger.info(f"🚀 Starting Web Search example run with query: \"{query}\"")

    if hf_token_from_dotenv:
        os.environ['HF_TOKEN'] = hf_token_from_dotenv
        logger.info(f"[DEBUG WebSearchTest] HUGGING_FACE_HUB_TOKEN (HF_TOKEN) set in environment: '{hf_token_from_dotenv[:5]}...'")
    else:
        logger.warning("[DEBUG WebSearchTest] HUGGING_FACE_HUB_TOKEN not directly passed, sentence-transformers will use anonymous access or its own cache.")
    
    echo_tool = EchoTool()
    
    if not tavily_api_key_from_dotenv:
        logger.warning("⚠️ TAVILY_API_KEY not directly passed to run_web_search_test_example. WebSearchTool may not function.")
    web_search_tool = WebSearchTool(api_key=tavily_api_key_from_dotenv, max_results=3)
    tools_list: List[BaseTool] = [echo_tool, web_search_tool]

    openai_api_key = os.getenv("OPENAI_API_KEY") 
    if not openai_api_key:
        logger.error("❌ OPENAI_API_KEY not found. Orchestrator cannot function.")
        print("ERROR: OPENAI_API_KEY not found. Please set it in your .env or environment.")
        return

    orchestrator = AgentOrchestrator(
        api_key=openai_api_key,
        llm_model_name="gpt-4.1",
        tools=tools_list,
        max_retries_llm=2
    )

    agent_result = orchestrator.run(query, max_iterations_per_step=max_iterations)
    final_answer = agent_result.get("final_answer", "No final answer reached.")
    logger.info(f"🏁 Web Search Agent run finished. Final answer: {final_answer}")
    
    result_summary = f"Agent Final Result for query '{query}':\n{final_answer}"
    print("\n" + "="*70)
    print(result_summary)
    print("="*70 + "\n")

    if log_file_path:
        with open(log_file_path, 'a') as f:
            f.write(f"--- Test Run End (Web Search). Final Answer: {final_answer} ---\n")

def run_rag_test_example(
    query: str = "Create an `aws_instance` named 'web_server'. For the `ami` attribute, use `var.aws_ami`. Do not define the variable.",
    max_iterations: int = 5,
    log_file_path: Optional[str] = None,
    tavily_api_key_from_dotenv: Optional[str] = None,
    hf_token_from_dotenv: Optional[str] = None
):
    """
    Initializes and runs the AgentOrchestrator with a predefined RAG-focused toolset
    and a sample query designed to test the full pipeline, including self-correction.
    """
    # Initialize tools
    echo_tool = EchoTool()
    
    # Configure RAG Tool
    db_path = str(Path(__file__).parents[2] / 'data' / 'vector_db')
    collection_name = "aws_provider_docs"
    logger.info(f"Terraform RAG Tool configured with DB path: '{db_path}' and collection: '{collection_name}'")
    try:
        # Pass the Hugging Face token to the RAG tool if available
        rag_tool = TerraformDocumentationRAGTool(
            db_path=db_path,
            collection_name=collection_name,
            hf_token=hf_token_from_dotenv
        )
    except Exception as e:
        logger.error(f"Failed to initialize TerraformDocumentationRAGTool: {e}")
        return

    # Configure Web Search Tool
    try:
        # Pass the Tavily API key to the web search tool if available
        web_search_tool = WebSearchTool(api_key=tavily_api_key_from_dotenv)
    except Exception as e:
        logger.error(f"Failed to initialize WebSearchTool: {e}")
        return
        
    code_generator_tool = TerraformCodeGeneratorTool()
    validator_tool = TerraformValidationTool()
    corrector_tool = TerraformCodeCorrectorTool(rag_tool=rag_tool, web_search_tool=web_search_tool)
    doc_gen_tool = DocumentationGeneratorTool()

    # Add other tools to the list
    tools = [echo_tool, rag_tool, web_search_tool, code_generator_tool, validator_tool, corrector_tool, doc_gen_tool]
    logger.info(f"🛠️ All tools configured: {[tool.name for tool in tools]}")

    # Initialize Orchestrator
    try:
        agent_orchestrator = AgentOrchestrator(
            tools=tools,
            llm_model_name="gpt-4.1",
            max_iterations=max_iterations
        )
        logger.info(f"✅ Agent Orchestrator initialized successfully.")

        # Run the agent
        final_result = agent_orchestrator.run(query=query)

        # 4. Display Final Result
        final_answer_dict = final_result.get("final_answer", {})
        if isinstance(final_answer_dict, str): # Handle case where final_answer is just a string
            final_answer_dict = {"message": final_answer_dict}
            
        final_code = final_result.get("generated_code", "Agent did not produce final code.")
        readme_content = final_result.get("readme", "")
        output_path = final_result.get("output_path", "")

        logger.info(f"🏁 RAG Agent run finished. Final code generated.")
        
        # A simple separator for console output
        result_separator = "="*70
        
        if final_code:
            print(f"\n{result_separator}")
            print("Generated Terraform Code:")
            print(final_code)
            print(f"{result_separator}\n")

        if readme_content:
            print(f"\n{result_separator}")
            print("Generated README.md:")
            print(readme_content)
            print(f"{result_separator}\n")

        if output_path:
            print(f"\n{result_separator}")
            print(f"✅ Artifacts saved to: {output_path}")
            print(f"{result_separator}\n")

        return final_answer_dict

    except Exception as e:
        logger.error(f"❌ Failed to run RAG test: {e}", exc_info=True)
        return "RAG test failed. Check the detailed logs for more information."


def main():
    """
    Main entry point for the script.
    Loads environment variables and runs a selected test example.
    """
    # Find the project root by looking for the .env file
    project_root = Path(__file__).resolve().parent.parent.parent
    dotenv_path = project_root / '.env'

    if dotenv_path.exists():
        load_dotenv(dotenv_path=dotenv_path)
        print(f"📄 Successfully loaded .env file from: {dotenv_path}")
    else:
        print(f"⚠️ Warning: .env file not found at {dotenv_path}. Environment variables should be set manually.")

    # Load required keys from environment for pre-check
    openai_api_key = os.getenv("OPENAI_API_KEY")
    tavily_api_key = os.getenv("TAVILY_API_KEY")
    hf_token = os.getenv("HUGGING_FACE_HUB_TOKEN")

    if not openai_api_key:
        logger.error("❌ OPENAI_API_KEY not found in environment. Cannot proceed.")
    else:
        logger.info("✔ OPENAI_API_KEY loaded.")

    if not tavily_api_key:
        logger.warning("⚠️ TAVILY_API_KEY not found. Web search tool will be disabled.")
    else:
        logger.info("✔ TAVILY_API_KEY loaded.")
    
    if not hf_token:
        logger.warning("⚠️ HUGGING_FACE_HUB_TOKEN not found. RAG tool may fail if embedding model needs auth.")
    else:
        logger.info("✔ HUGGING_FACE_HUB_TOKEN loaded.")

    # --- Run a specific test example ---
    print("\n" + "--- CONFIGURING AND RUNNING RAG TEST ---")
    run_rag_test_example(
        query="Create an `aws_instance` named 'web_server'. For the `ami` attribute, use `var.aws_ami`. Do not define the variable.",
        tavily_api_key_from_dotenv=tavily_api_key,
        hf_token_from_dotenv=hf_token
    )
    
    print("\n✅ Main script execution finished. Check specified log files in 'logs/tests' for detailed logs.")


if __name__ == "__main__":
    main() 