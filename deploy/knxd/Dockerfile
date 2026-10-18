# SE7ENX knxd: drives a KNX USB (or TPUART/FT1.2) interface with knxd and exposes it to the SE7ENX hub
# as a KNXnet/IP tunnelling server. knxd itself is the unmodified Debian package (GPL-2.0-or-later).
# Tested with knxd 0.14.73-1 (Debian trixie). Build: docker build -t se7enx-knxd:2.0.0 deploy/knxd
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends knxd knxd-tools \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10003 se7enx-knxd \
 && useradd --system --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin se7enx-knxd

COPY entrypoint.sh /usr/local/bin/se7enx-knxd
RUN chmod 0755 /usr/local/bin/se7enx-knxd

USER 10003:10003
EXPOSE 3671/udp
# A tunnelling client must be able to describe the server: same check SE7ENX's chain diagnostics use.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 CMD pgrep -x knxd >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/se7enx-knxd"]
