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

export interface PaymentChallenge {
  /** Which x402 scheme (e.g. "stellar-usdc") */
  scheme: string;
  /** Amount required in USDC (e.g. "0.001") */
  amount_usdc: string;
  /** Stellar address to pay */
  pay_to: string;
  /** Memo for the payment transaction */
  memo?: string;
  /** Unix timestamp when challenge expires */
  expires_at: number;
  /** The specific service being paid for */
  service: string;
}

export interface PaymentReceipt {
  /** Signed XDR transaction or tx hash */
  transaction: string;
  /** Amount paid */
  amount_usdc: string;
  /** Payer Stellar address */
  payer: string;
}

export interface X402Response {
  /** 402 status code info */
  status: 402;
  error: "Payment Required";
  challenge: PaymentChallenge;
}
