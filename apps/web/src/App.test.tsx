// Feature: demo-mode, Property 5: DemoBanner present on every page when isDemoMode=true
// Validates: Requirements 5.2, 5.5

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import App from "./App";

// Mock child components that make network calls or have complex deps
vi.mock("./components/DemoTerminal", () => ({
  default: () => <div data-testid="demo-terminal" />,
}));
vi.mock("./components/BazaarFeed", () => ({
  default: () => <div data-testid="bazaar-feed" />,
}));
vi.mock("./components/ReputationPanel", () => ({
  default: () => <div data-testid="reputation-panel" />,
}));
vi.mock("./components/FundWidget", () => ({
  default: () => <div data-testid="fund-widget" />,
}));
vi.mock("./components/ServiceCatalog", () => ({
  default: () => <div data-testid="service-catalog" />,
}));

// Mock useDemoStatus so we can control isDemoMode
vi.mock("./hooks/useDemoStatus", () => ({
  useDemoStatus: vi.fn(),
}));

import { useDemoStatus } from "./hooks/useDemoStatus";

const mockUseDemoStatus = useDemoStatus as ReturnType<typeof vi.fn>;

describe("App — DemoBanner property tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Property 5: DemoBanner is present whenever isDemoMode=true (100 runs)", () => {
    // Feature: demo-mode, Property 5: DemoBanner present on every page when isDemoMode=true
    fc.assert(
      fc.property(fc.boolean(), (isDemoMode) => {
        mockUseDemoStatus.mockReturnValue({ isDemoMode, loading: false });

        const { unmount } = render(<App />);

        const banner = screen.queryByRole("banner", {
          name: /demo mode indicator/i,
        });

        const result = isDemoMode ? banner !== null : banner === null;

        unmount();
        return result;
      }),
      { numRuns: 100 },
    );
  });

  it("DemoBanner is present when isDemoMode=true", () => {
    mockUseDemoStatus.mockReturnValue({ isDemoMode: true, loading: false });
    render(<App />);
    expect(
      screen.getByRole("banner", { name: /demo mode indicator/i }),
    ).toBeInTheDocument();
  });

  it("DemoBanner is absent when isDemoMode=false", () => {
    mockUseDemoStatus.mockReturnValue({ isDemoMode: false, loading: false });
    render(<App />);
    expect(
      screen.queryByRole("banner", { name: /demo mode indicator/i }),
    ).not.toBeInTheDocument();
  });
});
