export function adminListenHost(env, inContainer) {
  const host = env.ADMIN_BIND_HOST || '127.0.0.1';
  if (env.NODE_ENV === 'production' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    if (!(host === '0.0.0.0' && env.ADMIN_CONTAINER_MODE === 'true' && inContainer)) {
      throw new Error('Production admin must bind to loopback, or explicitly use container mode with a loopback-only host port');
    }
  }
  return host;
}

export function setAdminPeerHeaders(req) {
  // This server is reached directly through SSM/SSH, not a public proxy.
  // Never use caller-supplied forwarding headers for the private-network gate.
  delete req.headers['x-forwarded-for'];
  const address = req.socket.remoteAddress || '';
  req.headers['x-real-ip'] = address.replace(/^::ffff:/, '');
}
