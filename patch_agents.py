import os
import glob

agent_files = glob.glob('Customization Agent/tenant_builder_app/backend/agents/*.py')
for path in agent_files:
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    
    if 'ProjectLLMClient()' in text and 'state.get("byok_config")' not in text:
        lines = text.split('\n')
        for i, line in enumerate(lines):
            if 'client = ProjectLLMClient()' in line:
                indent = line[:len(line) - len(line.lstrip())]
                lines[i] = f'{indent}byok_config = state.get("byok_config")\n{indent}client = ProjectLLMClient(byok_config=byok_config)'
        
        new_text = '\n'.join(lines)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_text)
        print(f'Updated {path}')
