# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4.0 | :x:                |

## Reporting a Vulnerability

Report security vulnerabilities privately. **Do not open public issues, pull requests, or discussions for security vulnerabilities.**

### How to report

Preferred — GitHub private vulnerability reporting:

1. Go to the [Security tab](https://github.com/Raghaverma/meridianjs/security) of the repository.
2. Click **"Report a vulnerability"** to open a private advisory ([direct link](https://github.com/Raghaverma/meridianjs/security/advisories/new)).
3. This channel stays private between you and the maintainers until a fix is published.

Alternative — email:

- Email the maintainer at **rvraghav09@gmail.com** with the subject line `SECURITY: meridianjs`.

### What to include

1. A detailed description of the vulnerability.
2. Steps to reproduce (a minimal proof-of-concept is ideal).
3. The affected version(s) and configuration.
4. A potential impact assessment.

### Response Timeline

- Initial acknowledgment: Within 48 hours
- Status update: Within 7 days
- Resolution timeline: Depends on severity and complexity

### Severity Levels

**Critical**: Remote code execution, authentication bypass, data exposure
- Response: Immediate investigation, patch within 7 days

**High**: Privilege escalation, significant data leakage
- Response: Investigation within 48 hours, patch within 14 days

**Medium**: Information disclosure, denial of service
- Response: Investigation within 7 days, patch in next release cycle

**Low**: Best practice violations, minor information leaks
- Response: Addressed in regular release cycle

## Responsible Disclosure

We follow responsible disclosure practices:

1. Reporter allows reasonable time for fix before public disclosure
2. Maintainers commit to transparent communication about timeline
3. Credit given to reporter in security advisories (unless requested otherwise)
4. Coordinated release of fix and advisory

## Security Best Practices

When using Meridian:

- Store API tokens in environment variables, not in code
- Use least-privilege token scopes
- Rotate credentials regularly
- Monitor circuit breaker and rate limit metrics
- Review schema drift warnings for unexpected API changes
- Keep the SDK updated to latest patch version
- Treat request endpoints as relative paths. Absolute and protocol-relative
  endpoints are rejected to prevent redirecting authenticated requests to an
  unintended host; use `isSafeEndpoint()` to pre-validate any endpoint built
  from untrusted input.

### Boundary Proxy

- Keep the proxy bound to a loopback host (`127.0.0.1`, the default). Binding to
  a non-loopback host without an `authToken` is refused; override only with
  `allowUnauthenticatedRemote: true` and a firewall in front.
- Set `authToken` (or `MERIDIAN_PROXY_TOKEN`) so callers must present a shared
  secret. Client-supplied `Authorization`/`Cookie` headers are never forwarded
  upstream — the proxy injects provider credentials itself.
- Request/response recordings are **sensitive**. Credentials are always redacted
  before they are written; PII patterns are redacted by default (`recordRedaction`).
  Store and share recording files with the same care as the underlying data.

## Known Limitations

- Tokens are stored in memory during runtime (not persisted)
- Schema validation does not prevent all API contract violations
- Rate limiting is per-process, not distributed
- Circuit breakers are per-provider, not per-endpoint


