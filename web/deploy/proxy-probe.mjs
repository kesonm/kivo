// Run only in a temporary server-side container. This probe never reads an API key.
// NODE_USE_ENV_PROXY=1 and HTTPS_PROXY must be set before Node starts.
const origin = 'https://api.openai.com/v1/models';
const output = { node: process.version, envProxyEnabled: process.env.NODE_USE_ENV_PROXY === '1' };
try {
  const response = await fetch(origin, { signal: AbortSignal.timeout(25000), redirect: 'error' });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  const code = typeof body.error?.code === 'string' ? body.error.code : null;
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  const regionDenied = /region|country|territor|unsupported_country/i.test(`${code ?? ''} ${message}`);
  Object.assign(output, { status: response.status, errorCode: code, regionDenied,
    reachableWithoutKey: response.status === 401 && !regionDenied });
  if (regionDenied) process.exitCode = 3;
  else if (response.status !== 401) process.exitCode = 2;
  else {
    try {
      const denied = await fetch('https://example.com/', { signal: AbortSignal.timeout(6000), redirect: 'error' });
      await denied.body?.cancel();
      output.nonAllowlistedDestinationBlocked = false;
      output.nonAllowlistedStatus = denied.status;
      process.exitCode = 2;
    } catch { output.nonAllowlistedDestinationBlocked = true; }
  }
  console.log(JSON.stringify(output));
} catch (error) {
  console.log(JSON.stringify({ ...output, reachableWithoutKey: false, error: error.name, cause: error.cause?.code ?? null }));
  process.exitCode = 2;
}
