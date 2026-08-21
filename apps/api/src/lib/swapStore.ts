/**
 * Store de planes y estados de swap.
 * Compartido entre agent.ts (crear/ejecutar) y swaps.ts (polling de estado).
 */

import fs from "fs";
import path from "path";

export interface SwapPlan {
  id: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  exchange_rate: string;
  counterparty_address: string;
  initiator_ledgers: number;
  counterparty_ledgers: number;
  risk_level: string;
  estimated_time_seconds: number;
  created_at: string;
}

export type SwapStatus =
  | "queued"
  | "locking_a"
  | "locked_a"
  | "locking_b"
  | "locked_b"
  | "releasing_b"
  | "released_b"
  | "releasing_a"
  | "completed"
  | "failed"
  /** Falló con fondos ya bloqueados: hay que reembolsar las dos piernas. */
  | "refund_pending"
  | "refunded";

/**
 * Datos de la pierna XRPL. `owner` + `offer_sequence` es lo que identifica un
 * escrow en XRPL: sin los dos no se puede ni completar ni cancelar, así que
 * se guardan en cuanto existen — si el proceso muere entre el lock y la
 * revelación, es lo único que permite recuperar o reembolsar la pierna.
 */
export interface XrplLegState {
  owner: string;
  offer_sequence: number;
  destination: string;
  condition: string;
  /** CancelAfter en época Ripple (segundos desde 2000-01-01, no Unix). */
  cancel_after: number;
}

export interface SwapState {
  swap_id: string;
  plan_id: string;
  status: SwapStatus;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  secret_hash?: string;
  /** Cadena de la pierna B. Antes de M4.5 era otra instancia de Soroban. */
  chain_b: "xrpl";
  xrpl?: XrplLegState;
  txs: {
    /** Soroban */
    lock_a?: string;
    release_a?: string;
    refund_a?: string;
    /** XRPL */
    lock_b?: string;
    release_b?: string;
    refund_b?: string;
  };
  error?: string;
  created_at: string;
  updated_at: string;
}

/** En qué cadena vive cada tx del store. Los exploradores no son el mismo. */
export const TX_CHAIN: Record<keyof SwapState["txs"], "stellar" | "xrpl"> = {
  lock_a: "stellar",
  release_a: "stellar",
  refund_a: "stellar",
  lock_b: "xrpl",
  release_b: "xrpl",
  refund_b: "xrpl",
};

/* El planStore vive al final del archivo: necesita STORE_DIR, que se
 * define más abajo junto al store de swaps con el que comparte disco. */

/**
 * Estado de los swaps, persistido en disco. **Un archivo por swap.**
 *
 * Antes era un `Map` en RAM, lo que convertía en mentira el comentario que
 * dice que los datos del escrow XRPL se guardan "antes de revelar, por si el
 * proceso muere". Después fue un único JSON con todos los swaps, y eso traía
 * un problema peor y más silencioso: dos procesos —dos instancias detrás del
 * balanceador, o un script `test:live` corriendo con la API levantada— cargan
 * el archivo, cada uno escribe su swap y el segundo en escribir borra el del
 * primero. Verificado: dos procesos, dos swaps, uno perdido. Y un swap
 * perdido son fondos bloqueados que ya nadie sabe que existen.
 *
 * Con un archivo por swap, dos procesos que tocan swaps distintos no se ven
 * siquiera. Para el mismo swap se aplica una **fusión monótona**: este estado
 * solo crece —las transacciones se añaden, nunca se quitan, y el status
 * avanza— así que dos escrituras concurrentes convergen en vez de pisarse.
 *
 * Sigue sin ser una base de datos y no pretende serlo. Es el mínimo para que
 * ni un reinicio ni una segunda instancia pierdan de vista dinero bloqueado.
 * `SWAP_STORE_DIR` vacío lo desactiva (los tests corren así).
 */
const STORE_DIR = process.env.SWAP_STORE_DIR ?? "./swap-store";

