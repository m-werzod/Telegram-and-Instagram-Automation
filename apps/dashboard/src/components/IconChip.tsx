export type IconTone = 'blue' | 'violet' | 'green' | 'amber' | 'red' | 'pink' | 'cyan' | 'slate';

/** Covers both lucide-react icons and our hand-drawn brand-glyph components. */
export type IconComponent = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

/** A colored circular/rounded background behind an icon — the platform's consistent icon treatment. */
export default function IconChip({
  icon: Icon,
  tone = 'blue',
  size = 26,
  className = '',
}: {
  icon: IconComponent;
  tone?: IconTone;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`icon-chip ${tone} ${className}`}>
      <Icon size={Math.round(size * 0.56)} strokeWidth={2.25} />
    </span>
  );
}
