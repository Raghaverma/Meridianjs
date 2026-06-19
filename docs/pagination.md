# Unified Pagination

Every third-party provider paginates records differently:
- **Stripe** uses cursor-based pagination with `starting_after`.
- **Cashfree** uses offset-based page numbers (`page`, `limit`).
- **GitHub** uses the HTTP `Link` header.
- **Apollo.io** uses page-based pagination with custom response envelopes.

Meridian normalizes pagination patterns into a single interface.

---

## The `.paginate()` Async Generator

Meridian exposes a unified async generator `.paginate(endpoint, options)` directly on provider clients. You can traverse collections using standard `for await...of` loops, regardless of how the underlying provider implements pagination.

```typescript
const client = meridian.provider("stripe");

// Traverses all pages automatically
for await (const page of client.paginate("/v1/customers", { query: { limit: 50 } })) {
  // page is a NormalizedResponse containing the current batch of items
  console.log(`Fetched page with ${page.data.length} customers.`);
  
  // Standardized metadata
  console.log(`Has next page? ${page.meta.pagination?.hasNext}`);
  console.log(`Current Cursor: ${page.meta.pagination?.cursor}`);
  console.log(`Total Count: ${page.meta.pagination?.total}`);
}
```

If you switch the provider to `"cashfree"` or `"apollo"`, this loop does not change. Meridian's adapter automatically handles page incrementing, cursor parsing, and query param injection under the hood.

---

## Standardized Pagination Info

Every paginated response page contains standard `meta.pagination` stats:

```typescript
interface PaginationInfo {
  hasNext: boolean;  // Whether another page is available
  cursor?: string;   // The cursor token or page number for the next request
  total?: number;    // The total count of items across all pages (if exposed by provider)
}
```

---

## Customizing Page Limits & Stop Conditions

The `.paginate()` generator yields until the provider returns no more records. You can break out of the loop early if your application criteria are satisfied:

```typescript
let count = 0;

for await (const page of meridian.provider("github").paginate("/orgs/my-org/repos")) {
  for (const repo of page.data) {
    console.log(`Repo: ${repo.name}`);
    count++;
    
    if (count >= 100) {
      break; // stop pagination early after 100 items
    }
  }
  if (count >= 100) break;
}
```

### Offset Pagination Termination

When using offset-based pagination (e.g., `limit` and `offset` query parameters) without a `total` count, the generator automatically terminates when an empty page is received. This prevents unbounded iteration and ensures the loop completes cleanly instead of reaching internal page limits.
