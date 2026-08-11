import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DemoBanner from "./DemoBanner";

describe("DemoBanner", () => {
  it("renders the review-session message when isDemoMode=true", () => {
    render(<DemoBanner isDemoMode={true} />);
    expect(
      screen.getByText(/Demo Mode.*App Store Review Session/i),
    ).toBeInTheDocument();
  });

  it("renders nothing when isDemoMode=false", () => {
    const { container } = render(<DemoBanner isDemoMode={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a fixed top banner with amber styling", () => {
    render(<DemoBanner isDemoMode={true} />);
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("fixed", "top-0", "left-0", "right-0");
    expect(banner).toHaveClass("bg-amber-400", "text-amber-900");
  });

  it("has a high z-index to appear above other content", () => {
    render(<DemoBanner isDemoMode={true} />);
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("z-50");
  });
});
