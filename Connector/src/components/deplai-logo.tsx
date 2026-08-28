type DeplaiLogoProps = {
  size?: number;
  showWordmark?: boolean;
  className?: string;
  wordmarkClassName?: string;
  priority?: boolean;
};

export function DeplaiLogo({
  size = 28,
  showWordmark = true,
  className = '',
  wordmarkClassName = '',
  priority = false,
}: DeplaiLogoProps) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`.trim()}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/deplai-logo.png"
        alt={showWordmark ? '' : 'DeplAI'}
        height={size}
        width={Math.round(size * 0.96)}
        className="shrink-0 object-contain"
        style={{ height: size, width: 'auto' }}
        decoding="async"
        fetchPriority={priority ? 'high' : 'auto'}
      />
      {showWordmark ? (
        <span className={wordmarkClassName || 'font-display font-semibold tracking-tight'}>
          DeplAI
        </span>
      ) : null}
    </span>
  );
}
