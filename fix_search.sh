#!/bin/bash
python3 << 'PYEOF'
content = '''<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FRP 内网穿透管理平台</title>
    <style>
      html, body {
        touch-action: none;
        overscroll-behavior: none;
        -webkit-user-select: none;
        user-select: none;
      }
      input, textarea, select, [contenteditable="true"] {
        pointer-events: auto !important;
        -webkit-user-select: text;
        user-select: text;
      }
      button {
        pointer-events: auto !important;
      }
    </style>
    <script>
      document.addEventListener("pointerdown", function(e) {
        if (navigator.maxTouchPoints === 0) return;
        var el = e.target;
        while (el && el !== document.body && el !== document.documentElement) {
          var tag = el.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
          el = el.parentElement;
        }
        e.stopImmediatePropagation();
      }, { capture: true });

      // Clipboard polyfill for HTTP
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        navigator.clipboard = { writeText: function(text) {
          return new Promise(function(resolve, reject) {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:all;";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try {
              var ok = document.execCommand("copy");
              document.body.removeChild(ta);
              if (ok) resolve(); else reject(new Error("copy failed"));
            } catch(err) {
              document.body.removeChild(ta);
              reject(err);
            }
          });
        }};
      } else {
        var origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function(text) {
          return origWrite(text).catch(function() {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:all;";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try {
              var ok = document.execCommand("copy");
              document.body.removeChild(ta);
              if (ok) return Promise.resolve();
              return Promise.reject(new Error("copy failed"));
            } catch(err) {
              document.body.removeChild(ta);
              return Promise.reject(err);
            }
          });
        };
      }
    </script>
    <script type="module" crossorigin src="/assets/index-DKwttcTM.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DyrWCwua.css">
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
'''
with open('/home/azureuser/frp-platform/web/dist/index.html', 'w', encoding='utf-8') as f:
    f.write(content)
print('index.html updated with clipboard polyfill')
PYEOF
