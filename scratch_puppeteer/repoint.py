import re

try:
    with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/sandbox-index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    
    # Prepend production URL to absolute path resources so they load from prod directly
    html = re.sub(r'(src=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(href=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(srcset=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(url\((["\']?))/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    
    with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/sandbox-index.html', 'w', encoding='utf-8') as f:
        f.write(html)
    print('Successfully re-pointed static assets to prod')
except Exception as e:
    print(f'Error: {e}')
