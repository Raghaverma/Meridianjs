# Batch Request Execution

When you need to make multiple API calls (e.g. fetching details for 100 customers, or checking statuses for a list of transactions), executing them sequentially is slow, while firing all of them concurrently can crash your rate limits.

Meridian provides a built-in `.batch()` helper to handle concurrent request pooling and queue management safely.

---

## Executing Batch Requests

Use `.batch(requests, concurrency)` on any provider client:

```typescript
const client = meridian.provider("stripe");

const requests = [
  { method: "GET", endpoint: "/v1/customers/cus_1" },
  { method: "GET", endpoint: "/v1/customers/cus_2" },
  { method: "GET", endpoint: "/v1/customers/cus_3" },
  { method: "GET", endpoint: "/v1/customers/cus_4" }
];

// Execute with a maximum concurrency limit of 2 requests at a time
const results = await client.batch(requests, 2);

for (const result of results) {
  if (result instanceof Error) {
    // Individual requests that failed return the MeridianError directly
    // rather than throwing, preventing the entire batch from crashing!
    console.error(`Request failed: ${result.message}`);
  } else {
    // Successful requests return the standard NormalizedResponse
    console.log(`Customer Data:`, result.data);
  }
}
```

---

## Key Guarantees

1. **Ordering**: The returned `results` array has the exact same index order as the input `requests` array.
2. **Error Isolation**: If request #3 fails, request #1, #2, and #4 are unaffected and complete normally. The error is returned inline at index 2.
3. **Throttling Compliance**: Batch operations respect the client-side rate limiters and circuit breakers. If the circuit opens during a batch run, subsequent requests in the batch fail fast.
4. **Clean Exit**: Batch executes until all requests in the queue are completed or failed.
