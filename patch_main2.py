path = r'Customization Agent/tenant_builder_app/backend/main.py'
with open(path, 'rb') as f:
    raw = f.read()

old = b'class ChatRequest(BaseModel):\r\n    tenant_id: str\r\n    message: str'
insert = (
    b'class LlmConfig(BaseModel):\r\n'
    b'    """Inbound BYOK config. api_key used in-memory only, never logged."""\r\n'
    b'    provider: str\r\n'
    b'    model: str\r\n'
    b'    api_key: str\r\n'
    b'\r\n'
    b'\r\n'
)
new = insert + old + b'\r\n    llm_config: LlmConfig | None = None  # Optional BYOK override'

if old in raw:
    raw = raw.replace(old, new, 1)
    with open(path, 'wb') as f:
        f.write(raw)
    print('Done - LlmConfig inserted')
else:
    print('ERROR - pattern not found')
