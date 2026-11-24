#!/bin/sh
# The daemon runs the container as the host user's uid, which the image does not know. Give it a
# passwd entry so `whoami`, git and ssh can resolve the user.
if ! whoami >/dev/null 2>&1; then
	echo "agent:x:$(id -u):$(id -g):devflow agent:${HOME:-/tmp}:/bin/bash" >>/etc/passwd
fi
exec "$@"
