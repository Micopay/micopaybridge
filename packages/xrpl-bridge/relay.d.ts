/**
 * Tipos de relay.js. Escritos a mano, igual que los de bridge-translate, y
 * comprobados contra el .js por dts-drift.test.js — un .d.ts que miente deja
 * el gate de tipos en verde y revienta en runtime.
 *
 * Solo se declara lo que hace falta para consumirlo; el módulo es CommonJS.
 */

/// <reference types="node" />

/** Extrae la preimagen de un Fulfillment DER (A0 22 80 20 <32 bytes>). */
export declare function extractPreimage(fulfillmentHex: string): Buffer | null;

/**
 * Extrae el hash de una condition DER. El fingerprint de la condition ES el
 * secret_hash que valida Soroban.
 */
export declare function secretHashFromCondition(conditionHex: string | undefined | null): Buffer | null;

/**
 * Busca en el historial de la cuenta un EscrowFinish exitoso y devuelve la
 * preimagen revelada. El secreto queda público on-chain para siempre: esto es
 * lo que permite recuperar un swap cuyo proceso murió después de revelar.
 *
 * `expectedSecretHash` no es opcional en la práctica — una cuenta que haya
 * cerrado más de un swap tiene varios EscrowFinish, y sin filtrar se devuelve
 * el primero, que puede ser de otro swap.
 */
export declare function findRevealedPreimage(
  client: unknown,
  escrowOwner: string,
  expectedSecretHash?: Buffer | null
): Promise<Buffer | null>;

/** Cursor persistido de la pierna Soroban. */
export declare class RelayState {
  constructor(filePath?: string);
  path: string;
  data: { sorobanCursor: string | null; sorobanLedger: number | null };
  save(): void;
}

export declare class XrplWatcher {
  constructor(opts: { server?: string; escrowOwner: string; onReveal: (ev: { preimage: Buffer; tx: unknown }) => void });
  client: unknown;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export declare class SorobanWatcher {
  constructor(opts: {
    rpcUrl?: string;
    contractId: string;
    onReveal: (ev: { preimage: Buffer; swapId: Buffer | null; event: unknown }) => void | Promise<void>;
    pollMs?: number;
    state?: RelayState;
  });
  cursor: string | null;
  startLedger: number | null;
  /**
   * Cliente RPC de Soroban. Se expone a propósito: es la costura por la que
   * los tests lo sustituyen por un doble (ver relay-state.test.js), y estaba
   * en la implementación sin declararse aquí.
   */
  server: any;
  start(): Promise<void>;
  tick(): Promise<void>;
  poll(): Promise<void>;
  persist(): void;
  stop(): Promise<void>;
}

export declare class Relay {
  constructor(config: Record<string, unknown>);
  start(): Promise<void>;
  handleXrplReveal(preimage: Buffer, tx?: Record<string, unknown>): void;
  completeXrplLeg(preimage: Buffer): Promise<unknown>;
  stop(): Promise<void>;
}
