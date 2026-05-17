#!/usr/bin/env python3
import sys

with open('/tmp/index-B78oONbB.js', 'r') as f:
    content = f.read()

old = 'ee=document.createElement("textarea");ee.value=n.frpToken,document.body.appendChild(ee),ee.select(),document.execCommand("copy"),document.body.removeChild(ee),kn.success("Token 已复制到剪贴板")'
new = 'ee=document.createElement("textarea");ee.value=n.frpToken;ee.style.cssText="position:fixed;left:-9999px;top:-9999px;opacity:0;z-index:-1;width:1px;height:1px;pointer-events:none;";document.body.appendChild(ee);ee.focus();ee.select();try{document.execCommand("copy")}catch(O){}document.body.removeChild(ee);kn.success("Token 已复制到剪贴板")'

if old in content:
    content = content.replace(old, new)
    with open('/tmp/index-B78oONbB.js', 'w') as f:
        f.write(content)
    print('Fixed successfully')
else:
    print('Pattern not found')
    sys.exit(1)
