import os
import sys

# Ensure repository root is in sys.path so server module imports cleanly
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

from server import app

# Vercel WSGI entry point
# Exposing 'app' for serverless invocations
