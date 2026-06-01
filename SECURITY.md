# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

## Reporting a Vulnerability

Report security vulnerabilities privately to the project maintainers. Do not open public issues for security vulnerabilities.

### Process

1. Email security concerns to the project's security contact (see repository contact information)
2. Include a detailed description of the vulnerability
3. Provide steps to reproduce if applicable
4. Include potential impact assessment

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

## Known Limitations

- Tokens are stored in memory during runtime (not persisted)
- Schema validation does not prevent all API contract violations
- Rate limiting is per-process, not distributed
- Circuit breakers are per-provider, not per-endpoint


