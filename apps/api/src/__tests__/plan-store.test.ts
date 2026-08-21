/**
 * Persistencia y vencimiento del planStore.
 *
 * `POST /api/v1/swaps/plan` cobra $0.01 y guarda el plan; `POST
 * /api/v1/swaps/execute` lo busca por `plan_id`. Mientras el store fue un
 * `Map` en RAM, cualquier reinicio borraba planes ya pagados, y con dos
 * instancias detrás del balanceador el plan se creaba en un proceso y el
 * execute caía en el otro. En los dos casos el agente recibía un 404 por algo
 * de lo que tiene recibo.
 *
 * Lo que hay que sostener aquí:
 *   - un plan sobrevive al reinicio,
 *   - otro proceso lo ve,
 *   - "venció" y "nunca existió" no se contestan igual,
 *   - con `SWAP_STORE_DIR` vacío no se toca el disco.
 *
 * `STORE_DIR` se lee al importar el módulo, así que cada escenario reimporta
 * con `vi.resetModules()`. Eso es también lo que hace que crear una segunda
 * instancia sea un reinicio de verdad y no un truco.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { SwapPlan } from "../lib/swapStore.js";

let dir: string;
const ENV_ORIGINAL = process.env.SWAP_STORE_DIR;

const plan = (id: string): SwapPlan => ({
  id,
  sell_asset: "USDC",
  sell_amount: "10",
  buy_asset: "XRP",
  buy_amount: "20",
  exchange_rate: "2",
  counterparty_address: "GDEMOAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  initiator_ledgers: 240,
  counterparty_ledgers: 120,
  risk_level: "medium",
  estimated_time_seconds: 120,
  created_at: "2026-08-21T10:00:00.000Z",
});

/** Reimporta el módulo con otro STORE_DIR. Equivale a levantar el proceso. */
async function cargarStore(storeDir: string) {
  process.env.SWAP_STORE_DIR = storeDir;
  vi.resetModules();
  return await import("../lib/swapStore.js");
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const archivosDePlan = (d: string) =>
  fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("plan-") && f.endsWith(".json")) : [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "planstore-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.SWAP_STORE_DIR = ENV_ORIGINAL;
  vi.resetModules();
});

describe("planStore — persistencia y vencimiento", () => {
  it("un plan creado antes del reinicio se recupera después", async () => {
    const { PlanStore } = await cargarStore(dir);
    const p = plan("plan_reinicio");

    const antes = new PlanStore();
    antes.set("plan_reinicio", p);

    // Constructor nuevo = loadFromDisk() nuevo. Esto es el reinicio.
    const despues = new PlanStore();

    expect(despues.get("plan_reinicio")).toEqual(p);
  });

  it("un segundo proceso ve el plan que creó el primero", async () => {
    // El caso del balanceador: la instancia B ya estaba levantada cuando A
    // creó el plan, así que su memoria no lo ha visto nunca y el execute cae
    // en ella igual.
    const { PlanStore } = await cargarStore(dir);
    const p = plan("plan_compartido");

    const a = new PlanStore();
    const b = new PlanStore();

    a.set("plan_compartido", p);

    expect(b.get("plan_compartido")).toEqual(p);
  });

  it("un plan vencido no se devuelve, pero sigue distinguiéndose de uno que nunca existió", async () => {
    const { PlanStore } = await cargarStore(dir);
    const store = new PlanStore();

    store.set("plan_vencido", plan("plan_vencido"), 1);
    await esperar(5);

    expect(store.get("plan_vencido")).toBeUndefined();
    // Lo que separa un 410 de un 404: get() no borra el vencido, justo para
    // que esta pregunta se pueda contestar.
    expect(store.isExpired("plan_vencido")).toBe(true);
  });

  it("sigue distinguiéndose después de un reinicio", async () => {
    // loadFromDisk() no carga los vencidos, así que isExpired() tiene que ir
    // al archivo. Sin esto, un reinicio convierte todos los 410 en 404.
    const { PlanStore } = await cargarStore(dir);

    new PlanStore().set("plan_vencido_reinicio", plan("plan_vencido_reinicio"), 1);
    await esperar(5);

    const despues = new PlanStore();

    expect(despues.get("plan_vencido_reinicio")).toBeUndefined();
    expect(despues.isExpired("plan_vencido_reinicio")).toBe(true);
  });

  it("un plan_id desconocido no existe ni venció", async () => {
    const { PlanStore } = await cargarStore(dir);
    const store = new PlanStore();

    expect(store.get("plan_que_no_existe")).toBeUndefined();
    expect(store.isExpired("plan_que_no_existe")).toBe(false);
  });

  it("con SWAP_STORE_DIR vacío todo queda en memoria y no se escribe nada", async () => {
    const antes = archivosDePlan(dir).length;

    const { PlanStore } = await cargarStore("");
    const store = new PlanStore();
    const p = plan("plan_en_memoria");

    store.set("plan_en_memoria", p);

    expect(store.get("plan_en_memoria")).toEqual(p);
    expect(archivosDePlan(dir).length).toBe(antes);
    // Y tampoco el directorio por defecto del store.
    expect(fs.existsSync(path.join(process.cwd(), "swap-store", "plan-plan_en_memoria.json"))).toBe(false);
  });

  it("cleanup() borra del disco los planes vencidos", async () => {
    const { PlanStore } = await cargarStore(dir);
    const store = new PlanStore();

    store.set("plan_a_limpiar", plan("plan_a_limpiar"), 1);
    const archivo = path.join(dir, "plan-plan_a_limpiar.json");
    expect(fs.existsSync(archivo)).toBe(true);

    await esperar(5);
    store.cleanup();

    expect(fs.existsSync(archivo)).toBe(false);
    expect(store.get("plan_a_limpiar")).toBeUndefined();
    // Ya no queda rastro: ahora sí es indistinguible de uno que nunca existió.
    expect(store.isExpired("plan_a_limpiar")).toBe(false);
  });

  it("cleanup() no toca los planes vigentes", async () => {
    const { PlanStore } = await cargarStore(dir);
    const store = new PlanStore();
    const p = plan("plan_vigente");

    store.set("plan_vigente", p);
    store.cleanup();

    expect(store.get("plan_vigente")).toEqual(p);
    expect(fs.existsSync(path.join(dir, "plan-plan_vigente.json"))).toBe(true);
  });
});