/** El status solo avanza. Al fusionar gana el más avanzado. */
const ORDEN_STATUS: SwapStatus[] = [
  "queued", "locking_a", "locked_a", "locking_b", "locked_b",
  "releasing_b", "released_b", "releasing_a",
  "failed", "refund_pending", "refunded", "completed",
];
const rango = (s: SwapStatus): number => {
  const i = ORDEN_STATUS.indexOf(s);
  return i === -1 ? 0 : i;
};

/** Nombre de archivo seguro: los swap_id los generamos nosotros, pero no se confía. */
const archivoDe = (id: string): string =>
  path.join(STORE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

/**
 * Fusiona dos versiones del mismo swap sin perder nada.
 *
 * Las txs se unen: que una escritura no conozca `refund_b` no significa que no
 * haya ocurrido, significa que ese proceso no lo vio. Borrarlo perdería la
 * prueba de que unos fondos ya volvieron.
 */
export function fusionar(previo: SwapState | null, nuevo: SwapState): SwapState {
  if (!previo) return nuevo;
  const masAvanzado = rango(nuevo.status) >= rango(previo.status) ? nuevo : previo;
  return {
    ...previo,
    ...nuevo,
    status: masAvanzado.status,
    error: nuevo.error ?? previo.error,
    secret_hash: nuevo.secret_hash ?? previo.secret_hash,
    xrpl: nuevo.xrpl ?? previo.xrpl,
    txs: { ...previo.txs, ...limpiar(nuevo.txs) },
    created_at: previo.created_at,
    updated_at: nuevo.updated_at > previo.updated_at ? nuevo.updated_at : previo.updated_at,
  };
}

/** Quita los undefined para que no borren un valor previo al hacer spread. */
function limpiar(txs: SwapState["txs"]): SwapState["txs"] {
  return Object.fromEntries(Object.entries(txs).filter(([, v]) => v !== undefined));
}

class PersistentSwapStore extends Map<string, SwapState> {
  constructor() {
    super();
    this.reload();
  }

  /**
   * Relee el directorio. Necesario en multiproceso: la copia en memoria de
   * esta instancia no ve lo que escribió otra. Se llama al arrancar y antes
   * de decidir qué swaps hay que rescatar.
   */
  reload(): void {
    if (!STORE_DIR) return;
    try {
      if (!fs.existsSync(STORE_DIR)) return;
      for (const nombre of fs.readdirSync(STORE_DIR)) {
        if (!nombre.endsWith(".json")) continue;
        try {
          const state = JSON.parse(fs.readFileSync(path.join(STORE_DIR, nombre), "utf8")) as SwapState;
          if (state?.swap_id) super.set(state.swap_id, fusionar(super.get(state.swap_id) ?? null, state));
        } catch (err) {
          console.warn(`[swapStore] ${nombre} ilegible, se ignora: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`[swapStore] no se pudo leer ${STORE_DIR}: ${String(err)}`);
    }
  }

  override set(key: string, value: SwapState): this {
    const fusionado = this.flush(key, value);
    super.set(key, fusionado);
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had && STORE_DIR) {
      try { fs.rmSync(archivoDe(key), { force: true }); } catch { /* ya no está */ }
    }
    return had;
  }

  /** Lee lo que haya en disco, fusiona y escribe atómicamente. */
  private flush(key: string, value: SwapState): SwapState {
    if (!STORE_DIR) return value;
    const archivo = archivoDe(key);
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      let enDisco: SwapState | null = null;
      try {
        enDisco = JSON.parse(fs.readFileSync(archivo, "utf8")) as SwapState;
      } catch { /* primera escritura */ }

      const fusionado = fusionar(enDisco, value);
      // tmp único por proceso: dos procesos escribiendo el mismo swap no
      // pueden pisarse el temporal a mitad de escritura.
      const tmp = `${archivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(fusionado, null, 2));
      fs.renameSync(tmp, archivo);
      return fusionado;
    } catch (err) {
      // Que no se pueda escribir NO debe tumbar un swap en curso, pero tiene
      // que verse: sin esto volvemos al caso de fondos perdidos.
      console.error(`[swapStore] NO SE PUDO PERSISTIR ${key} — un reinicio lo perderá: ${String(err)}`);
      return value;
    }
  }
}

const store = new PersistentSwapStore();
export const swapStore: Map<string, SwapState> = store;

/** Relee el disco. En multiproceso, antes de decidir qué hay que rescatar. */
export function reloadSwapStore(): void {
  store.reload();
}

/** Swaps que se quedaron a medias: tienen fondos bloqueados sin resolver. */
export function pendingRefunds(): SwapState[] {
  // Relee primero: los fondos colgados de OTRA instancia también hay que
  // devolverlos, y no están en la memoria de esta.
  store.reload();
  return [...store.values()].filter(
    (s) => (s.status === "failed" || s.status === "refund_pending") && !!s.txs.lock_a && !s.txs.release_a && !s.txs.refund_a
  );
}

/**
 * TTL por defecto de un plan: 30 minutos.
 *
 * El plan se paga ($0.01), así que el margen es generoso a propósito: expira
 * para que el directorio no crezca sin fin, no para apurar a quien ya pagó.
 */
export const DEFAULT_PLAN_TTL_MS = 30 * 60 * 1000;

/** Un plan más su vencimiento. Es lo que se guarda en disco. */
interface PlanRecord {
  plan: SwapPlan;
  expiresAt: number;
}

/**
 * Los planes comparten `STORE_DIR` con los swaps, así que llevan prefijo
 * propio: `reload()` del swapStore recorre todos los `.json` del directorio y
 * los planes no son swaps. Se ignoran entre ellos por el prefijo, no por
 * suerte.
 */
const archivoDePlan = (id: string): string =>
  path.join(STORE_DIR, `plan-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

const esArchivoDePlan = (nombre: string): boolean =>
  nombre.startsWith("plan-") && nombre.endsWith(".json");

/** Un PlanRecord leído de disco solo sirve si trae las dos cosas. */
const recordValido = (r: unknown): r is PlanRecord =>
  !!r && typeof (r as PlanRecord).expiresAt === "number" && !!(r as PlanRecord).plan?.id;

/**
 * Planes de swap, persistidos en disco. **Un archivo por plan.**
 *
 * Era un `Map` en RAM. `POST /api/v1/swaps/plan` cobra $0.01 y guardaba el
 * plan aquí; `POST /api/v1/swaps/execute` lo buscaba por `plan_id`. Cualquier
 * reinicio, deploy o caída borraba todos los planes ya pagados — y con dos
 * instancias detrás del balanceador ni siquiera hacía falta reiniciar: el plan
 * se creaba en un proceso y el execute caía en el otro. El agente pagó, tiene
 * el `plan_id`, y recibía un 404 por algo de lo que tiene recibo.
 *
 * Mismo mecanismo que el swapStore de arriba: un archivo por registro bajo
 * `STORE_DIR`, escritura atómica (tmp + rename) y lectura al arrancar. No hace
 * falta fusionar como allí — un plan se escribe una vez y no cambia.
 *
 * `SWAP_STORE_DIR` vacío lo desactiva y todo queda en memoria (los tests
 * corren así).
 */
export class PlanStore {
  private mem = new Map<string, PlanRecord>();

  constructor() {
    this.loadFromDisk();
  }

  /** Carga los planes vigentes del directorio. Los vencidos no se cargan. */
  private loadFromDisk(): void {
    if (!STORE_DIR) return;
    try {
      if (!fs.existsSync(STORE_DIR)) return;
      const ahora = Date.now();
      for (const nombre of fs.readdirSync(STORE_DIR)) {
        if (!esArchivoDePlan(nombre)) continue;
        try {
          const record: unknown = JSON.parse(fs.readFileSync(path.join(STORE_DIR, nombre), "utf8"));
          if (!recordValido(record)) continue;
          // Un vencido no entra en memoria, pero su archivo sigue ahí: es lo
          // que permite a isExpired() contestar 410 después de un reinicio.
          // De borrarlo se encarga cleanup().
          if (record.expiresAt < ahora) continue;
          // La clave es el id del propio plan: el nombre del archivo va
          // saneado y no se puede deshacer.
          this.mem.set(record.plan.id, record);
        } catch (err) {
          console.warn(`[planStore] ${nombre} ilegible, se ignora: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`[planStore] no se pudo leer ${STORE_DIR}: ${String(err)}`);
    }
  }

  /**
   * Lee un plan concreto del disco, vencido o no.
   *
   * Es lo que hace que `isExpired()` siga sabiendo la diferencia entre
   * "venció" y "nunca existió" cuando el proceso se reinició y el plan no
   * está en memoria.
   */
  private loadPlanFromDisk(planId: string): PlanRecord | null {
    if (!STORE_DIR) return null;
    try {
      const record: unknown = JSON.parse(fs.readFileSync(archivoDePlan(planId), "utf8"));
      return recordValido(record) ? record : null;
    } catch {
      return null; // no existe o no se puede leer
    }
  }

  set(planId: string, plan: SwapPlan, ttlMs = DEFAULT_PLAN_TTL_MS): void {
    const record: PlanRecord = { plan, expiresAt: Date.now() + ttlMs };
    this.mem.set(planId, record);
    if (!STORE_DIR) return;
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const archivo = archivoDePlan(planId);
      // tmp único por proceso, igual que el swapStore: dos procesos no pueden
      // pisarse el temporal a mitad de escritura.
      const tmp = `${archivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
      fs.renameSync(tmp, archivo);
    } catch (err) {
      // Que no se pueda escribir NO debe tumbar el plan que el agente acaba
      // de pagar, pero tiene que verse.
      console.error(`[planStore] NO SE PUDO PERSISTIR ${planId} — un reinicio lo perderá: ${String(err)}`);
    }
  }

  /**
   * El plan vigente, o undefined si venció o nunca existió.
   *
   * Si no está en memoria se busca en disco: es el caso de las dos instancias
   * detrás del balanceador, donde el plan lo creó el otro proceso y esta
   * memoria no lo ha visto nunca.
   *
   * **Un plan vencido no se borra aquí.** Si `get()` lo borrara, el `/execute`
   * que viene justo después ya no podría distinguir "venció" de "nunca
   * existió" y contestaría 404 donde debe contestar 410 — que es justo la
   * confusión que hay que arreglar. De los vencidos se encarga `cleanup()`.
   */
  get(planId: string): SwapPlan | undefined {
    const record = this.mem.get(planId) ?? this.loadPlanFromDisk(planId);
    if (!record) return undefined;
    if (Date.now() > record.expiresAt) return undefined;
    this.mem.set(planId, record); // venía de disco: cachear
    return record.plan;
  }

  /**
   * true solo si el plan **existe y venció**. Un `plan_id` que nunca existió
   * devuelve false, y esa es toda la diferencia entre un 410 y un 404.
   */
  isExpired(planId: string): boolean {
    const record = this.mem.get(planId) ?? this.loadPlanFromDisk(planId);
    if (!record) return false;
    return Date.now() > record.expiresAt;
  }

  delete(planId: string): void {
    this.mem.delete(planId);
    if (!STORE_DIR) return;
    try {
      fs.rmSync(archivoDePlan(planId), { force: true });
    } catch {
      /* ya no está */
    }
  }

  /** Borra los planes vencidos, de memoria y de disco. Se llama al arrancar. */
  cleanup(): void {
    const ahora = Date.now();
    for (const [planId, record] of [...this.mem]) {
      if (record.expiresAt < ahora) this.delete(planId);
    }
    if (!STORE_DIR) return;
    try {
      if (!fs.existsSync(STORE_DIR)) return;
      for (const nombre of fs.readdirSync(STORE_DIR)) {
        if (!esArchivoDePlan(nombre)) continue;
        const archivo = path.join(STORE_DIR, nombre);
        try {
          const record: unknown = JSON.parse(fs.readFileSync(archivo, "utf8"));
          // Un archivo ilegible se deja: borrar datos que no se entienden es
          // peor que dejar un archivo de más.
          if (!recordValido(record) || record.expiresAt >= ahora) continue;
          fs.rmSync(archivo, { force: true });
          this.mem.delete(record.plan.id);
        } catch (err) {
          console.warn(`[planStore] ${nombre} ilegible, no se limpia: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`[planStore] no se pudo limpiar ${STORE_DIR}: ${String(err)}`);
    }
  }
}

export const planStore = new PlanStore();
