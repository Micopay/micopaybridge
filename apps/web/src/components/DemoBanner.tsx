interface DemoBannerProps {
  isDemoMode: boolean;
}

const DemoBanner = ({ isDemoMode }: DemoBannerProps) => {
  if (!isDemoMode) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center py-1 bg-amber-400 text-amber-900"
      role="banner"
      aria-label="Demo mode indicator"
    >
      <span className="font-['Manrope'] font-semibold text-xs tracking-wide">
        🎭 Demo Mode — App Store Review Session
      </span>
    </div>
  );
};

export default DemoBanner;
