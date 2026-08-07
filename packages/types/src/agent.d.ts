import type { SwapPlan } from "./swap.js";
export interface AgentIntent {
    /** Raw natural language input */
    raw: string;
    /** Parsed sell asset */
    sell_asset?: string;
    /** Parsed sell amount */
    sell_amount?: number;
    /** Parsed buy asset */
    buy_asset?: string;
    /** Target chain for buy asset */
    buy_chain?: string;
    /** User's Stellar address */
    user_address?: string;
}
export interface PlanRequest {
    intent: string;
    user_address: string;
}
export interface PlanResponse {
    plan: SwapPlan;
    explanation: string;
}
export interface ExecuteRequest {
    plan_id: string;
    user_address: string;
    /** Signed authorization from the user */
    auth_signature?: string;
}
export interface ServiceInfo {
    name: string;
    endpoint: string;
    method: "GET" | "POST";
    price_usdc: string;
    description: string;
    example_request?: Record<string, unknown>;
}
export interface ServiceCatalog {
    protocol: "micopay";
    version: string;
    payment_method: "x402";
    payment_asset: "USDC";
    payment_network: "stellar";
    services: ServiceInfo[];
    skill_url: string;
}
//# sourceMappingURL=agent.d.ts.map