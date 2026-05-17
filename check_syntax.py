import py_compile
import os

errors = []
for root, dirs, files in os.walk('.'):
    for f in files:
        if f.endswith('.py'):
            path = os.path.join(root, f)
            try:
                py_compile.compile(path, doraise=True)
            except py_compile.PyCompileError as e:
                errors.append(str(e))

if errors:
    for e in errors:
        print(e)
else:
    print('ALL OK')
