/** The Avtomaktab Turon badge — the official artwork, used unmodified. */
export default function BrandLogo({
  size = 34,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/logo.png"
      width={size}
      height={size}
      alt="Avtomaktab Turon"
      className={`brand-mark ${className}`.trim()}
      draggable={false}
    />
  );
}
