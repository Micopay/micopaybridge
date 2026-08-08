/**
 * La frontera del §M3, en un solo archivo.
 *
 * Este repo sirve reputación a agentes detrás de x402, pero la calcula con
 * datos de comercios que tras el split son del backend móvil. El plan da tres
 * salidas:
 *
 *   (a) leer el mismo esquema en solo lectura — barato, pero acopla los dos
 *       repos a una tabla y una migración del móvil rompe a los agentes sin
 *       avisar;
 *   (b) que el backend móvil exponga un endpoint interno y este repo lo
 *       consuma — contrato explícito y versionable. Es la recomendada;
 *   (c) que cada repo tenga su copia de los datos — deriva garantizada. Es el
 *       error que el commit 1811016 ya documentó. No se hace.
 *
 * Aquí está la (b) entera del lado cliente, y la (a) como respaldo mientras el
 * endpoint no exista. Lo que NO se puede hacer desde este repo es la mitad
 * servidora: vive en `micopay/backend`, que es producción y de otro equipo.
 *
 * Lo que sí se consigue: el acoplamiento deja de estar repartido por las rutas
 * y cabe en este archivo. El día que el endpoint exista, pasar de (a) a (b) es
 * poner una variable de entorno, no un refactor.
 *
 * El contrato que el backend móvil tiene que implementar está en
 * `docs/CONTRATO_REPUTACION.md`.
 */

import { query } from "../db/schema.js";

/** Lo que este repo necesita saber de un comercio. Nada más. */
export interface MerchantReputation {
  stellar_address: string;
  display_name: string;
  location: string | null;
  trades_completed: number;
  completion_rate: number;
  avg_time_minutes: number;
  total_volume_usdc: number;
  verified_at: string | null;
}

export interface ReputationSource {
  readonly kind: "http" | "direct-db";
  /** null si esa dirección no es un comercio verificado. */
  byAddress(stellarAddress: string): Promise<MerchantReputation | null>;
  listVerified(): Promise<MerchantReputation[]>;
}

/** pg devuelve los NUMERIC como string para no perder precisión. */
const num = (v: unknown): number => Number(v) || 0;

function toReputation(row: Record<string, unknown>): MerchantReputation {
  return {
    stellar_address: String(row.stellar_address ?? ""),
    display_name: String(row.display_name ?? ""),
    location: (row.address_text as string) ?? null,
    trades_completed: num(row.trades_completed),
    completion_rate: num(row.completion_rate),
    avg_time_minutes: num(row.avg_time_minutes),
    total_volume_usdc: num(row.total_volume_usdc),
    verified_at: (row.verified_at as string) ?? null,
  };
}

// COALESCE porque el esquema canónico guarda la dirección en los dos sitios:
// `merchants.stellar_address` (comercio dado de alta directamente) y
// `users.stellar_address` (comercio ligado a una cuenta de usuario). Mirar
// solo la de `users` devolvía vacío para todo lo que siembra el seed, que
// llena la de `merchants`.
const CAMPOS = `
  m.display_name, m.address_text, m.trades_completed, m.completion_rate,
  m.avg_time_minutes, COALESCE(m.volume_usdc, 0) AS total_volume_usdc,
  m.verified_at, COALESCE(m.stellar_address, u.stellar_address) AS stellar_address
`;

/**
 * Opción (a) — respaldo. Lee el mismo esquema que el backend móvil.
 *
 * Funciona, y es lo que hay hoy, pero deja este repo atado a la forma de la
 * tabla `merchants` de otro equipo. Una migración suya rompe esto en silencio
 * y el fallo aparece como un 500 en una ruta que cobra.
 */
class DirectDbSource implements ReputationSource {
  readonly kind = "direct-db" as const;

  async byAddress(stellarAddress: string): Promise<MerchantReputation | null> {
    // El filtro por dirección faltaba: la consulta ordenaba por verified_at y
    // devolvía el primero, así que cualquier dirección válida obtenía SIEMPRE
    // el mismo comercio. Un agente que pagaba por saber si fiarse del comercio
    // X recibía los números del comercio Y.
    const res = await query(
      `SELECT ${CAMPOS}
         FROM merchants m
         LEFT JOIN users u ON m.user_id = u.id
        WHERE (m.stellar_address = $1 OR u.stellar_address = $1)
          AND m.verification_status = 'verified'
        LIMIT 1`,
      [stellarAddress]
    );
    return res.rows[0] ? toReputation(res.rows[0]) : null;
  }

  async listVerified(): Promise<MerchantReputation[]> {
    const res = await query(
      `SELECT ${CAMPOS}
         FROM merchants m
         LEFT JOIN users u ON m.user_id = u.id
        WHERE m.verification_status = 'verified'
        ORDER BY m.completion_rate DESC, m.trades_completed DESC`
    );
    return res.rows.map(toReputation);
  }
}

/**
 * Opción (b) — la recomendada. Consume el endpoint interno del backend móvil.
 *
 * El contrato es explícito y versionado en la ruta (`/internal/v1/…`), así que
 * un cambio del móvil o mantiene la versión o publica una nueva; lo que no
 * puede es romper esto sin enterarse.
 */
class HttpSource implements ReputationSource {
  readonly kind = "http" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null as T;
    if (!res.ok) {
      throw new Error(`backend móvil respondió ${res.status} a ${path}`);
    }
    return (await res.json()) as T;
  }

  async byAddress(stellarAddress: string): Promise<MerchantReputation | null> {
    return this.get<MerchantReputation | null>(
      `/internal/v1/merchants/${encodeURIComponent(stellarAddress)}/reputation`
    );
  }

  async listVerified(): Promise<MerchantReputation[]> {
    const data = await this.get<{ merchants: MerchantReputation[] }>(
      "/internal/v1/merchants/reputation"
    );
    return data?.merchants ?? [];
  }
}

let cached: ReputationSource | null = null;

/**
 * Elige la fuente. Con `MICOPAY_BACKEND_URL` puesta usa el endpoint interno;
 * sin ella cae a leer la base directamente y lo dice en el log, porque un
 * acoplamiento silencioso es peor que uno ruidoso.
 */
export function getReputationSource(): ReputationSource {
  if (cached) return cached;

  const baseUrl = process.env.MICOPAY_BACKEND_URL;
  if (baseUrl) {
    cached = new HttpSource(
      baseUrl.replace(/\/$/, ""),
      process.env.MICOPAY_BACKEND_TOKEN,
      Number(process.env.MICOPAY_BACKEND_TIMEOUT_MS ?? 4000)
    );
    console.log(`[reputacion] fuente: endpoint interno del backend móvil (${baseUrl})`);
  } else {
    cached = new DirectDbSource();
    console.warn(
      "[reputacion] fuente: LECTURA DIRECTA de la tabla merchants (§M3 opción (a)). " +
      "Este repo queda atado al esquema del backend móvil: una migración suya rompe " +
      "esta ruta sin avisar. Configura MICOPAY_BACKEND_URL cuando el endpoint interno exista."
    );
  }
  return cached;
}

/** Solo para tests. */
export function __setReputationSource(source: ReputationSource | null): void {
  cached = source;
}
