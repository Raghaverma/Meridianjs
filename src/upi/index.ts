/**
 * High-level helpers for UPI (Unified Payments Interface) — a uniquely Indian
 * payment primitive layered on top of raw provider adapters (Setu, Decentro,
 * BillDesk, CCAvenue, ...). These helpers operate purely on the UPI URI/VPA
 * formats defined by NPCI; they don't call any provider API.
 *
 * Reference: NPCI UPI Linking Specification (`upi://pay?...` deep links) and
 * the VPA format `<handle>@<psp-handle>`.
 */

// `<handle>@<psp-handle>`: handle allows letters, digits, and . _ - ;
// the PSP handle must start with a letter and may contain letters, digits, . -
const VPA_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

/**
 * Validates a UPI Virtual Payment Address against NPCI's `handle@pspHandle`
 * format. This is a syntactic check — it does not confirm the VPA is
 * registered or resolvable; that requires a live lookup through a provider
 * such as Setu or Decentro.
 */
export function validateVpa(vpa: string): boolean {
  if (typeof vpa !== "string") return false;
  return VPA_REGEX.test(vpa.trim());
}

export interface UpiDeepLinkOptions {
  /** Payee VPA, e.g. "merchant@oksbi" (mapped to the `pa` parameter). */
  vpa: string;
  /** Payee display name (`pn`). */
  payeeName?: string;
  /** Amount in major currency units, e.g. 1000 for ₹1000 (`am`). */
  amount?: number;
  /** ISO 4217 currency code; defaults to "INR" (`cu`). */
  currency?: string;
  /** Transaction note / description shown to the payer (`tn`). */
  note?: string;
  /** Merchant-generated transaction reference (`tr`). */
  transactionRef?: string;
  /** Transaction ID, typically issued by the PSP (`tid`). */
  transactionId?: string;
  /** Merchant category code (`mc`). */
  merchantCode?: string;
}

/**
 * Builds a `upi://pay` deep link per NPCI's UPI Linking Specification, suitable
 * for opening a UPI app's payment screen pre-filled with the given details.
 *
 * Throws if `vpa` fails {@link validateVpa} or `amount` is not a positive,
 * finite number — both would produce a deep link that UPI apps reject.
 */
export function createUpiDeepLink(options: UpiDeepLinkOptions): string {
  if (!validateVpa(options.vpa)) {
    throw new Error(
      `createUpiDeepLink: "${options.vpa}" is not a valid UPI VPA (expected handle@bank format)`,
    );
  }
  if (options.amount !== undefined && (!Number.isFinite(options.amount) || options.amount <= 0)) {
    throw new Error(
      `createUpiDeepLink: amount must be a positive finite number, received ${options.amount}`,
    );
  }

  const params: Array<[string, string]> = [
    ["pa", options.vpa.trim()],
    ["cu", options.currency ?? "INR"],
  ];
  if (options.payeeName) params.push(["pn", options.payeeName]);
  if (options.amount !== undefined) params.push(["am", options.amount.toFixed(2)]);
  if (options.note) params.push(["tn", options.note]);
  if (options.transactionRef) params.push(["tr", options.transactionRef]);
  if (options.transactionId) params.push(["tid", options.transactionId]);
  if (options.merchantCode) params.push(["mc", options.merchantCode]);

  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `upi://pay?${query}`;
}
