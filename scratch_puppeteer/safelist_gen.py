prefixes = ['bg-', 'text-', 'border-', 'ring-', 'hover:bg-', 'hover:text-', 'focus:ring-', 'from-', 'to-', 'via-']
colors = ['primary', 'secondary']
shades = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', 'main']
classes = []
for p in prefixes:
    for c in colors:
        for s in shades:
            classes.append(f'{p}{c}-{s}')
html = f'<div class="{" ".join(classes)}"></div>'
with open('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/frontend/tailwind-safelist.html', 'w') as f:
    f.write(html)
