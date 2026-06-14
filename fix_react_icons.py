import os
import glob

files = glob.glob('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/frontend/**/*.js', recursive=True) + \
        glob.glob('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/frontend/**/*.jsx', recursive=True) + \
        glob.glob('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/SubSpace-adityajayashankar-ifca/frontend/**/*.js', recursive=True) + \
        glob.glob('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/SubSpace-adityajayashankar-ifca/frontend/**/*.jsx', recursive=True)

for f in files:
    try:
        with open(f, 'r', encoding='utf-8') as file:
            content = file.read()
        
        new_content = content.replace('from "react-icons/md"', 'from "react-icons/md/index.js"')
        new_content = new_content.replace("from 'react-icons/md'", "from 'react-icons/md/index.js'")
        
        if new_content != content:
            with open(f, 'w', encoding='utf-8') as file:
                file.write(new_content)
            print(f"Updated {f}")
    except Exception as e:
        pass
