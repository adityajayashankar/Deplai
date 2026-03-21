import json
from typing import Dict, List, Optional, Tuple
import streamlit as st # For st.error, st.warning - consider refactoring to remove direct UI calls
from openai import OpenAI

from logger import setup_logger
from redis_cache import get_cache, set_cache, generate_cache_key

logger = setup_logger(name="AIHelpers")

def get_ai_response(client_info, prompt, system_message, response_format: Optional[Dict] = None) -> Tuple[Optional[str], Optional[str]]:
    try:
        if client_info and client_info["type"] == "openai" and client_info["client"]:
            logger.debug(f"Sending prompt to OpenAI: {prompt[:100]}... System: {system_message[:100]}... Format: {response_format}")
            
            completion_args = {
                "model": "gpt-4.1",
                "messages": [
                    {"role": "system", "content": system_message},
                    {"role": "user", "content": prompt}
                ]
            }
            if response_format:
                completion_args["response_format"] = response_format
                
            response = client_info["client"].chat.completions.create(**completion_args)
            response_content = response.choices[0].message.content
            logger.debug(f"Received response from OpenAI: {response_content[:100]}...")
            return response_content, None
        else:
            logger.warning("OpenAI client not initialized or invalid in get_ai_response.")
            return None, "OpenAI client not initialized or invalid. Please check your API key."
    except Exception as e:
        logger.error(f"OpenAI API Error in get_ai_response: {e}", exc_info=True)
        return None, str(e)

def ai_determine_question_count(client_info, project_details: Dict[str, str]) -> int:
    default_question_count = 10
    cache_key_prefix = "q_count"
    cache_key = generate_cache_key(cache_key_prefix, project_details)
    cached_result = get_cache(cache_key)
    if cached_result is not None and isinstance(cached_result, dict) and "count" in cached_result:
        logger.info(f"Cache HIT for question count ({cache_key_prefix}): {cached_result['count']}")
        return cached_result["count"]
    
    project_title = project_details.get("title", "N/A")
    project_description = project_details.get("description", "N/A")

    if project_description == "N/A" or not project_description.strip():
        logger.warning("Project description is empty in ai_determine_question_count. Defaulting question count.")
        set_cache(cache_key, {"count": default_question_count}, 86400)
        return default_question_count

    prompt = f"Based on the following project description, determine the optimal number of clarifying questions to ask. Project Title: {project_title}. Description: {project_description}. Respond with an integer number only."
    system_message = "You are an expert in project analysis. Your task is to estimate the number of questions needed to fully understand project requirements. Provide only a single integer."
    
    logger.info(f"Cache MISS for question count ({cache_key_prefix}). Calling AI.")
    response_content, error = get_ai_response(client_info, prompt, system_message)

    if error:
        logger.error(f"Failed to determine question count from AI: {error}. Using default count {default_question_count}.")
        set_cache(cache_key, {"count": default_question_count}, 86400)
        return default_question_count

    try:
        determined_count = int(response_content.strip())
        set_cache(cache_key, {"count": determined_count}, 86400)
        logger.info(f"AI determined question count: {determined_count}. Cached with key {cache_key_prefix}.")
        return determined_count
    except ValueError:
        logger.error(f"AI returned a non-integer value for question count: '{response_content}'. Using default count {default_question_count}.")
        set_cache(cache_key, {"count": default_question_count}, 86400)
        return default_question_count

def get_next_question(client_info, project_details, previous_questions, previous_answers) -> Tuple[Optional[str], Optional[str]]:
    cache_key_prefix = "next_q"
    cache_input_data = {
        "project_details": project_details,
        "previous_questions": previous_questions,
        "previous_answers": previous_answers
    }
    cache_key = generate_cache_key(cache_key_prefix, cache_input_data)
    cached_result = get_cache(cache_key)
    if cached_result is not None and isinstance(cached_result, dict) and "question" in cached_result:
        logger.info(f"Cache HIT for next question ({cache_key_prefix}).")
        return cached_result["question"], None

    logger.info(f"Cache MISS for next question ({cache_key_prefix}). Calling AI.")
    project_title = project_details.get("title", "N/A")
    project_description = project_details.get("description", "N/A")
    # Get the selected provider, default to AWS if not present
    provider = project_details.get("provider", "AWS").upper()

    context = f"Project Title: {project_title}\nProject Description: {project_description}\n\n"
    if previous_questions and previous_answers and len(previous_questions) == len(previous_answers):
        context += "Previous Questions and Answers:\n"
        for i, (q, a) in enumerate(zip(previous_questions, previous_answers)):
            context += f"{i+1}. Question: {q}\n   Answer: {a}\n"
    context += f"\nBased on this, what is the most important next question to ask to clarify the requirements for an {provider} architecture?"

    system_message = (f"You are a cloud architect specializing in {provider}. Your goal is to ask clarifying questions to design an {provider} architecture. "
                      "Ask only one concise question at a time. Do not provide preambles or explanations.")
    response_text, error = get_ai_response(client_info, context, system_message)

    if error:
        logger.error(f"AI error getting next question: {error}")
        return None, error

    if response_text:
        next_q = response_text.strip()
        set_cache(cache_key, {"question": next_q}, 86400)
        logger.info(f"AI generated next question. Cached with key {cache_key_prefix}.")
        return next_q, None
    else:
        logger.warning("AI did not provide a next question in get_next_question.")
        return None, "AI did not provide a response."

