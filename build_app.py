#!/usr/bin/env python3
import shutil
import os
import stat
import subprocess
import sys

def remove_readonly(func, path, excinfo):
    os.chmod(path, stat.S_IWRITE)
    func(path)

client_dir = r"C:\Users\Pall\OneDrive\桌面\frp\client"
os.chdir(client_dir)

dist_dir = os.path.join(client_dir, "dist")

print("Starting pyinstaller build...")

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--onefile",
    "--windowed",
    "--name", "FRP客户端",
    "--exclude-module", "matplotlib",
    "--exclude-module", "numpy",
    "--exclude-module", "scipy",
    "--exclude-module", "PIL",
    "--exclude-module", "tkinter",
    "--exclude-module", "unittest",
    "--exclude-module", "xml",
    "--exclude-module", "html",
    "--exclude-module", "http",
    "--exclude-module", "pydoc",
    "--noconfirm",
    "app.py"
]

result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")

if result.returncode != 0:
    print("STDERR:", result.stderr[-3000:] if len(result.stderr) > 3000 else result.stderr)
    print("STDOUT:", result.stdout[-3000:] if len(result.stdout) > 3000 else result.stdout)
    print("Return code:", result.returncode)
else:
    print("Build completed successfully!")

exe_path = os.path.join(dist_dir, "FRP客户端.exe")
if os.path.exists(exe_path):
    size_mb = os.path.getsize(exe_path) / (1024 * 1024)
    print(f"\nSUCCESS! exe path: {exe_path}")
    print(f"File size: {size_mb:.2f} MB")
else:
    print("\nFAILED! exe not found in dist directory")
    print("Listing dist directory:")
    if os.path.exists(dist_dir):
        for f in os.listdir(dist_dir):
            print(f"  {f}")
