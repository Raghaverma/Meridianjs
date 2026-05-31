export function parseRetryAfter(header: string | null): Date | null {
  if (!header || typeof header !== "string") {
    return null;
  }

  const trimmed = header.trim();

  const seconds = Number.parseInt(trimmed, 10);
  if (!isNaN(seconds) && seconds >= 0 && seconds <= 86400 * 365) {
    return new Date(Date.now() + seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (!isNaN(date)) {
    const parsedDate = new Date(date);

    const now = Date.now();
    if (parsedDate.getTime() > now && parsedDate.getTime() < now + 86400 * 365 * 1000) {
      return parsedDate;
    }
  }

  return null;
}

export interface LinkHeader {
  url: string;
  rel: string;
  params: Record<string, string>;
}

export function parseLinkHeader(header: string | null): LinkHeader[] {
  if (!header || typeof header !== "string") {
    return [];
  }

  const links: LinkHeader[] = [];

  const parts = splitLinkHeader(header);

  for (const part of parts) {
    const link = parseSingleLink(part.trim());
    if (link) {
      links.push(link);
    }
  }

  return links;
}

function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inAngleBrackets = false;

  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;

    if (char === "<") {
      inAngleBrackets = true;
      current += char;
    } else if (char === ">") {
      inAngleBrackets = false;
      current += char;
    } else if (char === "," && !inAngleBrackets) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseSingleLink(link: string): LinkHeader | null {
  const urlMatch = link.match(/^<([^>]+)>/);
  if (!urlMatch || !urlMatch[1]) {
    return null;
  }

  const url = urlMatch[1];
  const params: Record<string, string> = {};
  let rel = "";

  const remaining = link.slice(urlMatch[0].length);
  const paramParts = remaining.split(";");

  for (const paramPart of paramParts) {
    const trimmed = paramPart.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\w+)=["']?([^"']+)["']?$/);
    if (match && match[1] && match[2]) {
      const key = match[1].toLowerCase();
      const value = match[2];

      if (key === "rel") {
        rel = value;
      } else {
        params[key] = value;
      }
    }
  }

  if (!rel) {
    return null;
  }

  return { url, rel, params };
}

export function findLinkByRel(links: LinkHeader[], rel: string): LinkHeader | null {
  return links.find((link) => link.rel === rel) ?? null;
}

export interface ParsedRateLimit {
  limit: number;
  remaining: number;
  reset: Date;
}

export function parseRateLimitHeaders(headers: Headers): ParsedRateLimit | null {
  let limit = parseIntHeader(headers.get("X-RateLimit-Limit"));
  let remaining = parseIntHeader(headers.get("X-RateLimit-Remaining"));
  let reset = parseResetHeader(headers.get("X-RateLimit-Reset"));

  if (limit === null) {
    limit = parseIntHeader(headers.get("RateLimit-Limit"));
  }
  if (remaining === null) {
    remaining = parseIntHeader(headers.get("RateLimit-Remaining"));
  }
  if (reset === null) {
    reset = parseResetHeader(headers.get("RateLimit-Reset"));
  }

  if (limit === null || remaining === null || reset === null) {
    return null;
  }

  if (limit < 0 || remaining < 0 || remaining > limit) {
    return null;
  }

  return { limit, remaining, reset };
}

function parseIntHeader(value: string | null): number | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (isNaN(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return parsed;
}

function parseResetHeader(value: string | null): Date | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  const timestamp = Number.parseInt(trimmed, 10);
  if (!isNaN(timestamp) && timestamp > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (timestamp >= now - 60 && timestamp < now + 86400 * 365) {
      return new Date(timestamp * 1000);
    }
  }

  const date = Date.parse(trimmed);
  if (!isNaN(date)) {
    const parsedDate = new Date(date);
    const now = Date.now();
    if (parsedDate.getTime() >= now - 60000 && parsedDate.getTime() < now + 86400 * 365 * 1000) {
      return parsedDate;
    }
  }

  return null;
}
