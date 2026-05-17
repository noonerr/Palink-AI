#!/bin/bash
# Fix clipboard function in JS file
sed -i 's/ee=document.createElement("textarea");ee.value=n.frpToken,document.body.appendChild(ee),ee.select(),document.execCommand("copy"),document.body.removeChild(ee),kn.success("Token 已复制到剪贴板")/ee=document.createElement("textarea");ee.value=n.frpToken;ee.style.cssText="position:fixed;left:-9999px;top:-9999px;opacity:0;z-index:-1;width:1px;height:1px;pointer-events:none;";document.body.appendChild(ee);ee.focus();ee.select();try{document.execCommand("copy")}catch(O){}document.body.removeChild(ee);kn.success("Token 已复制到剪贴板")/g' /usr/share/nginx/html/assets/index-B78oONbB.js
echo "Clipboard function fixed"