def analyze_requirements(client_info, project_details, questions, answers) -> Tuple[Optional[str], Optional[str]]:
    cache_key_prefix = "analysis_summary"
    cache_input_data = {
        "project_details": project_details,
        "questions": questions,
        "answers": answers
    }
    cache_key = generate_cache_key(cache_key_prefix, cache_input_data)
    cached_result = get_cache(cache_key)
    if cached_result is not None and isinstance(cached_result, dict) and "summary" in cached_result:
        logger.info(f"Cache HIT for requirements analysis ({cache_key_prefix}).")
        return cached_result["summary"], None

    logger.info(f"Cache MISS for requirements analysis ({cache_key_prefix}). Calling AI.")
    project_title = project_details.get("title", "N/A")
    project_description = project_details.get("description", "N/A")
    other_details = project_details.get("other_details", "")
    provider = project_details.get("provider", "AWS").upper()

    detailed_prompt = f"Project Title: {project_title}\nProject Description: {project_description}\n"
    if other_details:
        detailed_prompt += f"Other Details: {other_details}\n"
    detailed_prompt += "\nFull Q&A Log:\n"
    for i, (q, a) in enumerate(zip(questions, answers)):
        detailed_prompt += f"{i+1}. Question: {q}\n   Answer: {a}\n"
    detailed_prompt += f"\nBased on all the information provided, generate a comprehensive summary of the project requirements for designing an {provider} architecture. Highlight key technical needs, constraints, and goals."

    system_message = (f"You are an expert {provider} cloud architect. Your task is to synthesize project information into a requirements summary. "
                      "Focus on technical aspects relevant to architecture design. Be thorough and clear.")
    summary_text, error = get_ai_response(client_info, detailed_prompt, system_message)

    if error:
        logger.error(f"AI error analyzing requirements: {error}")
        return None, error

    if summary_text:
        set_cache(cache_key, {"summary": summary_text}, 86400)
        logger.info(f"AI generated requirements analysis. Cached with key {cache_key_prefix}.")
        return summary_text, None
    else:
        logger.warning("AI did not provide an analysis summary in analyze_requirements.")
        return None, "AI did not provide a response for analysis."

