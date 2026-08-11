import { useState, useEffect } from "react";

const BASE_URL =
  (import.meta as any).env?.VITE_API_URL ?? "http://localhost:3000";

export interface DemoStatus {
  isDemoMode: boolean;
  loading: boolean;
}

export function useDemoStatus(): DemoStatus {
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch(`${BASE_URL}/api/v1/demo/status`)
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
