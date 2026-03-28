# Meridian SDK Compliance Guide (SOC 2, ISO 27001, HIPAA)

Meridian SDK is designed to meet the rigorous security and privacy requirements of enterprise customers. This guide explains how Meridian helps you achieve and maintain compliance with **SOC 2**, **ISO 27001**, and **HIPAA**.

## 1. SOC 2: Security, Availability, and Auditability

SOC 2 requires detailed audit trails and protection against unauthorized access.

### Audit Logging (Traceability)
Meridian provides first-class support for audit logging by linking every request to a specific **identity**.

- **Implementation**: Pass an `identity` (e.g., `userId` or `serviceId`) in the `RequestOptions`.
- **Outcome**: Every request, response, and error log in your observability stream (OpenTelemetry, Prometheus, Datadog) will include the `identity` and a unique `requestId`.
- **Compliance Link**: Meets SOC 2 requirements for **Audit Trails** and **Monitored Access**.

### Availability
Meridian's native **Circuit Breaker** and **Rate Limiting** strategies ensure that your application remains resilient even when third-party providers fail.
- **Compliance Link**: Meets SOC 2/ISO 27001 requirements for **System Availability**.

---

## 2. HIPAA: Protecting PHI/PII

HIPAA requires strict controls over Protected Health Information (PHI).

### Automated PII/PHI Redaction
Meridian includes a compliance-ready sanitization engine that automatically redacts sensitive patterns from logs.

- **Enablement**: Set `compliance: { piiRedaction: true }` in your `MeridianConfig`.
- **Detected Patterns**:
    - Email addresses
    - Phone numbers
    - Social Security Numbers (SSN)
    - Credit Card numbers
- **Outcome**: Sensitive data is replaced with `[PII-REDACTED]` before it ever reaches your logs or observability adapters.
- **Compliance Link**: Meets HIPAA requirements for **Technical Safeguards** and **Data Minimization**.

---

## 3. ISO 27001: Information Security Management

ISO 27001 focuses on risk management and consistent security practices.

### Secret Redaction
By default, Meridian redacts common sensitive keys (like `Authorization`, `apiKey`, `token`, `cookie`) from headers and query parameters.
- **Customization**: Use `sanitizerOptions.redactedKeys` to add additional proprietary sensitive fields.

### Data Residency & Transit
Meridian uses standard HTTPS (`fetch`) for all provider communications, ensuring data is encrypted in transit.
- **State Storage**: If using `mode: "distributed"`, ensure your `StateStorage` implementation (e.g., Redis) is encrypted at rest and uses TLS.

---

## Best Practices Checklist

- [ ] **Always Provide Identity**: Link requests to the calling user for SOC 2.
- [ ] **Enable PII Redaction**: Especially if your SDK handles user profiles or billing data.
- [ ] **Secure Your State**: Ensure your Redis/Database for circuit breaker state is hardened.
- [ ] **Rotate Keys**: Use Meridian's dynamic authentication strategies to rotate secrets without downtime.

---

## Technical Configuration Example

```typescript
const meridian = await Meridian.create({
  compliance: {
    piiRedaction: true,
    auditLog: true
  },
  observability: new OpenTelemetryAdapter(), // Audit logs sent here
  github: {
    auth: { token: process.env.GITHUB_TOKEN }
  }
});

// Request with audit identity
await meridian.github.get("/user", { 
  identity: "user_12345" 
});
```
