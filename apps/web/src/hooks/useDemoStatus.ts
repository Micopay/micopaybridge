import { useState, useEffect } from "react";
import { API_URL } from "../config";

export interface DemoStatus {
  isDemoMode: boolean;
  loading: boolean;
}

export function useDemoStatus(): DemoStatus {
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Sin API configurada no hay a quién preguntar. Salir aquí evita una
    // petición a una URL inventada y deja `loading` en false, que es la
    // verdad: no está cargando, es que no hay nada que cargar.
    if (!API_URL) {
      setLoading(false);
      return;
    }

    fetch(`${API_URL}/api/v1/demo/status`)
      .then((res) => res.json())
      .then((data: unknown) => {
        if (cancelled) return;
        // Fail-safe: only set true when response explicitly has demo_mode === true
        if (
          data !== null &&
          typeof data === "object" &&
          "demo_mode" in data &&
          (data as Record<string, unknown>).demo_mode === true
        ) {
          setIsDemoMode(true);
        } else {
          setIsDemoMode(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsDemoMode(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { isDemoMode, loading };
}
