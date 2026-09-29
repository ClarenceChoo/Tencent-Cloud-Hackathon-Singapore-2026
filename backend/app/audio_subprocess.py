"""Resource-limited decoder entry point; no shell or inherited application secrets."""
import os
import resource
import sys

resource.setrlimit(resource.RLIMIT_CPU, (6, 6))
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
if sys.platform.startswith('linux'):
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
os.execv(sys.argv[1], sys.argv[1:])
