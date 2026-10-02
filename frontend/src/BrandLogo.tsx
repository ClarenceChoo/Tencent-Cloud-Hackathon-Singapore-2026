type BrandLogoProps = {
  className?: string;
  compact?: boolean;
};

export default function BrandLogo({ className = '', compact = false }: BrandLogoProps) {
  return <img
    className={`brand-logo ${compact ? 'brand-logo-compact' : ''} ${className}`.trim()}
    src={compact ? '/brand/parse-aurora-mark.png' : '/brand/parse-aurora-logo-light.png'}
    alt="Parse"
    width={compact ? 64 : 232}
    height={compact ? 64 : 80}
  />;
}
