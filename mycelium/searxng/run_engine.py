# Launch SearXNG with request logging silenced — the per-request access log lines contain
# your query strings, and Mycelium keeps no query history. This runs the normal
# searx.webapp entrypoint after turning werkzeug's access log down to errors only.
import logging
import runpy


class _DropWerkzeug(logging.Filter):
    def filter(self, record):  # drop every werkzeug record — access lines carry query strings
        return False


# A filter survives SearXNG re-initialising logging on startup; a plain setLevel gets overridden.
logging.getLogger("werkzeug").addFilter(_DropWerkzeug())
runpy.run_module("searx.webapp", run_name="__main__")