def generate_architecture_prompt(client_info, project_details, questions, answers) -> str:
    # This function formats the prompt; it does not call an LLM directly.
    # No caching needed here as it's deterministic based on inputs.
    # No direct st. calls needed.
    provider = project_details.get("provider", "AWS").upper()
    other_details = project_details.get("other_details", "")
    q_and_a_session = "\n".join([f"Q: {q}\nA: {a}\n" for q, a in zip(questions, answers)])

    # Provider-specific examples to guide the LLM
    aws_example = '''
"I am looking for a cloud architecture with AWS components for a scalable e-commerce platform.
The platform needs to support 100,000 concurrent users within the next year and handle seasonal traffic spikes up to 500,000 users. We anticipate a 50% year-over-year growth in user base and transaction volume.
Our preferred technical stack includes Python (Django) for the backend, React for the frontend, and PostgreSQL for the database. We prefer containerized deployments using Docker and Kubernetes for orchestration.
The system must ensure sub-second page load times for product listings and checkout processes. Resource scaling should be automatic based on demand.
We require PCI DSS compliance for payment processing, end-to-end encryption for all sensitive data, and regular security audits. A disaster recovery plan should ensure an RPO of less than 1 hour and an RTO of less than 4 hours.
The platform will need to integrate with third-party payment gateways (Stripe, PayPal), a shipping provider API (ShipStation), and an inventory management system. We also need a robust API for mobile app consumption.
Please provide a detailed AWS architecture in JSON format that meets these requirements, focusing on scalability, security, and cost-effectiveness."
'''

    azure_example = '''
"I am looking for a cloud architecture with Azure components for a corporate inventory management system.
The system needs to support our internal employees across three continents and handle real-time inventory updates. We expect a 20% annual increase in data volume.
Our application is built on .NET Core, and we use a SQL Server database. We want to move to a PaaS-first approach to minimize infrastructure management.
The system must be highly available with auto-scaling during peak business hours. Response times for inventory queries must be under 500ms.
We require data to be encrypted at rest and in transit, and user access should be managed via Azure Active Directory. We need a backup solution with a 24-hour RPO and 4-hour RTO.
The platform must integrate with our on-premises SAP system for order processing and with a third-party logistics API for shipping updates.
Please provide a detailed Azure architecture in JSON format that meets these requirements, focusing on PaaS services, security, and reliability."
'''

    gcp_example = '''
"I am looking for a cloud architecture with GCP components for a marketing analytics platform.
The platform will ingest data from various sources (web analytics, social media, ad platforms) and must process terabytes of data daily. We project data growth of 10x over the next two years.
Our data processing pipelines are written in Python and Apache Beam, and we use a serverless approach for our microservices backend. The frontend is a single-page application.
The system must provide low-latency query results for our data analysts. Ingestion and processing pipelines must be scalable and resilient to data spikes from marketing campaigns.
All data must be stored securely, and access must be controlled with IAM roles. We need to comply with GDPR and CCPA regulations.
The platform needs to ingest data from Google Analytics, Facebook Ads API, and Salesforce. It will expose a dashboard API for our internal users.
Please provide a detailed GCP architecture in JSON format that meets these requirements, emphasizing data processing, scalability, and serverless technologies."
'''
    
    provider_examples = {
        "AWS": aws_example,
        "AZURE": azure_example,
        "GCP": gcp_example
    }
    
    # Select the example based on the provider, defaulting to AWS
    example_prompt = provider_examples.get(provider, aws_example)

    context = f"""Project Title: {project_details['title']}
Description: {project_details['description']}
"""
    if other_details:
        context += f"Other Details: {other_details}\n"
    context += f"""Provider: {provider}

Full Requirements Discussion:
{q_and_a_session}

Generate a comprehensive {provider} architecture prompt in a narrative format with single line breaks between paragraphs.
The prompt should follow this structure but be written in a natural, conversational way:

1.  Start with "I am looking for a cloud architecture with {provider} components for [project type]"
2.  Describe the business requirements and growth projections
3.  Detail the technical stack and deployment preferences
4.  Explain the resource scaling and performance requirements
5.  Outline security, compliance, and disaster recovery needs
6.  Specify integration and API requirements
7.  Conclude with a request for {provider} architecture in JSON format

Example (content only, not style):
{example_prompt}
"""
    logger.info("Generated architecture prompt content.")
    return context

def generate_security_assessment(client_info, architecture_prompt: str, provider: str = "AWS") -> Tuple[Optional[Dict], Optional[Dict]]:
    if not architecture_prompt or not architecture_prompt.strip():
        return None, {"error": "Architecture prompt is empty."}
    
    cache_key_prefix = "sec_assessment"
    cache_key = generate_cache_key(cache_key_prefix, architecture_prompt)
    cached_result = get_cache(cache_key)
    if cached_result is not None and isinstance(cached_result, dict):
        logger.info(f"Cache HIT for security assessment ({cache_key_prefix}).")
        return cached_result, None

    logger.info(f"Cache MISS for security assessment ({cache_key_prefix}). Calling AI with JSON response format.")
    system_message = (f"You are an {provider} security expert. Based on the provided architecture prompt, "
                      "generate a security assessment. Identify potential vulnerabilities, recommend specific {provider} security services, "
                      "and suggest best practices. The output should be a JSON object detailing these points, for example: "
                      "{\\\"vulnerabilities\\\": [\\\"point1\\\", \\\"point2\\\"], \\\"recommendations\\\": {\\\"services\\\": [\\\"AWS Shield\\\", \\\"Amazon GuardDuty\\\"], \\\"practices\\\": [\\\"least privilege\\\"]}}")
    prompt = architecture_prompt
    assessment_json_str = ""
    
    try:
        assessment_json_str, error = get_ai_response(client_info, prompt, system_message, response_format={"type": "json_object"})

        if error:
            logger.error(f"Error from get_ai_response in generate_security_assessment: {error}")
            return None, {"error": f"AI call failed for security assessment: {error}", "raw_response": str(error)}

        if assessment_json_str:
            try:
                assessment_data = json.loads(assessment_json_str)
                set_cache(cache_key, assessment_data, 86400)
                logger.info(f"AI generated security assessment. Cached with key {cache_key_prefix}.")
                return assessment_data, None
            except json.JSONDecodeError as e:
                error_msg = f"AI returned invalid JSON for security assessment: {e}"
                logger.error(f"{error_msg}. Response: {assessment_json_str}", exc_info=True)
                return None, {"error": error_msg, "raw_response": assessment_json_str}
        else:
            logger.warning("AI did not provide a security assessment response string (after successful call).")
            return None, {"error": "AI did not provide a security assessment."}
            
    except Exception as e: 
        error_msg = f"Unexpected error during security assessment generation: {e}"
        logger.error(error_msg, exc_info=True)
        return None, {"error": error_msg, "raw_response": assessment_json_str if assessment_json_str else str(e)} 