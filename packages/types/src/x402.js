/**
 * x402 Payment Protocol Types
 *
 * HTTP 402 Payment Required flow:
 * 1. Client sends request without payment
 * 2. Server responds 402 with PaymentChallenge
 * 3. Client signs a Stellar transaction paying the required amount
 * 4. Client sends PaymentReceipt in X-Payment header
 * 5. Server verifies payment and returns 200 with data
 */
export {};
//# sourceMappingURL=x402.js.map