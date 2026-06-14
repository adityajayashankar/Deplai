import re

path = r'Customization Agent/tenant_builder_app/backend/main.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1) Insert LlmConfig model before ChatRequest
old_chat_request = (
    'class ChatRequest(BaseModel):\r\n'
    '    tenant_id: str\r\n'
    '    message: str'
)

new_chat_request = (
    'class LlmConfig(BaseModel):\r\n'
    '    """Inbound BYOK LLM configuration from the frontend. api_key used in-memory only."""\r\n'
    '    provider: str\r\n'
    '    model: str\r\n'
    '    api_key: str\r\n'
    '\r\n'
    '\r\n'
    'class ChatRequest(BaseModel):\r\n'
    '    tenant_id: str\r\n'
    '    message: str\r\n'
    '    llm_config: LlmConfig | None = None'
)

if old_chat_request in content:
    content = content.replace(old_chat_request, new_chat_request, 1)
    print('LlmConfig inserted')
else:
    print('ERROR: could not find ChatRequest block')

# 2) Wire llm_config into agent.handle_message
old_call = 'result = agent.handle_message(normalized_tenant_id, request.message)'
new_call = 'result = agent.handle_message(normalized_tenant_id, request.message, byok_config=request.llm_config)'
if old_call in content:
    content = content.replace(old_call, new_call, 1)
    print('handle_message wired')
else:
    print('ERROR: could not find handle_message call')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
