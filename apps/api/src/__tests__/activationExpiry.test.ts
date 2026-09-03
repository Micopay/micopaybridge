/**
 * La regresión que este test fija: el payload de Xaman vivía 24 h por
 * defecto mientras `CancelAfter` se anclaba al momento de crearlo. Con el
 * plazo por defecto de 1 h quedaban 23 h en las que el QR seguía siendo
 * firmable pero la transacción ya nacía vencida — rippled la rechaza, el
 * usuario quema la fee, no queda escrow, y su dirección no cuenta para las
 * 300 de Make Waves. Y como sí firmó, cree que funcionó.
 *
 * La invariante, en una frase: el payload nunca puede seguir vivo después
 * de su propio CancelAfter.
 */
import { describe, it, expect } from "vitest";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { minutosDeFirma } from "../lib/xumm.js";

const AHORA = 1_800_000_000;
const enRipple = (segundosDesdeAhora: number) => bt.toRippleTime(AHORA + segundosDesdeAhora);

describe("ventana de firma del payload de activación", () => {
  it("nunca deja el payload vivo más allá del CancelAfter", () => {
    // 600 es el mínimo que acepta la ruta; 86400 el máximo.
    for (const plazo of [600, 3600, 7200, 86400]) {
      const minutos = minutosDeFirma(enRipple(plazo), AHORA);
      expect(minutos * 60, `plazo de ${plazo}s`).toBeLessThan(plazo);
    }
  });

  it("con el plazo por defecto de 1 h da 55 min de firma, no 24 h", () => {
    expect(minutosDeFirma(enRipple(3600), AHORA)).toBe(55);
  });

  it("deja margen para que la firma alcance a entrar en un ledger validado", () => {
    // 3600 - 300 de margen = 3300 s = 55 min exactos.
    expect(minutosDeFirma(enRipple(3600), AHORA) * 60).toBeLessThanOrEqual(3600 - 300);
  });

  it("señala con <= 0 los plazos que no dejan ventana, en vez de redondear a 1", () => {
    // Redondear hacia arriba aquí es justo lo que rompía la invariante en el
    // plazo mínimo: el payload acababa vivo exactamente hasta el CancelAfter.
    for (const plazo of [0, 60, 300, -600]) {
      expect(minutosDeFirma(enRipple(plazo), AHORA), `plazo de ${plazo}s`).toBeLessThanOrEqual(0);
    }
  });
});
