# Agent Breadboard tool sandbox image: Python tool extensions ([06] §4, [12] §6).
#
# Build from the repository root:
#   docker build -f deploy/sandbox/Dockerfile.py -t breadboard-sandbox-py:local .
#
# The server's DockerSandboxRunner creates one container per execution from this image with a read-only root
# filesystem, tmpfs /work, all capabilities dropped, no-new-privileges, user 10001, and only the internal
# `breadboard-sandbox` network attached. It copies the tool directory into /tool and execs
#   python3 -u /runtime/breadboard_runtime.py /tool
# with the RunnerRequest on stdin. The runtime is stdlib-only. Tools that need third-party packages should
# ship them vendored inside the tool directory, or use a derived image built FROM this one (and point
# `sandbox.images.python` at it), or be baked in at build time through PIP_PACKAGES; spawn-harness needs
#   --build-arg PIP_PACKAGES="strands-agents>=1.61 strands-harness==0.3.1"
FROM python:3.12-alpine

ARG PIP_PACKAGES=""

LABEL org.opencontainers.image.title="breadboard-sandbox-py" \
      org.opencontainers.image.description="Agent Breadboard tool sandbox (Python)"

RUN addgroup -S -g 10001 sandbox \
 && adduser -S -D -H -h /work -s /sbin/nologin -u 10001 -G sandbox sandbox \
 && mkdir -p /tool /work /runtime \
 && chown root:root /tool /runtime \
 && chmod 0755 /tool /runtime \
 && chmod 1777 /work \
 && rm -rf /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk \
 && if [ -n "$PIP_PACKAGES" ]; then python3 -m pip install --no-cache-dir $PIP_PACKAGES; fi \
 && { python3 -m pip uninstall -y pip setuptools wheel >/dev/null 2>&1 || true; }

COPY packages/sandbox-runtime/python/ /runtime/
# COPY writes root-owned files; normalize modes so the sandbox user can read but never write them.
RUN chmod -R u=rwX,go=rX /runtime

ENV HOME=/work \
    TMPDIR=/work \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONPATH=/runtime

VOLUME ["/tool"]
WORKDIR /work
USER 10001:10001

# Exec form, no shell. Manual use: docker run -i --rm -v "$PWD/mytool:/tool:ro" breadboard-sandbox-py:local < request.json
CMD ["python3", "-u", "/runtime/breadboard_runtime.py", "/tool"]
