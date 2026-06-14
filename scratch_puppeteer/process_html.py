import re

try:
    with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/sandbox-index-raw.html', 'r', encoding='utf-8') as f:
        html = f.read()

    # Strip scripts to avoid hydration/errors
    html = re.sub(r'<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>', '', html, flags=re.IGNORECASE)

    # Prepend production URL to absolute path resources so they load from prod directly
    html = re.sub(r'(src=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(href=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(srcset=["\'])/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)
    html = re.sub(r'(url\((["\']?))/(?!/)', r'\g<1>https://pvl.ifcaindia.com/', html)

    # Apply our CSS variable replacements!
    replacements = [
        ('bg-orange-', 'bg-primary-'),
        ('text-orange-', 'text-primary-'),
        ('border-orange-', 'border-primary-'),
        ('ring-orange-', 'ring-primary-'),
        ('hover:bg-orange-', 'hover:bg-primary-'),
        ('hover:text-orange-', 'hover:text-primary-'),
        ('focus:ring-orange-', 'focus:ring-primary-'),
        ('from-orange-', 'from-primary-'),
        ('to-orange-', 'to-primary-'),
        ('via-orange-', 'via-primary-')
    ]
    for old, new in replacements:
        html = html.replace(old, new)

    # Inject the compiled tailwind utilities before </head>
    with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/frontend/tailwind-utils.css', 'r', encoding='utf-8') as f:
        css = f.read()
    
    # Let's forcefully override any lazy-load hiding classes just to be safe
    # Sometimes elements use opacity-0 translate-y-10 for scroll animations
    # We will just inject CSS to force them visible!
    css += "\n.opacity-0 { opacity: 1 !important; }\n"
    css += "\n[data-aos] { opacity: 1 !important; transform: none !important; }\n"

    # Extract missing arbitrary hex colors to fix invisible footer/elements
    arbitrary_bgs = set(re.findall(r'bg-\[#[a-fA-F0-9]{3,6}\]', html))
    for bg in arbitrary_bgs:
        hex_color = bg[4:-1]
        escaped_bg = bg.replace('[', '\\[').replace(']', '\\]').replace('#', '\\#')
        css += f"\n.{escaped_bg} {{ background-color: {hex_color}; }}\n"

    arbitrary_texts = set(re.findall(r'text-\[#[a-fA-F0-9]{3,6}\]', html))
    for txt in arbitrary_texts:
        hex_color = txt[6:-1]
        escaped_txt = txt.replace('[', '\\[').replace(']', '\\]').replace('#', '\\#')
        css += f"\n.{escaped_txt} {{ color: {hex_color}; }}\n"

    arbitrary_borders = set(re.findall(r'border-\[#[a-fA-F0-9]{3,6}\]', html))
    for border in arbitrary_borders:
        hex_color = border[8:-1]
        escaped_border = border.replace('[', '\\[').replace(']', '\\]').replace('#', '\\#')
        css += f"\n.{escaped_border} {{ border-color: {hex_color}; }}\n"

    html = html.replace('</head>', f'<style>\n{css}\n</style></head>')

    with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/sandbox-index.html', 'w', encoding='utf-8') as f:
        f.write(html)
        
    print('Successfully generated final remote sandbox HTML with scroll state')
except Exception as e:
    print(f'Error: {e}')
